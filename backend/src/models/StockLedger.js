import mongoose from 'mongoose'

export const LEDGER_TYPES = ['receipt', 'issue', 'return', 'adjustment', 'jobwork_out', 'jobwork_in']
export const STORE = 'store'

// Every movement of stock, one row each, never edited or deleted: a mistake is put right by another
// row (an adjustment). A balance is the sum of `qty` over an item's rows at a location, so the ledger
// can always explain it. `qty` is signed: positive adds to the location's balance, negative takes away.
//
// `location` is 'store' (the factory's own) or 'jw:<supplierId>' (stock held by a job worker: a dyer,
// printer or embroiderer it was sent to, still the factory's).
//
// `key` makes a write safe to repeat: posting a goods receipt twice (a retry after a crash) writes each
// line's row once, because the second insert hits the unique index.
const stockLedgerSchema = new mongoose.Schema({
  ownerOrgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
  location: { type: String, default: STORE, maxlength: 40 },
  type: { type: String, enum: LEDGER_TYPES, required: true },
  qty: { type: Number, required: true },
  unit: { type: String, default: 'pcs', maxlength: 20 },
  // What one unit cost when it came in (receipts only): the base of any later valuation.
  unitCost: { type: Number, default: 0, min: 0 },
  refType: { type: String, enum: ['grn', 'issue', 'adjustment', 'jobwork'], required: true },
  refId: { type: String, required: true },
  refLineId: { type: String, default: '' },
  // The order the stock was used on (issues and returns).
  orderId: { type: String, default: null },
  note: { type: String, default: '', maxlength: 300 },
  at: { type: Date, default: Date.now },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  key: { type: String, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } })

stockLedgerSchema.index({ ownerOrgId: 1, key: 1 }, { unique: true })
stockLedgerSchema.index({ ownerOrgId: 1, itemId: 1, location: 1 })
stockLedgerSchema.index({ ownerOrgId: 1, orderId: 1 })
stockLedgerSchema.index({ ownerOrgId: 1, refType: 1, refId: 1 })

export const StockLedger = mongoose.model('StockLedger', stockLedgerSchema)
