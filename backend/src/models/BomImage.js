import mongoose from 'mongoose'

// The picture of one line of a style's bill of materials (Order.bom.items[].id): a swatch, a zip, a label. Kept apart
// from the order so the list of styles stays light; a style's pictures are read together (GET /api/orders/:id/bom/images).
const bomImageSchema = new mongoose.Schema({
  orderId: { type: String, required: true },
  itemId:  { type: String, required: true },
  dataUrl: { type: String, required: true },
}, { timestamps: true })
bomImageSchema.index({ orderId: 1, itemId: 1 }, { unique: true })

export const BomImage = mongoose.model('BomImage', bomImageSchema)
