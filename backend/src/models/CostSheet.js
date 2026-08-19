import mongoose from 'mongoose'

// Fields taken directly from a real cost sheet (Tradio Costing/Fitleasure - Core/
// tradio_core_costing_final.xlsx, "Cost Sheet Core Series"), not invented. One
// CostSheet = one style/VAN-No column. Structure, exactly as the real sheet has it:
//
//   RAW MATERIAL
//     Fabric                          <- consumption x rate
//     Process (Branding/Elastics/…)   <- subtotal of an open detail block
//     Trims                           <- subtotal of an open detail block
//     Labels/Tags + Packaging         <- subtotal of an open detail block
//     Raw Material Total              <- sum
//   LABOUR
//     Cutting & Threads / Making / Finishing & Packing
//     Labour Total                    <- sum
//   Total Labour & Raw Material       <- Raw Material Total + Labour Total
//   Overhead (Factory) @5% / Rejection @3%   <- % of the line above
//   Margin (Factory) / Tradio fee     <- master-admin only
//   Price / Final negotiated Price / Percentage
//
// The three Raw Material sub-lines are each backed by their own open-ended detail
// block (real styles vary wildly here — a fleece style has "Cord Elastic", a
// t-shirt has none) — those stay arrays. Everything else above is fixed, matching
// the real template. All totals are COMPUTED, never stored — see the exported
// helpers below, same "derive, don't duplicate" discipline this codebase already
// applies to stageEtaVarianceDays/deliveryVarianceDays in Order.js.
const costSheetSchema = new mongoose.Schema({
  scopeType: { type: String, enum: ['tradio_order', 'mfr_project'], required: true },
  orderId:      { type: String, ref: 'Order', default: null },
  mfrProjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'MfrProject', default: null },
  // Required, never null — even a master-authored split-order sheet names the
  // manufacturer it's authored on behalf of. A nullable mfrId would collide the
  // same way the discriminator fields would without the partial indexes below.
  mfrId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  styleRef: { type: String, default: '' }, // VAN No. equivalent

  // Only meaningful for tradio_order — TRADIO.md's fabric-risk-ownership rule.
  // 'manufacturer' is a third real case (not in the original TRADIO.md rule,
  // which only names Tradio-supplied vs buyer-supplied): the manufacturer
  // sources/buys the fabric themselves, on their own account — Tradio bears
  // no consumption risk here either, same as 'buyer', but it's tracked as its
  // own value since the manufacturer (not the buyer) is the counterparty who
  // sourced it — matters for who the fabric supplier relationship belongs to.
  fabricSource: { type: String, enum: ['tradio', 'buyer', 'manufacturer'], default: null },
  currency: { type: String, default: 'INR' },

  status: { type: String, enum: ['draft', 'submitted', 'approved'], default: 'draft' },
  // For mfr_project scope, submitted/approved are the manufacturer's own
  // self-actions — there's no Tradio party in a non-Tradio deal, so no
  // master-admin step exists for that scope. Same enum either way so every
  // other route/UI works unmodified; only who may call submit/approve differs.
  submittedAt: { type: Date, default: null }, submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  approvedAt:  { type: Date, default: null }, approvedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // ── Manufacturer-writable content, while draft (or master, any time) ──────
  fabric: {
    name: { type: String, default: '' }, unit: { type: String, default: '' },
    consumption: { type: Number, default: null }, rate: { type: Number, default: null },
    supplier: { type: String, default: '' },
    // Cutting-wastage gross-up, per-fabric (not sheet-level — overhead/rejection
    // stay sheet-level, but wastage is specific to how efficiently THIS fabric
    // cuts). `consumption` stays the stated NET per-garment figure; wastage
    // grosses it up before costing — see fabricGrossConsumption below.
    wastagePct: { type: Number, default: 0, min: 0 },
    // Provenance back-reference stamped by "pull from requirement" — values stay
    // frozen copies, this only records where they came from so the consumption
    // sanity-check has a join key to compare against.
    materialRequirementId:     { type: mongoose.Schema.Types.ObjectId, ref: 'MaterialRequirement', default: null },
    materialRequirementLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  process:         [{ label: { type: String, required: true }, supplier: { type: String, default: '' }, value: { type: Number, required: true, min: 0 } }],
  trims:           [{ label: { type: String, required: true }, supplier: { type: String, default: '' }, value: { type: Number, required: true, min: 0 } }],
  labelsPackaging: [{ label: { type: String, required: true }, supplier: { type: String, default: '' }, value: { type: Number, required: true, min: 0 } }],
  // Open-ended escape hatch — anything the fixed rows above don't cover (a
  // testing fee, embroidery, a one-off charge). Rolls into Raw Material Total
  // or Labour Total per its group, same as the fixed detail blocks.
  extraLines: [{
    group: { type: String, enum: ['material', 'labour'], required: true },
    label: { type: String, required: true },
    supplier: { type: String, default: '' },
    value: { type: Number, required: true, min: 0 },
  }],
  labour: {
    cuttingThreads:   { type: Number, default: 0, min: 0 },
    making:           { type: Number, default: 0, min: 0 },
    finishingPacking: { type: Number, default: 0, min: 0 },
  },
  overheadPct: { type: Number, default: 5 },
  rejectionPct: { type: Number, default: 3 },

  // ── Manufacturer's own margin — content field like overheadPct/rejectionPct
  // above (NOT master-only, unlike the Tradio margin/fee block below). On a
  // Tradio order this is the manufacturer's own sell-to-Tradio margin; Tradio's
  // marginPct/tradioFeePct then compute on top of the manufacturer's full price
  // (baseCost + this), not just their raw cost — confirmed directly: mirrors how
  // a real buying house prices on top of a supplier's quote. On mfr_project
  // scope (no Tradio party at all) this is simply the manufacturer's own final
  // margin — baseCost + this IS the final price, full stop. ──
  mfrMarginPct: { type: Number, default: null },

  // ── Master-admin only, always — tradio_order scope ONLY. Always null/hidden
  // for mfr_project (there's no Tradio fee or negotiated price on a
  // manufacturer's own non-Tradio business). ──
  marginPct:             { type: Number, default: null }, // "Margin (Factory)"
  tradioFeePct:          { type: Number, default: null }, // 10, tradio_order only
  finalNegotiatedPrice:  { type: Number, default: null },
  negotiatedDiscountPct: { type: Number, default: null }, // the real sheet's "Percentage" row

  // ── Actuals — manufacturer-writable via their own route (POST /:id/actuals),
  // valid at submitted AND approved, exempt from the submit content-lock.
  // Feeds ConsumptionRecord (moat) and InventoryMovement (out). ──
  actualFabricConsumption: { type: Number, default: null },
  actualLabourCost:        { type: Number, default: null },
  actualRejectionValue:    { type: Number, default: null },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true })

