import { useEffect, useRef, useState } from 'react'
import { FileText, Upload } from '../icons.jsx'
import { T } from '../constants.js'
import { capsFor } from '../caps.js'
import { useApp } from '../context.jsx'
import { sopsApi } from '../api.js'
import { Btn, DocViewer, useToast } from './ui.jsx'

const MAX_BYTES = 8 * 1024 * 1024
const asDataUrl = file => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error('Could not read the file')); r.readAsDataURL(file) })

// The customer's SOP for the style on screen: a link that opens the PDF in a window, no download needed. Shown to
// Tradio, the factory making the style and its coordinator (the server decides; a customer is never sent it). A Tradio
// admin also adds or replaces the file here. `big` is the coordinator's large button; `label` its wording.
export function SopLink({ order, big = false, label = '' }) {
  const { currentUser } = useApp()
  const caps = capsFor(currentUser)
  const toast = useToast()
  const [sop, setSop] = useState(null)   // null until known; { exists: false } when there is none or it is not his to see
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const pick = useRef(null)

  useEffect(() => {
    if (caps.isBuyer) return
    let live = true
    setSop(null)
    sopsApi.get(order.id).then(s => { if (live) setSop(s) }).catch(() => { if (live) setSop({ exists: false }) })
    return () => { live = false }
  }, [order.id, caps.isBuyer])

  if (caps.isBuyer || !sop) return null
  const mayEdit = caps.isAdmin
  if (!sop.exists && !mayEdit) return null

  const upload = async e => {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file) return
    if (file.type !== 'application/pdf') { toast('The SOP must be a PDF file', 'error'); return }
    if (file.size > MAX_BYTES) { toast('That PDF is too large (8 MB at most)', 'error'); return }
    setBusy(true)
    try {
      const saved = await sopsApi.save(order.buyerId, { name: `${order.buyerCompany || 'Customer'} SOP`, fileName: file.name, dataUrl: await asDataUrl(file) })
      setSop(saved)
      toast(saved.hasText ? 'SOP saved. Kriyaa can answer from it.' : 'SOP saved. Its words could not be read, so Kriyaa cannot answer from it yet.', saved.hasText ? 'success' : 'error')
    } catch (err) { toast(typeof err === 'string' ? err : (err?.message || 'Could not save the SOP'), 'error') }
    finally { setBusy(false) }
  }
  // `scroll`: a long document, read by scrolling down through every page rather than page by page.
  const doc = { id: `sop-${order.buyerId}`, name: sop.name || 'SOP', fileName: sop.fileName || 'sop.pdf', scroll: true }

  return (
    <>
      {sop.exists && (big
        ? <button type="button" onClick={() => setOpen(true)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 52, borderRadius: 14, border: `2px solid ${T.border}`, background: '#fff', color: T.text, fontSize: 16, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
            <FileText size={20} color={T.info} /> {label || 'SOP'}
          </button>
        : <Btn variant="secondary" size="sm" onClick={() => setOpen(true)} icon={<FileText size={13} />}>SOP</Btn>)}
      {mayEdit && !big && (
        <>
          <Btn variant={sop.exists ? 'ghost' : 'secondary'} size="sm" disabled={busy} onClick={() => pick.current?.click()} icon={<Upload size={13} />}>
            {busy ? 'Saving...' : sop.exists ? 'Replace SOP' : `Add ${order.buyerCompany || 'customer'} SOP`}
          </Btn>
          <input ref={pick} type="file" accept="application/pdf" onChange={upload} style={{ display: 'none' }} />
        </>
      )}
      {open && <DocViewer doc={doc} onGetData={() => sopsApi.file(order.id)} onClose={() => setOpen(false)} />}
    </>
  )
}
