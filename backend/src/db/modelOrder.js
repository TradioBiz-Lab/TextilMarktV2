// Builds the complete document set, stage evidence and floor-message trail for
// the delivered "model" demo order (Baggy Active Jacket). All files are
// generated dummies: PDFs from pdfLite, lab dip cards from demo-images, plus a
// CSV measurement sheet and a tiny DXF pattern.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Document } from '../models/Document.js'
import { InboundMessage } from '../models/InboundMessage.js'
import { makePdf } from './pdfLite.js'
import { DEFAULT_STAGE_NAMES } from '../models/Order.js'

const IMG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'demo-images')
const URL_ = (buf, mime) => `data:${mime};base64,${buf.toString('base64')}`
const DOCS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'demo-docs')
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const inr = n => 'INR ' + n.toLocaleString('en-IN')

export async function seedModelOrder({ orderId, qty, buyer, mfr, admin, day, startOffset, slug = 'baggy-active-jacket' }) {
  const stageEnd = i => day(startOffset + i * 6 + 4)          // when stage i finished
  const at = dayStr => new Date(dayStr + 'T11:00:00+05:30')
  await Document.deleteMany({ orderId })
  await InboundMessage.deleteMany({ orderId })

  const rows = []
  const add = ({ type, name, by, stageIndex = null, issued, ext = 'pdf', content, mime, mfrScoped = false, notes = null, sourceMessageId = null, issuer = null }) => {
    const buf = content == null ? null : Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const m = mime || ({ pdf: 'application/pdf', jpg: 'image/jpeg', csv: 'text/csv', dxf: 'application/octet-stream' })[ext]
    rows.push({
      type, name, orderId, stageIndex, mfrId: mfrScoped ? mfr._id : null, uploadedBy: by._id, issuer,
      issueDate: at(issued), notes, sourceMessageId,
      dataUrl: buf ? URL_(buf, m) : null,
      fileName: buf ? `${name.replace(/[^A-Za-z0-9]+/g, '_')}.${ext}` : null,
      fileSize: buf ? buf.length : null, mimeType: buf ? m : null,
    })
  }
  const pdf = (title, lines, sub = 'Aero Active  |  Style AER-BAJ-02 Baggy Active Jacket  |  Order ' + orderId) => makePdf({ title, subtitle: sub, lines })
  const d0 = day(startOffset - 12)   // order-level paperwork predates the first stage

  // ── Order-level documents ──
  add({ type: 'RFQ', name: 'RFQ - Baggy Active Jacket', by: buyer, issued: day(startOffset - 25), issuer: 'Aero Active', content: pdf('Request for Quotation', [
    '# Request', 'Buyer: Aero Active', 'Style: AER-BAJ-02 Baggy Active Jacket (unisex, relaxed fit)', `Quantity: ${qty} pcs (Olive Green 480, Black 320)`,
    'Season: SS27     Target delivery: within 90 days of PO', '', '# Please quote', '- FOB/ex-works price per piece, fabric and trims breakup', '- Lead time from lab dip approval', '- MOQ and wastage assumption', '', '# Reference', 'Tech pack and measurement sheet attached separately.']) })
  add({ type: 'buyer_order', name: 'Purchase Order AER-PO-2027-014', by: buyer, issued: d0, issuer: 'Aero Active', content: pdf('Purchase Order  AER-PO-2027-014', [
    '# Parties', 'Buyer : Aero Active', 'Vendor: NCR Active Unit (via Tradio)', '', '# Line items',
    'Style        Description             Qty   Unit price     Amount', `AER-BAJ-02    Baggy Active Jacket     ${String(qty).padStart(3)}   ${inr(1120).padEnd(12)}   ${inr(qty * 1120)}`, '',
    '  Olive Green  480 pcs   |   Black  320 pcs   |   Sizes S-XL, ratio 2:3:3:2', '', '# Terms', `Total value: ${inr(qty * 1120)}`, 'Payment: 30% advance, 70% against dispatch documents', 'Delivery: ex-factory, 90 days from PO', 'Packing: individual polybag, 20 pcs per carton', '', 'Authorised signatory: Aero Active Sourcing']) })
  add({ type: 'PO', name: 'Purchase Order AER-PO-2027-014 (Tradio acknowledgement)', by: admin, issued: d0, issuer: 'Tradio', content: pdf('Order Acknowledgement', ['# Confirmed', `PO AER-PO-2027-014 accepted for ${qty} pcs of AER-BAJ-02.`, 'Assigned manufacturer: NCR Active Unit', 'Planned dispatch window: see TNA.']) })
  const ref = f => fs.readFileSync(path.join(DOCS_DIR, f))
  add({ type: 'tech_pack', name: 'Tech Pack - Baggy Active Jacket', by: buyer, issued: day(startOffset - 20), issuer: 'Aero Active', content: ref(`techpack-${slug}.pdf`) })
  add({ type: 'measurements', name: 'Measurement Spec - Baggy Active Jacket', by: buyer, issued: day(startOffset - 20), issuer: 'Aero Active', ext: 'xlsx', mime: XLSX_MIME, content: ref(`measurements-${slug}.xlsx`) })
  const dxf = ['0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nSECTION\n2\nENTITIES']
  const poly = (pts, layer) => dxf.push(`0\nLWPOLYLINE\n8\n${layer}\n90\n${pts.length}\n70\n1\n` + pts.map(([x, y]) => `10\n${x}\n20\n${y}`).join('\n'))
  poly([[0, 0], [62, 0], [62, 72], [0, 72]], 'FRONT'); poly([[70, 0], [132, 0], [132, 72], [70, 72]], 'BACK'); poly([[140, 0], [210, 0], [205, 66], [145, 66]], 'SLEEVE'); poly([[220, 0], [258, 0], [258, 37], [220, 37]], 'HOOD')
  dxf.push('0\nENDSEC\n0\nEOF')
  add({ type: 'pattern', name: 'Pattern - Baggy Active Jacket (size M)', by: mfr, issued: day(startOffset - 8), ext: 'dxf', mfrScoped: true, issuer: 'NCR Active Unit', content: dxf.join('\n') + '\n' })
  const fabricCost = 372, trims = 96, cmt = 310, overhead = 70, margin = 120, total = fabricCost + trims + cmt + overhead + margin
  add({ type: 'cost_sheet', name: 'Finalized Cost Sheet', by: admin, issued: day(startOffset - 14), issuer: 'Tradio', content: pdf('Finalized Cost Sheet  AER-BAJ-02', [
    '# Per piece (INR)', `Shell fabric (1.55 m @ 240 + 8% wastage)   ${String(fabricCost).padStart(6)}`, `Trims (zip, cord, labels, polybag)          ${String(trims).padStart(6)}`, `CMT (cut, make, trim)                       ${String(cmt).padStart(6)}`,
    `Overheads and finance                        ${String(overhead).padStart(6)}`, `Manufacturer margin                          ${String(margin).padStart(6)}`, `------------------------------------------------`, `FOB price per piece                          ${String(total).padStart(6)}`, '',
    '# Order', `Quantity ${qty} pcs   |   Order value ${inr(qty * total)}`, 'Approved by Tradio and shared with buyer.']) })
  add({ type: 'terms', name: 'Commercial Terms', by: admin, issued: d0, issuer: 'Tradio', content: pdf('Commercial Terms', ['# Payment', '30% advance, 70% against dispatch documents.', '', '# Quality', 'AQL 2.5 general inspection level II. Rejections reworked at vendor cost.', '', '# Delay', '0.5% of order value per week of delay beyond the confirmed dispatch date, capped at 5%.']) })
  add({ type: 'test_report', name: 'Lab Test Report - Colour Fastness, Shrinkage, Pilling', by: mfr, issued: stageEnd(5), mfrScoped: true, issuer: 'Textile Testing Lab, Delhi', content: pdf('Lab Test Report', [
    '# Tests (bulk fabric, both colourways)', 'Test                              Standard        Result      Requirement', 'Colour fastness to wash            ISO 105-C06     4-5         >= 4', 'Colour fastness to rubbing (dry)  ISO 105-X12     4-5         >= 4', 'Colour fastness to rubbing (wet)  ISO 105-X12     4           >= 3-4',
    'Dimensional change, warp          ISO 5077        -1.2 %      +/- 3 %', 'Dimensional change, weft          ISO 5077        -0.8 %      +/- 3 %', 'Pilling (2000 rev)                ISO 12945-2     4-5         >= 4', 'Water repellency (DWR)           AATCC 22        80          >= 70', '', 'Overall: PASS']) })

  // ── Stage evidence ──
  const olive = fs.readFileSync(path.join(IMG_DIR, 'labdip-olive-green.jpg')), black = fs.readFileSync(path.join(IMG_DIR, 'labdip-black.jpg'))
  add({ type: 'lab_dip', name: 'Lab Dip Approval - Olive Green', by: buyer, stageIndex: 0, issued: stageEnd(0), ext: 'jpg', content: olive, mfrScoped: true, issuer: 'Aero Active' })
  add({ type: 'lab_dip', name: 'Lab Dip Approval - Black', by: buyer, stageIndex: 0, issued: stageEnd(0), ext: 'jpg', content: black, mfrScoped: true, issuer: 'Aero Active' })
  add({ type: 'test_report', name: 'PP Sample Approval Report', by: buyer, stageIndex: 1, issued: stageEnd(1), mfrScoped: true, issuer: 'Aero Active', content: pdf('PP Sample Approval', ['# Result: APPROVED with comments', 'Fit: approved on size M and L.', 'Comments: raise hood height by 1 cm; reinforce zip bottom with bartack.', 'Comments closed in bulk cutting pattern v2.']) })
  add({ type: 'material_po', name: 'Fabric PO - Surat Technical Fabrics', by: admin, stageIndex: 2, issued: day(startOffset + 12 - 4), mfrScoped: true, issuer: 'Tradio', content: pdf('Material Purchase Order  PO-AER-BAJ-01', ['# Supplier: Surat Technical Fabrics', `Nylon-poly stretch woven 135 GSM, 150 cm width: ${Math.round(qty * 1.55 * 1.08)} m`, `Rate INR 240 per m   |   Value ${inr(Math.round(qty * 1.55 * 1.08 * 240))}`, 'Delivery to NCR Active Unit within 10 days.']) })
  add({ type: 'material_po', name: 'Trims PO - Trims Hub', by: admin, stageIndex: 2, issued: day(startOffset + 12 - 3), mfrScoped: true, issuer: 'Tradio', content: pdf('Trims Purchase Order  PO-AER-BAJ-02', ['# Supplier: Trims Hub', `#5 coil zips with auto-lock: ${qty + 40} pcs`, `Drawcords with metal tips: ${qty + 40} sets`, `Main, care and size labels: ${qty + 80} sets`, 'Delivery within 7 days.']) })
  const qc = (title, rows_, verdict = 'PASS') => pdf(title, ['# Findings', ...rows_, '', `# Overall: ${verdict}`, 'Inspector: NCR Active Unit QA     Verified by: Tradio coordinator'])
  add({ type: 'knitting_grn', name: 'Fabric Goods Receipt Note', by: mfr, stageIndex: 3, issued: stageEnd(3), mfrScoped: true, issuer: 'NCR Active Unit', content: qc('Goods Receipt Note', ['Fabric received against PO-AER-BAJ-01', `Quantity received: ${Math.round(qty * 1.55 * 1.08)} m in 24 rolls`, 'Packing condition: good, no damaged rolls']) })
  add({ type: 'knitting_qc', name: 'Fabric 4-Point Inspection Report', by: mfr, stageIndex: 3, issued: stageEnd(3), mfrScoped: true, issuer: 'NCR Active Unit', content: qc('4-Point Fabric Inspection', ['Rolls inspected: 24 of 24', 'Average points per 100 sq yd: 14 (limit 28)', 'Defects found: 3 minor slubs, marked and cut around']) })
  add({ type: 'dyeing_grn', name: 'Dye Lot Goods Receipt Note', by: mfr, stageIndex: 4, issued: stageEnd(4), mfrScoped: true, issuer: 'NCR Active Unit', content: qc('Dye Lot Receipt', ['Lot OLV-0412 (Olive Green) and BLK-0413 (Black) received from processor', 'Lot sizes match cutting plan']) })
  add({ type: 'dyeing_qc', name: 'Shade Approval Report', by: mfr, stageIndex: 4, issued: stageEnd(4), mfrScoped: true, issuer: 'NCR Active Unit', content: qc('Shade Approval', ['Olive Green: Delta E 0.7 vs approved standard', 'Black: Delta E 0.4 vs approved standard', 'Shade band within lot: A (consistent)']) })
  add({ type: 'processing_grn', name: 'Finished Fabric Receipt Note', by: mfr, stageIndex: 5, issued: stageEnd(5), mfrScoped: true, issuer: 'NCR Active Unit', content: qc('Finished Fabric Receipt', ['Fabric returned after DWR finish and heat setting', 'Width after finish: 148 cm (spec 147-150)']) })
  add({ type: 'processing_qc', name: 'Shrinkage and Hand-feel Test', by: mfr, stageIndex: 5, issued: stageEnd(5), mfrScoped: true, issuer: 'NCR Active Unit', content: qc('Shrinkage and Hand-feel', ['Shrinkage after 3 washes: warp -1.2 %, weft -0.8 %', 'DWR spray rating: 80', 'Hand-feel: soft, matches approved swatch']) })
  add({ type: 'cutting_qc', name: 'Cutting QC Report', by: mfr, stageIndex: 6, issued: stageEnd(6), mfrScoped: true, issuer: 'NCR Active Unit', content: qc('Cutting QC', [`Lay count: 40 lays x 20 plies; ${qty} pcs cut`, 'Pattern v2 used (hood height +1 cm applied)', 'Matching of panels: pass     Bundle ticketing: pass']) })
  add({ type: 'stitching_qc', name: 'Inline Stitching QC Report', by: mfr, stageIndex: 7, issued: stageEnd(7), mfrScoped: true, issuer: 'NCR Active Unit', content: qc('Inline Stitching QC', ['Lines audited: 3 of 3, four rounds', 'Stitch density 12 SPI: pass     Zip alignment: pass', 'Defect rate (DHU): 3.1 % first round, 1.4 % final round', 'Bartack at zip bottom added per PP comments']) })
  add({ type: 'packing_qc', name: 'Packing QC and Carton Spec', by: mfr, stageIndex: 9, issued: stageEnd(9), mfrScoped: true, issuer: 'NCR Active Unit', content: qc('Packing QC', [`Cartons: ${Math.ceil(qty / 20)} x 20 pcs`, 'Polybag, size sticker and hangtag per tech pack', 'Carton marking and gross weight recorded']) })
  add({ type: 'final_qc', name: 'Final Inspection Report (AQL 2.5)', by: admin, stageIndex: 10, issued: stageEnd(10), issuer: 'Tradio', content: qc('Final Inspection', [`Lot size ${qty} pcs, sample 80 pcs (AQL 2.5, level II)`, 'Critical: 0     Major: 2 (accept up to 5)     Minor: 5 (accept up to 7)', 'Measurements within tolerance on all points', 'Wash and rub test on sample: pass'], 'PASS - released for dispatch') })
  add({ type: 'dispatch_docs', name: 'Commercial Invoice', by: mfr, stageIndex: 11, issued: stageEnd(11), mfrScoped: true, issuer: 'NCR Active Unit', content: pdf('Commercial Invoice  INV-NCR-2027-031', ['# Bill to: Aero Active', `Baggy Active Jacket AER-BAJ-02, ${qty} pcs @ ${inr(total)} = ${inr(qty * total)}`, 'Payment terms: balance 70% against this invoice']) })
  add({ type: 'dispatch_docs', name: 'Packing List', by: mfr, stageIndex: 11, issued: stageEnd(11), mfrScoped: true, issuer: 'NCR Active Unit', content: pdf('Packing List', [`Cartons ${Math.ceil(qty / 20)}   |   Pieces ${qty}`, 'Olive Green 480 pcs (24 cartons)   |   Black 320 pcs (16 cartons)', 'Gross weight approx 612 kg   |   Net weight approx 548 kg']) })
  add({ type: 'dispatch_docs', name: 'Delivery Challan and LR Copy', by: mfr, stageIndex: 11, issued: stageEnd(11), mfrScoped: true, issuer: 'NCR Active Unit', content: pdf('Delivery Challan / Lorry Receipt', ['Carrier: Delhivery Freight     LR No: DLV-88421907', 'From: NCR Active Unit    To: Aero Active warehouse, Bhiwandi', `Cartons: ${Math.ceil(qty / 20)}     Delivered and signed by consignee`]) })

  // ── Floor messages (the zero-entry trail): text updates, each filed as stage evidence ──
  const floor = [
    [6, 'cutting ho gaya, 800 piece cut ready', 'Cutting completed, 800 pcs'],
    [7, 'stitching poori ho gayi, teeno line complete', 'Stitching completed on all lines'],
    [8, 'finishing aur pressing complete', 'Finishing and pressing completed'],
    [9, 'packing ho gayi, 40 carton ready', 'Packing completed, 40 cartons'],
    [11, 'maal nikal gaya, truck dispatch ho gaya', 'Dispatched'],
  ]
  for (const [si, text, note] of floor) {
    const when = at(stageEnd(si))
    const m = await InboundMessage.create({
      factoryId: mfr._id, senderNumber: mfr.whatsappNumber, channel: 'whatsapp', type: 'text', rawText: text, receivedAt: when,
      parsed: { updates: [{ style_hint: 'AER-BAJ-02', stage: ['cutting', 'stitching', 'finishing', 'packing', 'dispatched'][floor.findIndex(f => f[0] === si)], status: 'done', expected_date: null, note }], confidence: 0.93 },
      confidence: 0.93, orderId, stageApplied: DEFAULT_STAGE_NAMES[si], state: 'applied', createdAt: when, updatedAt: when,
    })
    add({ type: 'floor_evidence', name: `Floor update`, by: mfr, stageIndex: si, issued: stageEnd(si), mfrScoped: true, issuer: 'Auto-captured from WhatsApp text', notes: `${text}\n${note}`, sourceMessageId: m._id })
  }

  await Document.insertMany(rows.map(r => ({ ...r, version: 1, isActive: true, createdAt: r.issueDate, updatedAt: r.issueDate })))
  return rows.length
}
