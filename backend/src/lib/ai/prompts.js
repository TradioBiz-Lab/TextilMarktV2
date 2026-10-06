export const CANONICAL_STAGES = [
  'fabric_sourced', 'fabric_received', 'fabric_inspected', 'cutting', 'stitching',
  'finishing', 'qc', 'packing', 'dispatched',
]

export const PHOTO_PROMPT = `You are a garment production expert looking at a photo sent by a factory in India.
Identify which production stage it shows. Choose one of:
${CANONICAL_STAGES.join(', ')}, unknown.
Note any visible quality issues (shade variation, lines or streaks on fabric, stains, holes, wrong colour, poor stitching).
Return JSON only:
{"stage": "...", "confidence": 0.0-1.0, "issues": ["..."], "description": "one short line", "style_hint": "any visible tag, label or style code, else null"}`

export const DOCUMENT_PROMPT = `This is a production document from an Indian textile or garment factory (challan, invoice, packing list, lab dip card, or similar).
Extract the fields below. Use null if a field is missing. Do not guess.
Return JSON only:
{"doc_type": "...", "party_from": "...", "party_to": "...", "date": "YYYY-MM-DD", "style_codes": ["..."], "items": [{"description": "...", "qty": 0, "unit": "..."}], "implied_stage": "fabric_received | dispatched | ... | null", "confidence": 0.0-1.0}`

export const textPrompt = activeOrders => `This is a message from a garment factory supervisor, possibly in Hindi or Hinglish (transcribed from a voice note).
Active orders for this factory: ${activeOrders.length ? activeOrders.map(o => `${o.styleNumber || o.id} (${o.product})`).join('; ') : 'none listed'}.
Extract every production update mentioned. "stage" must be one of: ${CANONICAL_STAGES.join(', ')}.
Return JSON only:
{"updates": [{"style_hint": "... or null", "stage": "...", "status": "done | in_progress | issue", "expected_date": "YYYY-MM-DD or null", "note": "..."}], "confidence": 0.0-1.0}
Example: "cutting ho gaya, kal se stitching" becomes cutting done, stitching starting tomorrow (in_progress).`
