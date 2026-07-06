import { useState, useRef, useEffect, useCallback, createContext, useContext } from 'react'
import { T, ST, DOC_TYPES, DOC_ICONS, STATUS_FLOW, DEFAULT_STAGE_NAMES, isExpiringSoon, isExpired } from '../constants.js'
import * as pdfjsLib from 'pdfjs-dist'
// Imported as a Vite worker (not `?url`) so the build emits a plain .js chunk —
// Zoho Catalyst Slate serves .mjs assets as application/octet-stream with
// nosniff, which makes Chrome refuse to execute it as a module worker.
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'

pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker()

// ── Convert a base64 data URL to an object URL ──
// Desktop Chrome blocks navigation to top-level data: URLs (phishing mitigation)
// and silently refuses to render large base64 data URLs in iframes. Blob URLs work.
// Returns { url, mimeType, revoke } — caller is responsible for revoke() when done.
// Allowlist of mime types the document viewer is permitted to render.
// Anything outside this set is refused, even if the server stored it.
const VIEWER_ALLOWED_MIME = new Set([
  'application/pdf', 'image/jpeg', 'image/jpg', 'image/png',
])

// Shared parsing: data URL -> raw bytes + mimeType. Used both for the Blob/object-URL
// path (images, downloads) and for feeding raw bytes directly to pdf.js.
function dataUrlToBytes(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl)
  if (!match) return null
  const mimeType = (match[1] || '').toLowerCase()
  // Reject anything that isn't an allowed mime — defense in depth against
  // a malicious data:text/html or data:image/svg+xml payload that would
  // otherwise execute JS inside the viewer.
  if (!VIEWER_ALLOWED_MIME.has(mimeType)) return null
  const isBase64 = !!match[2]
  const payload = match[3]
  try {
    let bytes
    if (isBase64) {
      const bin = atob(payload)
      bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(payload))
    }
    return { bytes, mimeType }
  } catch {
    return null
  }
}

export function dataUrlToBlobUrl(dataUrl) {
  const parsed = dataUrlToBytes(dataUrl)
  if (!parsed) return null
  const blob = new Blob([parsed.bytes], { type: parsed.mimeType })
  const url = URL.createObjectURL(blob)
  return { url, mimeType: parsed.mimeType, bytes: parsed.bytes, revoke: () => URL.revokeObjectURL(url) }
}

// Renders PDF bytes onto a <canvas> client-side via pdf.js — no iframe/sandbox
// involved, so it sidesteps Chrome's native PDF viewer refusing to load inside a
// sandboxed iframe (and the resulting blocked fallback-download behavior).
function PdfPageViewer({ bytes, onReady }) {
  const canvasRef = useRef(null)
  const [pdf, setPdf] = useState(null)
  const [pageNum, setPageNum] = useState(1)
  const [numPages, setNumPages] = useState(0)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    // pdf.js's worker transfers (zero-copies) this buffer, detaching it — pass a
    // fresh copy so a React StrictMode dev-mode remount doesn't reuse a detached one.
    pdfjsLib.getDocument({ data: bytes.slice() }).promise
      .then(doc => { if (!cancelled) { setPdf(doc); setNumPages(doc.numPages) } })
      .catch(err => { if (!cancelled) { setError(err?.message || 'Failed to load PDF'); onReady?.() } })
    return () => { cancelled = true }
  }, [bytes])

  useEffect(() => {
    if (!pdf) return
    let cancelled = false
    pdf.getPage(pageNum).then(page => {
      if (cancelled) return
      const canvas = canvasRef.current
      if (!canvas) return
      const viewport = page.getViewport({ scale: 1.4 })
      canvas.width = viewport.width
      canvas.height = viewport.height
      const ctx = canvas.getContext('2d')
      page.render({ canvasContext: ctx, viewport }).promise.then(() => { if (!cancelled) onReady?.() })
    })
    return () => { cancelled = true }
  }, [pdf, pageNum])

  if (error) return <div style={{ color: '#fca5a5', padding: 24, fontSize: 13 }}>⚠ {error}</div>

  return (
    <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: 16, gap: 12 }}>
      <canvas ref={canvasRef} style={{ boxShadow: '0 4px 24px rgba(0,0,0,0.4)', maxWidth: '100%' }} />
      {numPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#1e293b', padding: '6px 14px', borderRadius: 8, flexShrink: 0 }}>
          <button onClick={() => setPageNum(p => Math.max(1, p - 1))} disabled={pageNum <= 1}
            style={{ background: 'none', border: 'none', color: '#e2e8f0', cursor: pageNum <= 1 ? 'not-allowed' : 'pointer', opacity: pageNum <= 1 ? 0.4 : 1, fontSize: 13, fontFamily: 'inherit' }}>‹ Prev</button>
          <span style={{ color: '#94a3b8', fontSize: 12 }}>Page {pageNum} of {numPages}</span>
          <button onClick={() => setPageNum(p => Math.min(numPages, p + 1))} disabled={pageNum >= numPages}
            style={{ background: 'none', border: 'none', color: '#e2e8f0', cursor: pageNum >= numPages ? 'not-allowed' : 'pointer', opacity: pageNum >= numPages ? 0.4 : 1, fontSize: 13, fontFamily: 'inherit' }}>Next ›</button>
        </div>
      )}
    </div>
  )
}

// ── Toast system ─────────────────────────────────────────────────────────────
const ToastCtx = createContext(null)

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const toast = useCallback((msg, type = 'success', duration = 3500) => {
    const id = Date.now() + Math.random()
    setToasts(p => [...p, { id, msg, type }])
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), duration)
  }, [])
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <ToastStack toasts={toasts} onDismiss={id => setToasts(p => p.filter(t => t.id !== id))} />
    </ToastCtx.Provider>
  )
}

export function useToast() {
  return useContext(ToastCtx) || (() => {})
}

