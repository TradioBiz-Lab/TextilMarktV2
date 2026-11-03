import { useState } from 'react'
import { ArrowUpRight, Pencil } from '../icons.jsx'
import { T } from '../constants.js'
import { Btn, FlexRow, Input, useToast } from './ui.jsx'
import { useApp } from '../context.jsx'
import { autoShortenLink } from '../links.js'

// The customer's own style: paste its product page (its Amazon listing, say) here instead of sending it on WhatsApp. An Amazon
// link is shortened as it is pasted; Tradio is told when it changes.
export function ProductLinkEditor({ order }) {
  const { setProductLink } = useApp()
  const toast = useToast()
  const [editing, setEditing] = useState(!order.ecommerceLink)
  const [value, setValue] = useState(order.ecommerceLink || '')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      const updated = await setProductLink(order.id, value.trim())
      toast(updated.ecommerceLink ? 'Product link saved' : 'Product link removed', 'success')
      setValue(updated.ecommerceLink || '')
      setEditing(!updated.ecommerceLink)
    } catch (e) { toast(e?.message || 'Could not save the link.', 'error') }
    finally { setSaving(false) }
  }

  if (!editing) {
    return (
      <FlexRow gap={8} style={{ marginTop: 6, flexWrap: 'wrap' }}>
        <a href={order.ecommerceLink} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, fontWeight: 600, color: T.primaryDeep, overflowWrap: 'anywhere' }}>
          {order.ecommerceLink} <ArrowUpRight size={11} style={{ verticalAlign: -1 }} />
        </a>
        <Btn size="sm" variant="secondary" icon={<Pencil size={12} />} onClick={() => setEditing(true)}>Change</Btn>
      </FlexRow>
    )
  }
  return (
    <FlexRow gap={8} style={{ marginTop: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 240px', minWidth: 0 }}>
        <Input label="Product link" value={value} onChange={e => setValue(autoShortenLink(e.target.value))} placeholder="Paste your Amazon or website link" />
      </div>
      <Btn size="sm" disabled={saving || value.trim() === (order.ecommerceLink || '')} onClick={save}>{saving ? 'Saving…' : 'Save'}</Btn>
      {order.ecommerceLink && <Btn size="sm" variant="secondary" disabled={saving} onClick={() => { setValue(order.ecommerceLink); setEditing(false) }}>Cancel</Btn>}
    </FlexRow>
  )
}
