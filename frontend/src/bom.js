// The bill of materials checklist of a style, as the screens need it. Pure: no React, no network.

// How much of each item a piece and the order need (perPiece, forOrder). Hidden for now, at Ankit's request (24 Nov 2026):
// the figures stay saved, the screens just do not show or ask for them. Set to true to bring them back.
export const SHOW_CONSUMPTION = false

/** The items in the order they were written, grouped under their section headings (an item with none goes under ''). */
export function bomSections(bom) {
  const out = []
  for (const item of bom?.items || []) {
    const last = out[out.length - 1]
    if (last && last.section === (item.section || '')) last.items.push(item)
    else out.push({ section: item.section || '', items: [item] })
  }
  return out
}

/** The tick on an item at one factory, or null. */
export const checkAt = (item, factoryId) => (item?.checks || []).find(c => String(c.mfrId) === String(factoryId)) || null

/** How many items are ticked at a factory, of how many. */
export function bomProgress(bom, factoryId) {
  const items = bom?.items || []
  return { done: items.filter(i => checkAt(i, factoryId)).length, total: items.length }
}

/** The editor's rows from a saved list, and back to what the server takes. A picture travels only when it was changed. */
export const editorRows = bom => (bom?.items || []).map(i => ({ id: i.id, section: i.section, name: i.name, description: i.description, perPiece: i.perPiece, forOrder: i.forOrder, hasImage: i.hasImage, image: undefined }))
export const blankRow = (section = '') => ({ id: null, section, name: '', description: '', perPiece: '', forOrder: '', hasImage: false, image: undefined })
export function editorPayload(rows) {
  return rows.filter(r => r.name.trim()).map(r => ({
    ...(r.id ? { id: r.id } : {}), section: r.section.trim(), name: r.name.trim(), description: r.description.trim(),
    perPiece: r.perPiece.trim(), forOrder: r.forOrder.trim(), ...(r.image !== undefined ? { image: r.image } : {}),
  }))
}
