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

/**
 * A coordinator's update from the factory floor, to be turned into suggestions for the account manager.
 * `ctx` is what is already known from his taps: the client, the product, its colours, the step he picked and the
 * plan's steps in order (their position is the index to answer with).
 */
export const fieldUpdatePrompt = ctx => `You help a garment sourcing company in India. One of its own quality coordinators is standing in a factory and has sent an update about ONE production step of ONE style. His words may be Hindi, English or a mix, and may have been transcribed from speech, so names and numbers can be garbled. Photos, when attached, may show the work, a defect, or a handwritten paper note: read handwriting when you can.

What is already known (he chose these by tapping, they are certain):
- Client: ${ctx.client || 'unknown'}
- Product: ${ctx.product || 'unknown'}${ctx.styleNumber ? ` (${ctx.styleNumber})` : ''}
- Colours of this style: ${ctx.colours?.length ? ctx.colours.join(', ') : 'not recorded'}
- The step he posted on: index ${ctx.stageIndex}, "${ctx.stageName}"
- The plan's steps, by index: ${ctx.steps.map((s, i) => `${i}="${s.name}" (${s.status}${s.totalUnits ? `, ${s.unitsDone || 0} of ${s.totalUnits} pieces` : ''})`).join('; ')}

Work out what his update means for the plan. Match a garbled colour or step name to the real one above.

Rules:
- units: ONLY a number of pieces that he himself said or wrote as made or completed so far on the step (stitched, cut, packed, received). Pieces he checked, sampled, rejected or found faulty are NOT units: put those in the summary and issues. If he gave no number, units is null, even when he says the step is finished. Never take a number from the plan above (not the planned total, not the pieces already recorded) and never work one out.
- suggested_stage_index: if he names the work of a different step than the one he posted on (for example he posted on Stitching but says cutting is complete), give that other step's index. Fabric, trims or other material that has not arrived belongs to the material or sourcing step, not to dyeing or cutting. Otherwise null.
- status_hint: "started" or "finished" only when he says the step has started or is complete. A count alone is not a status.
- result: only when he reports the outcome of a check or inspection as passed or failed. A problem he noticed while work goes on is an issue, not a fail.
- issues: each separate problem once, short, in plain English. Do not say the same problem twice in different words.
- colours: only colours from the list above that he spoke about, with what he said about each, in plain English.

Return JSON only:
{"summary": "one short plain English sentence of what he reported", "suggested_stage_index": null or the index of a DIFFERENT step this update is clearly about, "units": null or the total pieces done so far on the step that he stated, "status_hint": null or "started" or "finished", "result": null or "pass" or "fail" (only for a check or inspection he reports), "issues": ["each problem he reports, short"], "colours": [{"name": "a colour from the list", "note": "what he said about it"}], "confidence": 0.0-1.0}`

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
