import { useState } from 'react'
import { T } from '../constants.js'
import { Btn, FlexRow, useToast } from './ui.jsx'
import { useApp } from '../context.jsx'

/**
 * Tradio files a requirement a customer sent in (an RFQ, tech pack or PO with no style yet) into one of that customer's
 * styles. The file moves onto the style, and the customer sees where it went on its Submit Requirement page.
 */
export function FileIntoStyle({ doc }) {
  const { orders, fileDocInto } = useApp()
  const toast = useToast()
  const [orderId, setOrderId] = useState('')
  const [busy, setBusy] = useState(false)
  const styles = (orders || []).filter(o => String(o.buyerId) === String(doc.uploadedBy))
    .sort((a, b) => String(a.product || '').localeCompare(String(b.product || '')))
  if (styles.length === 0) return <div style={{ fontSize: 11.5, color: T.textMuted, padding: '0 4px 8px' }}>This customer has no styles yet to file it into.</div>
  const file = async () => {
    const o = styles.find(x => x.id === orderId)
    setBusy(true)
    try { await fileDocInto(doc.id, orderId); toast(`Filed into ${o?.product || orderId}`, 'success') }
    catch (e) { toast(typeof e === 'string' ? e : (e?.message || 'Could not file it'), 'error') }
    finally { setBusy(false) }
  }
  return (
    <FlexRow gap={8} style={{ flexWrap: 'wrap', padding: '0 4px 10px' }}>
      <select value={orderId} onChange={e => setOrderId(e.target.value)} disabled={busy} aria-label={`Style to file ${doc.name} into`}
        style={{ flex: '1 1 220px', minWidth: 0, border: `1px solid ${T.border}`, borderRadius: 8, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit', color: T.text, background: '#fff' }}>
        <option value="">File into a style...</option>
        {styles.map(o => <option key={o.id} value={o.id}>{o.product}{o.styleNumber ? ` (${o.styleNumber})` : ''} · {o.id}</option>)}
      </select>
      <Btn size="sm" disabled={!orderId || busy} onClick={file}>{busy ? 'Filing…' : 'File it'}</Btn>
    </FlexRow>
  )
}
