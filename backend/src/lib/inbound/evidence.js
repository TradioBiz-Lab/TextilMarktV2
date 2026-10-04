import { Document } from '../../models/Document.js'

/**
 * Files a message as stage evidence: a Document linked to the order, the
 * factory and the exact TNA stage, so it shows up in the Stage Evidence tab
 * (admin, buyer and manufacturer views) with no separate surface.
 * Returns the new document id.
 */
export async function createEvidence({ msg, factory, orderId, stageIndex, stageName, issue, note }) {
  const parts = []
  if (msg.type === 'audio' || msg.type === 'text') parts.push(msg.rawText)
  if (note && !parts.includes(note)) parts.push(note)
  if (issue) parts.push(`Issue flagged: ${issue}`)
  const hasFile = !!msg.dataUrl
  const ext = (msg.mimeType || '').split('/')[1]?.split(';')[0] || 'bin'
  const doc = await Document.create({
    type: 'floor_evidence',
    name: stageName,
    mfrId: factory._id, orderId, stageIndex,
    uploadedBy: factory._id,
    issuer: `Auto-captured from ${msg.channel === 'whatsapp' ? 'WhatsApp' : 'web'} ${msg.type}`,
    notes: parts.filter(Boolean).join('\n').slice(0, 2000) || null,
    dataUrl: hasFile ? msg.dataUrl : null,
    fileName: hasFile ? `${msg.type}-${msg._id}.${ext}` : null,
    fileSize: hasFile ? Math.round((msg.dataUrl.length * 3) / 4) : null,
    mimeType: hasFile ? msg.mimeType : null,
    sourceMessageId: msg._id,
  })
  return doc._id
}

/** Hides evidence when a coordinator rejects or corrects the message it came from. */
export const retractEvidence = messageId =>
  Document.updateMany({ sourceMessageId: messageId }, { $set: { isActive: false } })
