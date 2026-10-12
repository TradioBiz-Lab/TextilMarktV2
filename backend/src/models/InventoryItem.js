import mongoose from 'mongoose'

export const INVENTORY_CATEGORIES = ['fabric', 'yarn', 'trims', 'packaging', 'other']

// One thing a factory keeps in stock: a fabric in a colour, a zip, a carton. It is named the way the
// factory writes it on a purchase order ("Polar fleece 300 GSM, 150 cm - BLACK"), because that is also
// how a challan names it, so goods received find their item by name and unit.
//
// What is in stock is not stored here. The stock ledger holds every movement and a balance is the sum
// of them (lib/inventory/stock.js), so there is no number that can drift from the movements behind it.
// Every item belongs to one organization (`ownerOrgId`) and is never visible to anyone else.
const inventoryItemSchema = new mongoose.Schema({
  ownerOrgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  name: { type: String, required: true, trim: true, maxlength: 300 },
  unit: { type: String, default: 'pcs', trim: true, maxlength: 20 },
  category: { type: String, enum: INVENTORY_CATEGORIES, default: 'other' },
  // Derived from name and unit (itemKey in lib/inventory/stock.js): how a received line finds its item again.
  key: { type: String, required: true },
  // Keys of items that were combined into this one: goods received under any of those names land here.
  aliases: { type: [String], default: [] },
  supplierIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' }], default: [] },
  // Below this much in the store the item is flagged to be bought. 0 means no level is set.
  reorderLevel: { type: Number, default: 0, min: 0 },
  hsnCode: { type: String, default: '', trim: true, maxlength: 8 },
  notes: { type: String, default: '', trim: true, maxlength: 500 },
  isActive: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true })

inventoryItemSchema.index({ ownerOrgId: 1, key: 1 }, { unique: true })
inventoryItemSchema.index({ ownerOrgId: 1, aliases: 1 })
inventoryItemSchema.index({ ownerOrgId: 1, isActive: 1, category: 1 })

export const InventoryItem = mongoose.model('InventoryItem', inventoryItemSchema)
