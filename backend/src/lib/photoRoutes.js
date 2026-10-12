// The evidence photos of a record (a goods received note, a job work challan): the same five routes under each, mounted
// here once. A photo is kept apart from the record (lib/imageUpload.js checks it), listed without its bytes and read one
// at a time; at most 12 to a record; adding is always allowed to the company that owns the record, removing only while
// `removable(record)` says so (a posted note's photos stay as evidence).
import { Attachment } from '../db/index.js'
import { checkPhoto } from './imageUpload.js'
import { ATTACHMENT_KINDS } from '../models/Attachment.js'

const OBJECT_ID = /^[a-f0-9]{24}$/
export const MAX_PHOTOS = 12

export const photoView = a => ({ id: String(a._id), kind: a.kind, name: a.name || '', caption: a.caption || '', mimeType: a.mimeType, size: a.size || 0, createdAt: a.createdAt })

/**
 * @param {import('express').Router} router
 * @param {{ refType: 'grn' | 'jobwork', owned: (req) => Promise<object | null>, removable?: (record) => boolean,
 *   writeLimiter: Function, photoLimiter: Function, notFound: string, removedRefused?: string }} o
 *   `owned(req)` loads the record named by :id for the caller's own company, or null.
 */
export function mountPhotoRoutes(router, { refType, owned, removable = () => true, writeLimiter, photoLimiter, notFound, removeRefused = 'The photos are kept as evidence' }) {
  const fail = (res, status, error) => res.status(status).json({ error })
  const ids = (req, res, key = 'id') => {
    if (!OBJECT_ID.test(req.params[key] || '')) { fail(res, 404, key === 'id' ? notFound : 'Photo not found'); return false }
    return true
  }
  const mineFilter = req => ({ ownerOrgId: req.user.orgId, refType, refId: req.params.id })

  router.get('/:id/photos', async (req, res) => {
    try {
      if (!ids(req, res)) return
      if (!await owned(req)) return fail(res, 404, notFound)
      const photos = await Attachment.find(mineFilter(req), '-dataUrl').sort({ createdAt: 1 }).lean()
      res.json(photos.map(photoView))
    } catch (err) { console.error(`[${refType}]`, err); fail(res, 500, 'Server error') }
  })

  router.post('/:id/photos', photoLimiter, async (req, res) => {
    try {
      if (!ids(req, res)) return
      if (!await owned(req)) return fail(res, 404, notFound)
      const checked = checkPhoto(req.body?.dataUrl, req.body?.mimeType)
      if (!checked.ok) return fail(res, 400, checked.error)
      const kind = ATTACHMENT_KINDS.includes(req.body?.kind) ? req.body.kind : 'other'
      if (await Attachment.countDocuments(mineFilter(req)) >= MAX_PHOTOS) return fail(res, 400, `At most ${MAX_PHOTOS} photos can be kept here`)
      const a = await Attachment.create({
        ...mineFilter(req), kind,
        name: typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 200) : '',
        caption: typeof req.body?.caption === 'string' ? req.body.caption.trim().slice(0, 300) : '',
        mimeType: checked.mimeType, size: checked.size, dataUrl: req.body.dataUrl, uploadedBy: req.user.actorId,
      })
      res.status(201).json(photoView(a.toObject()))
    } catch (err) { console.error(`[${refType}]`, err); fail(res, 500, 'Server error') }
  })

  router.get('/:id/photos/:photoId', async (req, res) => {
    try {
      if (!ids(req, res) || !ids(req, res, 'photoId')) return
      const a = await Attachment.findOne({ _id: req.params.photoId, ...mineFilter(req) }).lean()
      if (!a) return fail(res, 404, 'Photo not found')
      res.json({ ...photoView(a), dataUrl: a.dataUrl })
    } catch (err) { console.error(`[${refType}]`, err); fail(res, 500, 'Server error') }
  })

  router.post('/:id/photos/:photoId/delete', writeLimiter, async (req, res) => {
    try {
      if (!ids(req, res) || !ids(req, res, 'photoId')) return
      const record = await owned(req)
      if (!record) return fail(res, 404, notFound)
      if (!removable(record)) return fail(res, 409, removeRefused)
      const r = await Attachment.deleteOne({ _id: req.params.photoId, ...mineFilter(req) })
      if (r.deletedCount === 0) return fail(res, 404, 'Photo not found')
      res.json({ ok: true })
    } catch (err) { console.error(`[${refType}]`, err); fail(res, 500, 'Server error') }
  })
}
