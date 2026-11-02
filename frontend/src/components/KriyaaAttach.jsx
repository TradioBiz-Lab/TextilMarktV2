import { useRef } from 'react'
import { Paperclip, FileSpreadsheet, X } from '../icons.jsx'
import { T } from '../constants.js'
import { useKriyaaChat } from '../kriyaaChatContext.jsx'
import { SHEET_ACCEPT, splitAttachment } from '../styleImport.js'

// The paperclip in Kriyaa's composer (admins only): attach an Excel or CSV sheet of styles, then tell Kriyaa which master
// order to put them under. Shared by the floating widget and the full-page view, so both read the one attachment held in
// the chat context.
export function KriyaaAttachButton({ size = 38, radius = 8, iconSize = 16 }) {
  const { canAttach, attach, attaching, busy } = useKriyaaChat()
  const input = useRef(null)
  if (!canAttach) return null
  return (
    <>
      <input ref={input} type="file" accept={SHEET_ACCEPT} hidden
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) attach(f) }} />
      <button onClick={() => input.current?.click()} disabled={attaching || busy} title="Attach a sheet of styles (Excel or CSV)" aria-label="Attach a sheet of styles"
        style={{
          flexShrink: 0, width: size, height: size, borderRadius: radius, border: 'none', cursor: attaching || busy ? 'not-allowed' : 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f8fafc', color: T.textMuted, opacity: attaching || busy ? 0.5 : 1,
        }}>
        <Paperclip size={iconSize} />
      </button>
    </>
  )
}

/** What is attached (or still uploading, or why it failed), above the composer. */
export function KriyaaAttachStatus({ pad = '8px 14px 0', fontSize = 12 }) {
  const { attachment, attaching, attachError, clearAttachment } = useKriyaaChat()
  if (!attachment && !attaching && !attachError) return null
  return (
    <div style={{ padding: pad, fontSize, display: 'flex', alignItems: 'center', gap: 8, color: attachError ? T.danger : T.textMuted }}>
      {attaching ? 'Uploading the sheet…' : attachError ? attachError : (
        <>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: T.primaryLight, color: T.primaryDeep, border: `1px solid ${T.border}`, borderRadius: 999, padding: '3px 10px', fontWeight: 700, maxWidth: '100%', overflow: 'hidden' }}>
            <FileSpreadsheet size={13} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{attachment.filename}</span>
          </span>
          <span>Say which master order it goes under.</span>
        </>
      )}
      {(attachment || attachError) && !attaching && (
        <button onClick={clearAttachment} aria-label="Remove the attachment" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', color: T.textLight }}><X size={13} /></button>
      )}
    </div>
  )
}

/** A chat message's text; a message that carries an attached sheet shows it as a chip instead of the raw marker line. */
export function KriyaaMessageText({ content, onUserBubble }) {
  const { attachment, text } = splitAttachment(content)
  if (!attachment) return <>{content}</>
  return (
    <>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: text ? 6 : 0, padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700,
        background: onUserBubble ? 'rgba(255,255,255,0.22)' : T.primaryLight, color: onUserBubble ? '#fff' : T.primaryDeep }}>
        <FileSpreadsheet size={13} />{attachment.filename}
      </span>
      {text ? <div>{text}</div> : null}
    </>
  )
}
