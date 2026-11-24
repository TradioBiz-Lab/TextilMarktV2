import crypto from 'node:crypto'

// A style's bill of materials as a checklist: every fabric, trim, label and packing item it needs, each with an
// optional picture, and a tick per factory when someone has seen the item there. It carries no prices.
export const BOM_MAX_ITEMS = 80
export const BOM_IMAGE_MAX_CHARS = 420000   // about 300 KB of picture as a data URL
const IMAGE_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/**
 * Checks a bill of materials sent by an admin against the one already kept. An item that keeps its id keeps its ticks
 * and its picture. `image` on an item: a data URL sets a new picture, null removes it, leaving it out keeps it.
 * Returns { error } or { items, setImages: [{ itemId, dataUrl }], dropImages: [itemId] }; no items means "remove it".
 */
export function cleanBom(body, existing) {
  const list = body?.items
  if (!Array.isArray(list)) return { error: 'Send the list of items' }
  if (list.length > BOM_MAX_ITEMS) return { error: `A bill of materials holds at most ${BOM_MAX_ITEMS} items` }
  const before = new Map((existing?.items || []).map(i => [i.id, i]))
  const seen = new Set(); const items = []; const setImages = []; const dropImages = []
  for (const raw of list) {
    const name = str(raw?.name, 120)
    if (!name) return { error: 'Every item needs a name' }
    const old = typeof raw?.id === 'string' && before.has(raw.id) && !seen.has(raw.id) ? before.get(raw.id) : null
    const id = old ? old.id : crypto.randomBytes(6).toString('hex')
    seen.add(id)
    let hasImage = !!old?.hasImage
    if (raw.image === null) { if (hasImage) dropImages.push(id); hasImage = false }
    else if (raw.image !== undefined) {
      if (typeof raw.image !== 'string' || !IMAGE_RE.test(raw.image)) return { error: `The picture of "${name}" must be a JPEG, PNG or WebP image` }
      if (raw.image.length > BOM_IMAGE_MAX_CHARS) return { error: `The picture of "${name}" is too large` }
      setImages.push({ itemId: id, dataUrl: raw.image }); hasImage = true
    }
    items.push({
      id, section: str(raw.section, 60), name, description: str(raw.description, 200),
      perPiece: str(raw.perPiece, 40), forOrder: str(raw.forOrder, 40), hasImage, checks: old?.checks || [],
    })
  }
  for (const [id, old] of before) if (!seen.has(id) && old.hasImage) dropImages.push(id)
  return { items, setImages, dropImages }
}

/**
 * The bill of materials as a viewer is sent it. `viewers` is the list of factories whose ticks he sees (null for all);
 * a customer is sent the items and no ticks.
 */
export function bomOut(bom, viewers = null, { forBuyer = false } = {}) {
  if (!bom || !(bom.items || []).length) return null
  return {
    items: bom.items.map(i => ({
      id: i.id, section: i.section || '', name: i.name, description: i.description || '',
      perPiece: i.perPiece || '', forOrder: i.forOrder || '', hasImage: !!i.hasImage,
      checks: forBuyer ? [] : (i.checks || []).filter(c => !viewers || viewers.includes(String(c.mfrId)))
        .map(c => ({ mfrId: String(c.mfrId), byName: c.byName || '', at: c.at })),
    })),
    updatedAt: bom.updatedAt || null,
  }
}