// Unique PARTIAL indexes — not plain compound indexes. orderId/mfrProjectId are
// `default: null`, and MongoDB indexes null as a real value, so a plain compound
// index would key every one of a manufacturer's tradio_order sheets as
// (tradio_order, null, mfrId) and throw E11000 on their second sheet.
costSheetSchema.index(
  { scopeType: 1, orderId: 1, mfrId: 1 },
  { unique: true, partialFilterExpression: { scopeType: 'tradio_order' } }
)
costSheetSchema.index(
  { scopeType: 1, mfrProjectId: 1, mfrId: 1 },
  { unique: true, partialFilterExpression: { scopeType: 'mfr_project' } }
)

export const CostSheet = mongoose.model('CostSheet', costSheetSchema)

// ── Computed totals — never stored, always derived, matching this file's own
// header comment and the Order.js precedent (stageEtaVarianceDays etc). ──────

const sumValues = arr => (arr || []).reduce((sum, l) => sum + (l.value || 0), 0)
const sumExtra = (sheet, group) => (sheet.extraLines || []).filter(l => l.group === group).reduce((sum, l) => sum + (l.value || 0), 0)

// Grossed-up consumption after wastage — consumption stays the NET stated
// figure, this is what actually gets ordered/costed. null (not 0) when
// consumption itself isn't set, so fabricValue below can tell "no fabric
// entered yet" apart from "entered as zero."
export function fabricGrossConsumption(sheet) {
  const c = sheet?.fabric?.consumption
  if (typeof c !== 'number') return null
  return c * (1 + (sheet?.fabric?.wastagePct || 0) / 100)
}