function ToastStack({ toasts, onDismiss }) {
  if (!toasts.length) return null
  const styles = {
    success: { bg: '#f0fdf4', border: '#86efac', text: '#15803d', icon: '✓' },
    error:   { bg: '#fef2f2', border: '#fca5a5', text: '#b91c1c', icon: '✕' },
    info:    { bg: '#eff6ff', border: '#93c5fd', text: '#1d4ed8', icon: 'ℹ' },
    warning: { bg: '#fffbeb', border: '#fde68a', text: '#92400e', icon: '⚠' },
  }
  return (
    <div className="toast-stack">
      {toasts.map(t => {
        const s = styles[t.type] || styles.info
        return (
          <div key={t.id}
            style={{ background: s.bg, border: `1px solid ${s.border}`, borderRadius: 10, padding: '10px 14px', display: 'flex', alignItems: 'flex-start', gap: 9, boxShadow: '0 4px 16px rgba(0,0,0,0.10)', pointerEvents: 'all', animation: 'toast-in 0.18s ease' }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: s.text, flexShrink: 0, marginTop: 1 }}>{s.icon}</span>
            <span style={{ fontSize: 13, fontWeight: 500, color: s.text, flex: 1, lineHeight: 1.45 }}>{t.msg}</span>
            <button onClick={() => onDismiss(t.id)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 15, color: s.text, opacity: 0.45, padding: 0, lineHeight: 1, fontFamily: 'inherit', flexShrink: 0 }}>×</button>
          </div>
        )
      })}
    </div>
  )
}

export function Badge({ status }) {
  const s = ST[status] || { bg: '#f1f5f9', c: '#475569' }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: s.bg, color: s.c, whiteSpace: 'nowrap', letterSpacing: '0.02em' }}>
      {status}
    </span>
  )
}

export function RoleBadge({ role, adminType }) {
  const map = {
    buyer: { label: 'Buyer', bg: '#dbeafe', c: '#1d4ed8' },
    manufacturer: { label: 'Manufacturer', bg: '#fef9c3', c: '#92400e' },
    admin: { label: adminType === 'master' ? 'Master Admin' : 'Admin User', bg: adminType === 'master' ? '#ede9fe' : '#f1f5f9', c: adminType === 'master' ? '#7c3aed' : '#475569' },
  }
  const s = map[role] || { label: role, bg: '#f1f5f9', c: '#475569' }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: s.bg, color: s.c, whiteSpace: 'nowrap' }}>
      {role === 'admin' && adminType === 'master' && '👑 '}{s.label}
    </span>
  )
}

export function Btn({ children, onClick, variant = 'primary', size = 'md', disabled, type = 'button', block, icon }) {
  const v = {
    primary: { bg: T.primary, hover: T.primaryDark, color: '#fff', border: 'none' },
    secondary: { bg: '#f8fafc', hover: '#f1f5f9', color: T.text, border: `1px solid ${T.border}` },
    danger: { bg: T.dangerBg, hover: '#fecaca', color: T.danger, border: `1px solid ${T.dangerBorder}` },
    success: { bg: T.successBg, hover: '#bbf7d0', color: T.success, border: `1px solid ${T.successBorder}` },
    warning: { bg: T.warningBg, hover: '#fde68a', color: T.warning, border: `1px solid ${T.warningBorder}` },
    ghost: { bg: 'transparent', hover: T.primaryLight, color: T.primary, border: 'none' },
    outline: { bg: 'transparent', hover: T.primaryLight, color: T.primary, border: `1px solid ${T.primary}` },
    master: { bg: T.masterBg, hover: '#ddd6fe', color: T.master, border: '1px solid #c4b5fd' },
  }[variant] || {}
  const sz = { sm: { p: '4px 10px', fs: 11 }, md: { p: '7px 14px', fs: 13 }, lg: { p: '10px 20px', fs: 14 } }[size] || {}
  const [hov, setHov] = useState(false)
  return (
    <button type={type} disabled={disabled} onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ background: hov && !disabled ? v.hover : v.bg, color: v.color, border: v.border, padding: sz.p, borderRadius: 8, fontSize: sz.fs, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, whiteSpace: 'nowrap', width: block ? '100%' : undefined, transition: 'background 0.12s', fontFamily: 'inherit' }}>
      {icon && <span style={{ fontSize: (sz.fs || 13) + 1 }}>{icon}</span>}{children}
    </button>
  )
}

export function Input({ label, error, hint, style: s, inputStyle, ...p }) {
  return (
    <div style={s}>
      {label && <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>{label}</label>}
      <input {...p} style={{ width: '100%', border: `1px solid ${error ? T.danger : T.border}`, borderRadius: 8, padding: '8px 12px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit', ...inputStyle }} />
      {error && <div style={{ fontSize: 11, color: T.danger, marginTop: 3 }}>⚠ {error}</div>}
      {hint && !error && <div style={{ fontSize: 11, color: T.textLight, marginTop: 3 }}>{hint}</div>}
    </div>
  )
}

export function Select({ label, children, style: s, ...p }) {
  return (
    <div style={s}>
      {label && <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>{label}</label>}
      <select {...p} style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 12px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit', cursor: 'pointer' }}>{children}</select>
    </div>
  )
}

export function Textarea({ label, hint, ...p }) {
  return (
    <div>
      {label && <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>{label}</label>}
      <textarea {...p} style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 12px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit', resize: 'vertical', minHeight: 72 }} />
      {hint && <div style={{ fontSize: 11, color: T.textLight, marginTop: 3 }}>{hint}</div>}
    </div>
  )
}

export function Card({ children, style: s, pad = true, onClick }) {
  const [hov, setHov] = useState(false)
  return (
    <div onClick={onClick}
      onMouseEnter={() => onClick && setHov(true)} onMouseLeave={() => onClick && setHov(false)}
      style={{ background: T.surface, borderRadius: 12, border: `1px solid ${hov ? T.borderHover : T.border}`, overflow: 'hidden', boxShadow: hov ? '0 4px 16px rgba(0,0,0,0.08)' : 'none', transition: 'box-shadow 0.15s, border-color 0.15s', cursor: onClick ? 'pointer' : undefined, ...s, padding: pad ? (s?.padding || '20px') : 0 }}>
      {children}
    </div>
  )
}

