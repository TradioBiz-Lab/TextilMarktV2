import { CostSheet, ConsumptionRecord, InventoryMovement, Order } from '../db/index.js'

// Phase 4 of the Materials Management + Costing Engine plan — the strategic
// moat TRADIO.md names explicitly. Hooked into the existing assignment-status
// route (orders.js) whenever status is set to 'Delivered'. Deliberately
// Tradio-brokered-only — never called for an MfrProject, which has no
// assignments/status to trigger on in the first place.
//
// Idempotent by design: this can run every time an assignment is (re-)marked
// Delivered without duplicating anything, via upserts keyed on the same
// fields as each model's own unique index.
export async function captureConsumptionOnDelivery(orderId, mfrId) {
  const sheet = await CostSheet.findOne({ scopeType: 'tradio_order', orderId, mfrId }).lean()
  if (!sheet) return // no cost sheet authored yet — nothing to capture

  const order = await Order.findById(orderId).lean()
  const assignment = (order?.assignments || []).find(a => String(a.mfrId) === String(mfrId))
  if (!assignment) return
  const unitsProduced = assignment.qty || 0

  // Source of truth: the manufacturer's own entered actual. Fallback: sum
  // receivedQty across this assignment's fabric-category stage material
  // lines ÷ units produced — so the row is never simply empty even if the
  // manufacturer never opened the Costing actuals screen.
  let actualConsumptionPerUnit = sheet.actualFabricConsumption
  if (actualConsumptionPerUnit == null && unitsProduced > 0) {
    const receivedFabric = (assignment.stages || [])
      .flatMap(s => s.materials || [])
      .filter(m => m.category === 'fabric')
      .reduce((sum, m) => sum + (m.receivedQty || 0), 0)
    if (receivedFabric > 0) actualConsumptionPerUnit = receivedFabric / unitsProduced
  }

  await ConsumptionRecord.findOneAndUpdate(
    { orderId, mfrId, costSheetId: sheet._id },
    {
      $set: {
        orderRef: orderId, capturedAt: new Date(), trigger: 'assignment_delivered',
        garmentType: order?.category || '', fabricSource: sheet.fabricSource || null,
        unit: sheet.fabric?.unit || 'm',
        plannedConsumptionPerUnit: sheet.fabric?.consumption ?? null,
        actualConsumptionPerUnit: actualConsumptionPerUnit ?? null,
        totalUnitsProduced: unitsProduced,
        totalActualConsumption: actualConsumptionPerUnit != null ? actualConsumptionPerUnit * unitsProduced : null,
        variancePct: (sheet.fabric?.consumption && actualConsumptionPerUnit != null)
          ? Math.round(((actualConsumptionPerUnit - sheet.fabric.consumption) / sheet.fabric.consumption) * 1000) / 10
          : null,
        materialRequirementLineId: sheet.fabric?.materialRequirementLineId || null,
      },
    },
    { upsert: true }
  )

  // InventoryMovement 'out' — written from exactly this one place, never also
  // from the actuals-save route, so one physical consumption event never
  // double-books. Upsert on the same key as the model's own partial index.
  if (actualConsumptionPerUnit != null && unitsProduced > 0) {
    await InventoryMovement.findOneAndUpdate(
      { sourceType: 'consumption', 'sourceRef.costSheetId': sheet._id, direction: 'out' },
      {
        $set: {
          mfrId, materialName: sheet.fabric?.name || 'Fabric', qty: actualConsumptionPerUnit * unitsProduced,
          unit: sheet.fabric?.unit || 'm', scopeType: 'tradio_order', orderId, orderRef: orderId,
          occurredAt: new Date(),
        },
      },
      { upsert: true }
    )
  }
}