export function fabricValue(sheet) {
  const gross = fabricGrossConsumption(sheet), r = sheet?.fabric?.rate
  return (typeof gross === 'number' && typeof r === 'number') ? gross * r : 0
}

export function rawMaterialTotal(sheet) {
  return fabricValue(sheet) + sumValues(sheet.process) + sumValues(sheet.trims) + sumValues(sheet.labelsPackaging) + sumExtra(sheet, 'material')
}

export function labourTotal(sheet) {
  const l = sheet.labour || {}
  return (l.cuttingThreads || 0) + (l.making || 0) + (l.finishingPacking || 0) + sumExtra(sheet, 'labour')
}

export function totalLabourAndRawMaterial(sheet) {
  return rawMaterialTotal(sheet) + labourTotal(sheet)
}

export function overheadValue(sheet) {
  return totalLabourAndRawMaterial(sheet) * ((sheet.overheadPct ?? 0) / 100)
}

export function rejectionValue(sheet) {
  return totalLabourAndRawMaterial(sheet) * ((sheet.rejectionPct ?? 0) / 100)
}

// The manufacturer's own raw production cost — labour + materials + overhead
// + rejection. Visible to the owning manufacturer and admin (not master-only,
// unlike everything below this point).
export function baseCost(sheet) {
  return totalLabourAndRawMaterial(sheet) + overheadValue(sheet) + rejectionValue(sheet)
}

// The manufacturer's own margin on top of their raw cost — content, not
// master-only. null when the manufacturer hasn't set one yet.
export function mfrMarginValue(sheet) {
  if (sheet.mfrMarginPct == null) return null
  return baseCost(sheet) * (sheet.mfrMarginPct / 100)
}

// baseCost + the manufacturer's own margin — their sell-to-Tradio price on a
// Tradio order, or simply their final price on their own mfr_project work.
export function mfrSellPrice(sheet) {
  const mv = mfrMarginValue(sheet)
  return mv == null ? null : baseCost(sheet) + mv
}

// Everything from here down is master-admin-only content — computed here so the
// route layer never has to re-derive the margin math, but callers (enrichCostSheet)
// must strip these outputs for manufacturer/buyer viewers, not just the source
// fields they're computed from.
//
// Tradio's margin/fee compute on the manufacturer's FULL submitted price
// (mfrSellPrice), not just their raw cost — confirmed directly: Tradio earns
// a cut of the manufacturer's own markup too, same as a real buying house
// pricing on top of a supplier's quote. Falls back to baseCost when the
// manufacturer hasn't set mfrMarginPct — every sheet that predates this
// field (or simply hasn't been priced by the manufacturer yet) computes
// exactly as it always did, zero migration needed.
function priceBase(sheet) {
  return mfrSellPrice(sheet) ?? baseCost(sheet)
}

export function marginValue(sheet) {
  if (sheet.marginPct == null) return null
  return priceBase(sheet) * (sheet.marginPct / 100)
}

export function tradioFeeValue(sheet) {
  if (sheet.tradioFeePct == null) return null
  return priceBase(sheet) * (sheet.tradioFeePct / 100)
}

export function priceValue(sheet) {
  const margin = marginValue(sheet), fee = tradioFeeValue(sheet)
  if (margin == null || fee == null) return null
  return priceBase(sheet) + margin + fee
}