export function Modal({ title, subtitle, onClose, children, size = 'md' }) {
  useEffect(() => {
    const h = e => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])
  const w = { sm: 420, md: 500, lg: 680, xl: 820 }[size] || 500
  return (
    <div className="modal-backdrop" style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, backdropFilter: 'blur(2px)' }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-inner" style={{ background: T.surface, border: `1px solid ${T.border}`, width: '100%', maxWidth: w, maxHeight: '92vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,0.18)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '20px 24px 16px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>{title}</div>
            {subtitle && <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>{subtitle}</div>}
          </div>
          <button onClick={onClose} style={{ background: '#f1f5f9', border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: T.textMuted, flexShrink: 0, marginTop: 1 }}>×</button>
        </div>
        <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1 }}>{children}</div>
      </div>
    </div>
  )
}

export function Tabs({ tabs, active, onChange }) {
  return (
    <div style={{ display: 'flex', borderBottom: `1px solid ${T.border}`, gap: 0, flexShrink: 0, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => onChange(t.id)}
          style={{ padding: '10px 18px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: active === t.id ? T.primary : T.textMuted, borderBottom: `2px solid ${active === t.id ? T.primary : 'transparent'}`, transition: 'all 0.15s', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function StatCard({ label, value, icon, bg, trend }) {
  return (
    <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, padding: '18px 20px', display: 'flex', alignItems: 'center', gap: 14 }}>
      <div style={{ width: 46, height: 46, borderRadius: 12, background: bg || T.primaryLight, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0 }}>{icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 26, fontWeight: 800, color: T.text, lineHeight: 1.1 }}>{value}</div>
        <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{label}</div>
      </div>
      {trend != null && <div style={{ fontSize: 12, fontWeight: 700, color: trend >= 0 ? T.success : T.danger }}>{trend >= 0 ? '+' : ''}{trend}%</div>}
    </div>
  )
}

export function Alert({ type, children }) {
  const s = {
    info: { bg: T.infoBg, border: T.infoBorder, c: T.info, icon: 'ℹ' },
    success: { bg: T.successBg, border: T.successBorder, c: T.success, icon: '✓' },
    warning: { bg: T.warningBg, border: T.warningBorder, c: T.warning, icon: '⚠' },
    danger: { bg: T.dangerBg, border: T.dangerBorder, c: T.danger, icon: '⚠' },
  }[type] || { bg: T.infoBg, border: T.infoBorder, c: T.info, icon: 'ℹ' }
  return (
    <div style={{ background: s.bg, border: `1px solid ${s.border}`, borderRadius: 10, padding: '10px 14px', fontSize: 13, color: s.c, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
      <span style={{ flexShrink: 0, fontWeight: 700 }}>{s.icon}</span><div style={{ flex: 1 }}>{children}</div>
    </div>
  )
}

// Build the file-related fields for an uploadDoc() payload from a FileUpload selection.
// Returns either { dataUrl, fileName, fileSize, mimeType } (inline file)
// or { externalUrl } (drive link). Callers spread this into their uploadDoc args.
export function fileUploadPayload(fileData) {
  if (!fileData) return {}
  if (fileData.externalUrl) return { externalUrl: fileData.externalUrl }
  return {
    dataUrl:  fileData.dataUrl,
    fileName: fileData.name,
    fileSize: fileData.size,
    mimeType: fileData.mimeType,
  }
}

// FileUpload supports two modes:
//   1. Inline file (≤10MB) — emits { name, size, mimeType, dataUrl }
//   2. External link (e.g. Zoho/GDrive share URL for files >10MB) — emits { externalUrl, name }
// The selected payload shape is passed back through onFile; callers forward it to uploadDoc().
export function FileUpload({ file, onFile, error, onError }) {
  const inputRef = useRef(null)
  const [drag, setDrag] = useState(false)
  const [mode, setMode] = useState('file') // 'file' | 'link'
  const [urlInput, setUrlInput] = useState('')
  const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg']
  const MAX_MB = 10

  const process = f => {
    if (!f) return
    if (!ALLOWED.includes(f.type)) { onError && onError('Only PDF, JPG, PNG files are allowed.'); return }
    if (f.size > MAX_MB * 1024 * 1024) { onError && onError(`File exceeds ${MAX_MB}MB limit. Paste a drive link instead.`); return }
    onError && onError('')
    const reader = new FileReader()
    reader.onload = e => onFile({ name: f.name, size: f.size, mimeType: f.type, dataUrl: e.target.result })
    reader.readAsDataURL(f)
  }

  const submitLink = () => {
    const trimmed = urlInput.trim()
    if (!trimmed) { onError && onError('Please paste a drive link.'); return }
    if (trimmed.length > 2000) { onError && onError('Link is too long.'); return }
    let u
    try { u = new URL(trimmed) } catch { onError && onError('Invalid link — must be a valid URL.'); return }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      onError && onError('Link must start with http:// or https://')
      return
    }
    onError && onError('')
    // Derive a display name from the link's host (e.g. workdrive.zoho.com)
    onFile({ externalUrl: u.toString(), name: u.hostname })
    setUrlInput('')
  }

  const fmtSize = b => b > 1024 * 1024 ? (b / 1024 / 1024).toFixed(1) + 'MB' : (b / 1024).toFixed(0) + 'KB'
  const fileIcon = t => t === 'application/pdf' ? '📄' : (t && t.startsWith('image/')) ? '🖼' : '📎'

  // Selected state — either a file (file.dataUrl) or a link (file.externalUrl)
  if (file?.externalUrl) return (
    <div style={{ border: `2px solid ${T.successBorder}`, borderRadius: 10, padding: '14px 16px', background: T.successBg, display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ fontSize: 28, flexShrink: 0 }}>🔗</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Drive link attached</div>
        <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.externalUrl}</div>
      </div>
      <button onClick={() => { onFile(null); onError && onError('') }} style={{ background: '#fff', border: `1px solid ${T.border}`, borderRadius: 8, cursor: 'pointer', padding: '4px 10px', fontSize: 12, color: T.danger, fontWeight: 600, fontFamily: 'inherit' }}>Remove</button>
    </div>
  )

  if (file?.dataUrl) return (
    <div style={{ border: `2px solid ${T.successBorder}`, borderRadius: 10, padding: '14px 16px', background: T.successBg, display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ fontSize: 28, flexShrink: 0 }}>{fileIcon(file.mimeType)}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</div>
        <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>{fmtSize(file.size)} · {file.mimeType?.split('/')[1]?.toUpperCase() || 'FILE'}</div>
      </div>
      <button onClick={() => { onFile(null); onError && onError('') }} style={{ background: '#fff', border: `1px solid ${T.border}`, borderRadius: 8, cursor: 'pointer', padding: '4px 10px', fontSize: 12, color: T.danger, fontWeight: 600, fontFamily: 'inherit' }}>Remove</button>
    </div>
  )

  return (
    <div>
      {/* Mode toggle */}
      <div role="tablist" style={{ display: 'flex', gap: 2, background: '#f1f5f9', padding: 3, borderRadius: 9, marginBottom: 10, width: 'fit-content' }}>
        <button type="button" role="tab" aria-selected={mode === 'file'} onClick={() => { setMode('file'); onError && onError('') }}
          style={{ background: mode === 'file' ? '#fff' : 'transparent', border: 'none', cursor: 'pointer', padding: '5px 12px', borderRadius: 7, fontSize: 11, fontWeight: 700, color: mode === 'file' ? T.text : T.textMuted, fontFamily: 'inherit', boxShadow: mode === 'file' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none' }}>
          📎 Upload file
        </button>
        <button type="button" role="tab" aria-selected={mode === 'link'} onClick={() => { setMode('link'); onError && onError('') }}
          style={{ background: mode === 'link' ? '#fff' : 'transparent', border: 'none', cursor: 'pointer', padding: '5px 12px', borderRadius: 7, fontSize: 11, fontWeight: 700, color: mode === 'link' ? T.text : T.textMuted, fontFamily: 'inherit', boxShadow: mode === 'link' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none' }}>
          🔗 Paste link
        </button>
      </div>

      {mode === 'file' ? (
        <>
          <div onClick={() => inputRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDrag(true) }}
            onDragLeave={() => setDrag(false)}
            onDrop={e => { e.preventDefault(); setDrag(false); process(e.dataTransfer.files[0]) }}
            style={{ border: `2px dashed ${drag ? T.primary : error ? T.danger : T.border}`, borderRadius: 10, padding: '28px', textAlign: 'center', cursor: 'pointer', background: drag ? T.primaryLight : '#fafbff', transition: 'all 0.15s' }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>📎</div>
            <div style={{ fontWeight: 600, color: drag ? T.primary : T.textMuted, marginBottom: 4 }}>Click to upload or drag & drop</div>
            <div style={{ fontSize: 12, color: T.textLight }}>PDF, JPG, PNG · Max 10MB</div>
            <div style={{ fontSize: 11, color: T.textLight, marginTop: 6 }}>Larger file? Use <strong>Paste link</strong> above.</div>
          </div>
          <input ref={inputRef} type="file" accept=".pdf,.jpg,.jpeg,.png" style={{ display: 'none' }} onChange={e => process(e.target.files[0])} />
        </>
      ) : (
        <div style={{ border: `1px dashed ${error ? T.danger : T.border}`, borderRadius: 10, padding: '16px', background: '#fafbff' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Drive Link</div>
          <input
            type="url"
            value={urlInput}
            onChange={e => { setUrlInput(e.target.value); onError && onError('') }}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submitLink() } }}
            placeholder="https://workdrive.zoho.com/file/…"
            style={{ width: '100%', padding: '8px 10px', border: `1px solid ${T.border}`, borderRadius: 7, fontSize: 13, fontFamily: 'inherit', color: T.text, boxSizing: 'border-box' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 10 }}>
            <div style={{ fontSize: 11, color: T.textLight }}>For files larger than 10MB, paste a share link (Zoho Drive, Google Drive, etc.)</div>
            <button type="button" onClick={submitLink} disabled={!urlInput.trim()}
              style={{ background: urlInput.trim() ? T.primary : '#cbd5e1', color: '#fff', border: 'none', borderRadius: 7, padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: urlInput.trim() ? 'pointer' : 'not-allowed', fontFamily: 'inherit', flexShrink: 0 }}>
              Attach link
            </button>
          </div>
        </div>
      )}
      {error && <div style={{ fontSize: 11, color: T.danger, marginTop: 5, fontWeight: 500 }}>⚠ {error}</div>}
    </div>
  )
}

const fmtShort = d => {
  if (!d) return '—'
  const dt = new Date(d)
  const dd = String(dt.getDate()).padStart(2, '0')
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const yyyy = dt.getFullYear()
  return `${dd}-${mm}-${yyyy}`
}

export function DocCard({ doc, users, onGetData, stageName: stageNameProp }) {
  // Prefer server-populated name; fall back to local user lookup for admin context
  const localUploader = users?.find(u => u.id === doc.uploadedBy)
  const uploaderName = doc.uploadedByName || localUploader?.name || null
  const uploaderRole = doc.uploadedByRole || localUploader?.role || null
  const uploaderCompany = doc.uploadedByCompany || localUploader?.company || null
  const uploaderTag = uploaderRole && uploaderCompany
    ? `${uploaderRole === 'manufacturer' ? 'Mfr' : uploaderRole === 'buyer' ? 'Buyer' : 'Admin'} · ${uploaderCompany}`
    : null
  const exp = isExpiringSoon(doc.expiryDate), expd = isExpired(doc.expiryDate)
  const icon = DOC_ICONS[doc.type] || '📄'
  const typLabel = DOC_TYPES.find(d => d.v === doc.type)?.l || doc.type
  const [fileData, setFileData] = useState(null)
  const [fetching, setFetching] = useState(false)
  const [viewerBlob, setViewerBlob] = useState(null) // { url, mimeType, revoke }
  const [viewerLoading, setViewerLoading] = useState(false)

  const closeViewer = () => {
    if (viewerBlob) { viewerBlob.revoke(); setViewerBlob(null) }
    setViewerLoading(false)
  }

  useEffect(() => {
    if (!viewerBlob) return
    const h = e => { if (e.key === 'Escape') closeViewer() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [viewerBlob])

  const fetchData = async () => {
    if (fileData) return fileData
    if (!onGetData) return null
    setFetching(true)
    const d = await onGetData(doc.id)
    setFileData(d)
    setFetching(false)
    return d
  }

  const openFile = async () => {
    // External link doc — open in new tab, no viewer modal
    if (doc.externalUrl) {
      window.open(doc.externalUrl, '_blank', 'noopener,noreferrer')
      return
    }
    try {
      setViewerLoading(true)
      const d = fileData || await fetchData()
      if (!d?.dataUrl) { setViewerLoading(false); alert('Document data not available'); return }
      const blob = dataUrlToBlobUrl(d.dataUrl)
      if (!blob) { setViewerLoading(false); alert('Invalid document data'); return }
      setViewerBlob(blob)
      // viewerLoading stays true until iframe onLoad fires
    } catch (err) {
      setViewerLoading(false)
      alert('Failed to load document: ' + (err?.message || 'Unknown error'))
    }
  }

  const download = async () => {
    const d = fileData || await fetchData()
    if (!d?.dataUrl) return
    // Use blob URL — base64 hrefs fail on large files in some browsers
    const blob = dataUrlToBlobUrl(d.dataUrl)
    if (!blob) return
    const a = document.createElement('a')
    a.href = blob.url
    a.download = doc.fileName || doc.name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    // Revoke after a short delay so the download has time to start
    setTimeout(() => blob.revoke(), 1000)
  }

  const hasExternal = !!doc.externalUrl
  const hasFile = hasExternal || doc.fileName || fileData?.dataUrl
  const isStageDoc = doc.stageIndex != null
  const stageName = isStageDoc ? (stageNameProp || DEFAULT_STAGE_NAMES[doc.stageIndex] || `Stage ${doc.stageIndex + 1}`) : null
  const mfr = doc.mfrId ? users?.find(u => String(u.id) === String(doc.mfrId)) : null

  // ── Inline document viewer modal ──
  const viewer = (viewerBlob || viewerLoading) && (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.75)', zIndex: 2000, display: 'flex', flexDirection: 'column' }}
      onClick={e => e.target === e.currentTarget && closeViewer()}>
      {/* Toolbar */}
      <div style={{ height: 48, background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', flexShrink: 0, gap: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.name}</span>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {viewerBlob && (
            <button onClick={download}
              style={{ background: '#1e293b', border: '1px solid #334155', color: '#e2e8f0', borderRadius: 7, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
              ⬇ Download
            </button>
          )}
          <button onClick={closeViewer}
            style={{ background: '#ef4444', border: 'none', color: '#fff', borderRadius: 7, width: 32, height: 32, fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit' }}>
            ×
          </button>
        </div>
      </div>
      {/* Loading overlay */}
      {viewerLoading && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, background: '#0f172a' }}>
          <div style={{ width: 40, height: 40, border: '3px solid #334155', borderTopColor: '#f97316', borderRadius: '50%', animation: 'tradio-spin 0.7s linear infinite' }} />
          <div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8' }}>Loading document…</div>
        </div>
      )}
      {/* Content — rendered behind loading overlay, becomes visible on load */}
      {viewerBlob && (
        viewerBlob.mimeType.startsWith('image/') ? (
          <div style={{ flex: 1, overflow: 'auto', display: viewerLoading ? 'none' : 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
            <img src={viewerBlob.url} alt={doc.name}
              onLoad={() => setViewerLoading(false)}
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 4 }} />
          </div>
        ) : (
          <div style={{ flex: 1, overflow: 'hidden', display: viewerLoading ? 'none' : 'flex', minHeight: 0 }}>
            <PdfPageViewer bytes={viewerBlob.bytes} onReady={() => setViewerLoading(false)} />
          </div>
        )
      )}
    </div>
  )

  // ── Stage evidence doc — distinct compartmentalised layout ──
  if (isStageDoc) {
    const hasNotes = !!doc.notes
    return (
      <>
        {viewer}
        <div style={{ background: T.surface, borderRadius: 10, border: `1px solid ${T.border}`, marginBottom: 8, overflow: 'hidden' }}>
          {/* Stage header bar */}
          <div style={{ background: '#f0f7ff', borderBottom: `1px solid #dbeafe`, padding: '6px 14px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, fontWeight: 800, background: '#1d4ed8', color: '#fff', padding: '2px 8px', borderRadius: 6, letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>
              Stage {doc.stageIndex + 1} — {stageName}
            </span>
            {doc.orderId && <span style={{ fontSize: 11, color: T.primary, fontWeight: 700, whiteSpace: 'nowrap' }}>📦 {doc.orderId}</span>}
            {mfr && <span style={{ fontSize: 11, color: T.textMuted, fontWeight: 600, whiteSpace: 'nowrap' }}>🏭 {mfr.company}</span>}
          </div>
          {/* Doc body */}
          <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ fontSize: 20, flexShrink: 0 }}>{hasFile ? icon : (hasNotes ? '📝' : icon)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.name}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
                <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 10, background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', whiteSpace: 'nowrap' }}>{typLabel}</span>
                <span style={{ fontSize: 11, color: T.textLight, whiteSpace: 'nowrap' }}>{fmtShort(doc.issueDate || doc.uploadedAt)}</span>
                {uploaderName && (
                  <span style={{ fontSize: 11, color: T.textLight }}>
                    · {uploaderName}
                    {uploaderTag && <span style={{ marginLeft: 5, fontSize: 10, fontWeight: 700, color: T.textMuted, background: '#f1f5f9', border: `1px solid ${T.border}`, padding: '1px 6px', borderRadius: 6 }}>{uploaderTag}</span>}
                  </span>
                )}
              </div>
            </div>
            {hasFile ? (
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <Btn size="sm" variant="secondary" onClick={openFile} disabled={fetching}>{hasExternal ? '🔗 Open Link' : '👁 View'}</Btn>
                {!hasExternal && <Btn size="sm" variant="secondary" onClick={download} disabled={fetching}>⬇ Download</Btn>}
              </div>
            ) : hasNotes ? (
              <span style={{ fontSize: 10, fontWeight: 800, color: '#1d4ed8', background: '#dbeafe', padding: '3px 8px', borderRadius: 10, flexShrink: 0, letterSpacing: '0.04em' }}>TEXT</span>
            ) : (
              <span style={{ fontSize: 11, color: T.textLight, fontStyle: 'italic', flexShrink: 0 }}>Seed data</span>
            )}
          </div>
          {/* Notes block — visible inline for SOP-managed text evidence */}
          {hasNotes && (
            <div style={{ padding: '8px 14px 12px', borderTop: `1px dashed ${T.border}`, background: '#fafbfc' }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Notes</div>
              <div style={{ fontSize: 12, color: T.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{doc.notes}</div>
            </div>
          )}
        </div>
      </>
    )
  }

  // ── Regular doc ──
  return (
    <>
      {viewer}
      <div style={{ background: T.surface, borderRadius: 10, border: `1px solid ${exp || expd ? T.warningBorder : T.border}`, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <div style={{ fontSize: 22, flexShrink: 0 }}>{icon}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div onClick={hasFile ? openFile : undefined} style={{ fontSize: 13, fontWeight: 700, color: hasFile ? T.primary : T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: hasFile ? 'pointer' : 'default' }} title={hasFile ? (hasExternal ? 'Click to open link' : 'Click to view') : undefined}>{doc.name}{hasExternal && <span style={{ marginLeft: 6, fontSize: 11, opacity: 0.7 }}>🔗</span>}</div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center', marginTop: 5 }}>
            <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 10, background: '#f1f5f9', color: T.textMuted, border: `1px solid ${T.border}`, whiteSpace: 'nowrap' }}>{typLabel}</span>
            {doc.orderId && <span style={{ fontSize: 11, color: T.primary, fontWeight: 600, whiteSpace: 'nowrap' }}>📦 {doc.orderId}</span>}
            {mfr && <span style={{ fontSize: 11, color: T.textMuted, fontWeight: 600, whiteSpace: 'nowrap' }}>🏭 {mfr.company}</span>}
            <span style={{ fontSize: 11, color: T.textLight, whiteSpace: 'nowrap' }}>{fmtShort(doc.issueDate || doc.uploadedAt)}</span>
            {uploaderName && (
              <span style={{ fontSize: 11, color: T.textLight }}>
                · {uploaderName}
                {uploaderTag && <span style={{ marginLeft: 5, fontSize: 10, fontWeight: 700, color: T.textMuted, background: '#f1f5f9', border: `1px solid ${T.border}`, padding: '1px 6px', borderRadius: 6 }}>{uploaderTag}</span>}
              </span>
            )}
          </div>
        </div>
        {doc.expiryDate && (
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: expd ? T.danger : exp ? T.warning : T.success }}>{expd ? '⚠ Expired' : exp ? '⚠ Expiring' : '✓ Valid'}</div>
            <div style={{ fontSize: 10, color: T.textLight }}>Exp: {fmtShort(doc.expiryDate)}</div>
          </div>
        )}
        {hasFile ? (
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <Btn size="sm" variant="secondary" onClick={openFile} disabled={fetching}>{hasExternal ? '🔗 Open Link' : '👁 View'}</Btn>
            {!hasExternal && <Btn size="sm" variant="secondary" onClick={download} disabled={fetching}>⬇ Download</Btn>}
          </div>
        ) : (
          <span style={{ fontSize: 11, color: T.textLight, fontStyle: 'italic', flexShrink: 0 }}>Seed data</span>
        )}
      </div>
    </>
  )
}

export function MfrProfileLink({ mfrId, mfrName, docs, onGetData }) {
  const profileDoc = docs?.find(d =>
    d.type === 'mfr_profile' &&
    String(d.mfrId) === String(mfrId) &&
    d.isActive !== false &&
    (d.fileName || d.externalUrl)
  )
  const [viewerBlob, setViewerBlob] = useState(null)
  const [viewerLoading, setViewerLoading] = useState(false)

  const closeViewer = () => { if (viewerBlob) { viewerBlob.revoke(); setViewerBlob(null) }; setViewerLoading(false) }

  useEffect(() => {
    if (!viewerBlob && !viewerLoading) return
    const h = e => { if (e.key === 'Escape') closeViewer() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [viewerBlob, viewerLoading])

  const openProfile = async () => {
    if (!profileDoc) return
    if (profileDoc.externalUrl) {
      window.open(profileDoc.externalUrl, '_blank', 'noopener,noreferrer')
      return
    }
    if (!onGetData) return
    try {
      setViewerLoading(true)
      setViewerBlob(null)
      const d = await onGetData(profileDoc.id)
      if (!d?.dataUrl) { setViewerLoading(false); return }
      const blob = dataUrlToBlobUrl(d.dataUrl)
      if (!blob) { setViewerLoading(false); return }
      setViewerBlob(blob)
    } catch { setViewerLoading(false) }
  }

  if (!profileDoc) return <span>{mfrName || '—'}</span>

  return (
    <>
      {(viewerBlob || viewerLoading) && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.75)', zIndex: 2000, display: 'flex', flexDirection: 'column' }}
          onClick={e => e.target === e.currentTarget && closeViewer()}>
          <div style={{ height: 48, background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', flexShrink: 0, gap: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>{mfrName} — Manufacturer Profile</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {viewerBlob && (
                <button onClick={() => { const a = document.createElement('a'); a.href = viewerBlob.url; a.download = `${mfrName}_profile`; a.click() }}
                  style={{ background: '#1e293b', border: '1px solid #334155', color: '#e2e8f0', borderRadius: 7, padding: '0 12px', height: 32, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>⬇ Download</button>
              )}
              <button onClick={closeViewer}
                style={{ background: '#ef4444', border: 'none', color: '#fff', borderRadius: 7, width: 32, height: 32, fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit' }}>×</button>
            </div>
          </div>
          {viewerLoading && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, background: '#0f172a' }}>
              <div style={{ width: 40, height: 40, border: '3px solid #334155', borderTopColor: '#f97316', borderRadius: '50%', animation: 'tradio-spin 0.7s linear infinite' }} />
              <div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8' }}>Loading document…</div>
            </div>
          )}
          {viewerBlob && (
            viewerBlob.mimeType.startsWith('image/') ? (
              <div style={{ flex: 1, overflow: 'auto', display: viewerLoading ? 'none' : 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
                <img src={viewerBlob.url} alt={`${mfrName} profile`}
                  onLoad={() => setViewerLoading(false)}
                  style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 4 }} />
              </div>
            ) : (
              <div style={{ flex: 1, overflow: 'hidden', display: viewerLoading ? 'none' : 'flex', minHeight: 0 }}>
                <PdfPageViewer bytes={viewerBlob.bytes} onReady={() => setViewerLoading(false)} />
              </div>
            )
          )}
        </div>
      )}
      <button onClick={openProfile} title="View manufacturer profile"
        style={{ background: 'none', border: 'none', padding: 0, margin: 0, color: T.primary, cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {mfrName || '—'}
        <span style={{ fontSize: '0.8em', opacity: 0.7 }}>🏭</span>
      </button>
    </>
  )
}

export function StatusTimeline({ status }) {
  const idx = STATUS_FLOW.indexOf(status)
  return (
    <div style={{ overflowX: 'auto', paddingBottom: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', minWidth: 'max-content' }}>
        {STATUS_FLOW.map((s, i) => {
          const done = i < idx, cur = i === idx
          return (
            <span key={s} style={{ display: 'contents' }}>
              <div title={s} style={{ width: 26, height: 26, borderRadius: '50%', background: cur ? T.primary : done ? T.success : '#f1f5f9', border: cur ? `2px solid ${T.primaryDark}` : done ? `2px solid ${T.successBorder}` : 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800, color: (done || cur) ? '#fff' : T.textLight, flexShrink: 0, transition: 'all 0.2s' }}>
                {done ? '✓' : i + 1}
              </div>
              {i < STATUS_FLOW.length - 1 && <div style={{ width: 30, height: 2, background: i < idx ? T.success : T.border, transition: 'background 0.2s' }} />}
            </span>
          )
        })}
      </div>
      <div style={{ display: 'flex', minWidth: 'max-content', marginTop: 4 }}>
        {STATUS_FLOW.map(s => (
          <div key={s} style={{ width: 56, fontSize: 8, color: T.textLight, textAlign: 'center', flexShrink: 0, lineHeight: 1.4, fontWeight: 500 }}>{s.split(' ').slice(0, 2).join(' ')}</div>
        ))}
      </div>
    </div>
  )
}

// 10-stage timeline driven by actual stage progress data
export function StageTimeline({ stages = [] }) {
  return (
    <div style={{ overflowX: 'auto', paddingBottom: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', minWidth: 'max-content' }}>
        {stages.map((s, i) => {
          const done   = s.totalUnits > 0 && s.unitsDone >= s.totalUnits
          const active = !done && s.unitsDone > 0
          const bg     = done ? T.success : active ? T.primary : '#f1f5f9'
          const border = done ? `2px solid ${T.successBorder}` : active ? `2px solid ${T.primaryDark}` : 'none'
          const color  = done || active ? '#fff' : T.textLight
          return (
            <span key={i} style={{ display: 'contents' }}>
              <div title={s.name} style={{ width: 26, height: 26, borderRadius: '50%', background: bg, border, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800, color, flexShrink: 0, transition: 'all 0.2s' }}>
                {done ? '✓' : i + 1}
              </div>
              {i < stages.length - 1 && (
                <div style={{ width: 24, height: 2, background: done ? T.success : T.border, transition: 'background 0.2s' }} />
              )}
            </span>
          )
        })}
      </div>
      <div style={{ display: 'flex', minWidth: 'max-content', marginTop: 5 }}>
        {stages.map((s, i) => (
          <div key={i} style={{ width: 50, fontSize: 8, color: T.textLight, textAlign: 'center', flexShrink: 0, lineHeight: 1.4, fontWeight: 500 }}>
            {s.name.split(' ').slice(0, 2).join('\n')}
          </div>
        ))}
      </div>
    </div>
  )
}

export function PageHeader({ title, subtitle, action }) {
  return (
    <div className="page-header">
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: T.text, margin: 0, letterSpacing: '-0.02em' }}>{title}</h1>
        {subtitle && <p style={{ fontSize: 13, color: T.textMuted, marginTop: 5 }}>{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

export function EmptyState({ icon, title, desc }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 24px', color: T.textLight }}>
      <div style={{ fontSize: 36, marginBottom: 12 }}>{icon}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: T.textMuted, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13 }}>{desc}</div>
    </div>
  )
}

// ── Ribbon Banner ────────────────────────────────────────────────────────────
// Shown below the header when there are active alerts.
// type: 'urgent' | 'warning' | 'info'
export function RibbonBanner({ ribbons = [] }) {
  const [dismissed, setDismissed] = useState(new Set())
  const visible = ribbons.filter(r => !dismissed.has(r.id))
  if (!visible.length) return null

  const styles = {
    urgent:  { bg: '#fff1f2', border: '#fecdd3', text: '#9f1239', dot: '#f43f5e' },
    warning: { bg: '#fffbeb', border: '#fde68a', text: '#92400e', dot: '#f59e0b' },
    info:    { bg: '#eff6ff', border: '#bfdbfe', text: '#1e40af', dot: '#3b82f6' },
  }

  return (
    <div style={{ flexShrink: 0 }}>
      {visible.map(r => {
        const s = styles[r.type] || styles.info
        return (
          <div key={r.id} style={{ background: s.bg, borderBottom: `1px solid ${s.border}`, padding: '8px 24px', display: 'flex', alignItems: 'center', gap: 10, minHeight: 36 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: s.dot, flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: s.text, lineHeight: 1.4 }}>{r.msg}</span>
            <button onClick={() => setDismissed(p => new Set([...p, r.id]))}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 15, color: s.text, opacity: 0.45, padding: '0 2px', lineHeight: 1, fontFamily: 'inherit' }}>×</button>
          </div>
        )
      })}
    </div>
  )
}

export function Mono({ children, style: s }) {
  return <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12, color: T.primary, fontWeight: 500, ...s }}>{children}</span>
}

export function Grid({ cols, gap = 14, children, style: s }) {
  const cls = cols >= 4 ? 'grid-responsive-4' : cols === 3 ? 'grid-responsive-3' : cols === 2 ? 'grid-responsive-2' : ''
  return <div className={cls} style={{ display: 'grid', gridTemplateColumns: `repeat(${cols},1fr)`, gap, ...s }}>{children}</div>
}

export function FlexRow({ children, gap = 10, align = 'center', justify = 'flex-start', style: s }) {
  return <div style={{ display: 'flex', alignItems: align, justifyContent: justify, gap, ...s }}>{children}</div>
}

export function Divider({ mt = 12, mb = 12 }) {
  return <div style={{ height: 1, background: T.border, margin: `${mt}px 0 ${mb}px` }} />
}

// Groups docs by stage — separates non-stage docs from stage evidence docs
// stageDocs: all docs for this order/mfr
// stages: optional array of stage objects (for progress context)
// mfrLabel: optional string to disambiguate multi-mfr orders
export function StageDocGroup({ docs = [], stages = [], users, onGetData, mfrLabel }) {
  const [collapsed, setCollapsed] = useState({})
  const toggle = i => setCollapsed(p => ({ ...p, [i]: !p[i] }))

  const nonStageDocs = docs.filter(d => d.stageIndex == null)
  const stageDocs    = docs.filter(d => d.stageIndex != null)

  // Group stage docs by stageIndex
  const byStage = stageDocs.reduce((acc, d) => {
    const idx = d.stageIndex
    if (!acc[idx]) acc[idx] = []
    acc[idx].push(d)
    return acc
  }, {})

  const stageIndices = Object.keys(byStage).map(Number).sort((a, b) => a - b)

  const stageStatus = (idx) => {
    const s = stages[idx]
    if (!s) return null
    const pct = s.totalUnits > 0 ? Math.round((s.unitsDone / s.totalUnits) * 100) : 0
    return { pct, done: pct >= 100, active: pct > 0 && pct < 100 }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Non-stage order documents */}
      {nonStageDocs.length > 0 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.09em' }}>Order Documents</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, background: '#f1f5f9', border: `1px solid ${T.border}`, borderRadius: 10, padding: '0 7px', lineHeight: '18px' }}>{nonStageDocs.length}</span>
            <div style={{ flex: 1, height: 1, background: T.border }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {nonStageDocs.map(d => <DocCard key={d.id} doc={d} users={users} onGetData={onGetData} />)}
          </div>
        </div>
      )}

      {/* Stage evidence sections */}
      {stageIndices.length > 0 && (
        <div>
          {/* Section header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.09em' }}>Stage Evidence</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#1d4ed8', background: '#dbeafe', border: '1px solid #bfdbfe', borderRadius: 10, padding: '0 7px', lineHeight: '18px' }}>{stageDocs.length} docs · {stageIndices.length} stages</span>
            <div style={{ flex: 1, height: 1, background: T.border }} />
            {mfrLabel && <span style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, whiteSpace: 'nowrap' }}>🏭 {mfrLabel}</span>}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {stageIndices.map(idx => {
              const docsForStage = byStage[idx]
              const name = stages[idx]?.name || DEFAULT_STAGE_NAMES[idx] || `Stage ${idx + 1}`
              const st = stageStatus(idx)
              const isOpen = !collapsed[idx]

              return (
                <div key={idx} style={{ border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
                  {/* Stage accordion header */}
                  <button
                    onClick={() => toggle(idx)}
                    style={{
                      width: '100%', border: 'none', cursor: 'pointer',
                      padding: '10px 14px', fontFamily: 'inherit',
                      display: 'flex', alignItems: 'center', gap: 10,
                      background: st?.done ? '#f0fdf4' : '#f0f7ff',
                    }}
                  >
                    {/* Stage number badge */}
                    <span style={{
                      width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                      background: st?.done ? T.success : st?.active ? T.primary : '#94a3b8',
                      color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 10, fontWeight: 800,
                    }}>
                      {st?.done ? '✓' : idx + 1}
                    </span>

                    <span style={{ fontSize: 13, fontWeight: 700, color: T.text, flex: 1, textAlign: 'left' }}>{name}</span>

                    {/* Progress pill */}
                    {st && (
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
                        background: st.done ? T.successBg : st.active ? T.primaryLight : '#f1f5f9',
                        color: st.done ? T.success : st.active ? T.primary : T.textMuted,
                        border: `1px solid ${st.done ? T.successBorder : st.active ? '#fed7aa' : T.border}`,
                        whiteSpace: 'nowrap',
                      }}>{st.pct}%</span>
                    )}

                    {/* Doc count */}
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#1d4ed8', background: '#dbeafe', border: '1px solid #bfdbfe', borderRadius: 10, padding: '1px 7px', whiteSpace: 'nowrap' }}>
                      {docsForStage.length} doc{docsForStage.length !== 1 ? 's' : ''}
                    </span>

                    {/* Chevron */}
                    <span style={{ fontSize: 12, color: T.textMuted, transition: 'transform 0.2s', transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', flexShrink: 0 }}>›</span>
                  </button>

                  {/* Docs list */}
                  {isOpen && (
                    <div style={{ padding: '10px 12px', borderTop: `1px solid ${T.border}`, background: T.surface, display: 'flex', flexDirection: 'column', gap: 0 }}>
                      {docsForStage.map(d => <DocCard key={d.id} doc={d} users={users} onGetData={onGetData} stageName={name} />)}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {nonStageDocs.length === 0 && stageDocs.length === 0 && null}
    </div>
  )
}

export function SectionLabel({ children }) {
  return <div style={{ fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 10 }}>{children}</div>
}

export function LoadingScreen({ message = 'Loading data…' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '80px 24px', minHeight: 300 }}>
      <div style={{ width: 40, height: 40, border: `3px solid ${T.border}`, borderTopColor: T.primary, borderRadius: '50%', animation: 'tradio-spin 0.7s linear infinite', marginBottom: 16 }} />
      <div style={{ fontSize: 14, fontWeight: 600, color: T.textMuted }}>{message}</div>
      <style>{`@keyframes tradio-spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}
