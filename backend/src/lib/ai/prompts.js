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

/**
 * A quality person has measured one garment and read the measurements aloud, naming each point and then its number.
 * The transcript comes from speech recognition, in English, Hindi or a mix, so names are shortened or garbled and
 * numbers are spoken many ways. The model places each number against the right point of the sheet and returns nothing
 * it was not told.
 */
export const measurementsPrompt = ({ transcript, points, unit }) => `You help a garment quality checker in India. He has measured ONE garment with a tape and read his measurements aloud, one point of measure at a time: first the name of the point, then the number he measured. Below is the transcript of his speech (from speech recognition, so it has mistakes) and the list of points on the style's measurement sheet.

Points on the sheet, in order. "required" is the value the sheet asks for in the size he is measuring${unit === 'cm' ? ' (centimetres)' : ' (usually inches; eighths are written as decimals, 3.625 is 3 and 5/8)'}:
${points.map((p, i) => `${i}. ${p.name}${p.spec != null ? `  [required ${p.spec}]` : ''}`).join('\n')}

Transcript:
<<<
${String(transcript || '').slice(0, 6000)}
>>>

Your job: for each measurement he spoke, find the point he meant and give the number he said.

Matching the point:
- He says short forms, not the sheet's full wording: "chest" for "CHEST 1 INCH BELOW ARMHOLE ALL AROUND", "shoulder" for "SHOULDER SEAM TO SEAM", "CB length" or "length" for a centre back length, "bicep", "cuff", "neck drop front". Hindi words are common: "chhaati" or "seena" chest, "kandha" shoulder, "lambai" length, "aasteen" or "baaju" sleeve, "kamar" waist, "gala" neck, "mohri" bottom or leg opening, "jeb" pocket.
- He usually goes down the sheet in order. Use the order to choose between two points with similar names, but never shift everything by one because he skipped a point.
- If two points fit equally well and the order does not settle it, do not guess: put it under "unmatched".

Reading the number:
- Give a decimal number. Halves, quarters and eighths in any form: "sixteen and a half" 16.5, "16 1/2" 16.5, "sixteen point five" 16.5, "three quarter" 0.75, "five eighths" 0.625, "three by eight" 0.375, "seventeen one by four" 17.25.
- Hindi: "saadhe solah" 16.5, "sava solah" 16.25, "paune satrah" 16.75, "dedh" 1.5, "dhai" 2.5, "aadha" 0.5, "paav" 0.25, "pauna" 0.75.
- He gives the MEASURED value, not the difference. If he says a point is "ok", "correct", "theek hai" or "same" with no number, the measured value is the required value of that point.
- If he says only the difference ("chest minus half", "half inch kam", "quarter zyada"), the measured value is the required value minus or plus that amount.
- The required value is there to help you hear the number right (to tell 16 from 60, 13 from 30). A value more than a third away from the required value is probably misheard: still return what he most plausibly said, and say what you heard in "heard".
- People correct themselves while speaking. The corrected number is the one that counts, and the number before it is thrown away, never added to it and never given to the next point. Words that mean "that was wrong": "no", "no no", "sorry", "wait", "I mean", "correction", "cancel", "not that", and in Hindi "nahin", "nahi", "nahin nahin", "na na", "galat", "ruko", "matlab", "arre". Examples: "chest 15, nahin nahin, 14.5" is chest 14.5. "shoulder 18, sorry, 18 and a half" is shoulder 18.5. "waist 42, galat, saadhe ikyalis" is waist 41.5. "sleeve 25, no wait 26" is sleeve 26.
- A correction can also change the point: "chest 43, nahin, woh waist tha" means 43 is the waist and nothing was said for the chest.
- If he gives the same point twice with no correction word, keep the last one.
- Never invent a value for a point he did not mention. Leave unmentioned points out of "values".

Return ONLY a JSON object, no other text:
{"values": [{"index": the number of the point in the list above, "value": the measured number as a decimal, "heard": the few words of the transcript this came from}], "unmatched": [{"heard": the words of a measurement you could not place, "value": the number if you could read one, else null}]}`

/**
 * The same job from a photo: a quality person measured one garment and wrote the numbers on paper. The paper may be a
 * printout of the sheet with numbers written beside the points, or a plain page of point names and numbers, or just
 * numbers. Handwriting, abbreviations, Hindi and English, strike-throughs.
 */
export const measurementPhotoPrompt = ({ points, unit }) => `You help a garment quality checker in India. He measured ONE garment with a tape and wrote the measurements by hand on paper. The photo(s) show that paper. Below is the list of points on the style's measurement sheet.

Points on the sheet, in order. "required" is the value the sheet asks for in the size he measured${unit === 'cm' ? ' (centimetres)' : ' (usually inches; eighths are written as decimals, 3.625 is 3 and 5/8)'}:
${points.map((p, i) => `${i}. ${p.name}${p.spec != null ? `  [required ${p.spec}]` : ''}`).join('\n')}

Your job: read every measurement he wrote and place it against the point he meant.

What the paper may look like:
- A printed copy of the measurement sheet with his numbers handwritten in a column or beside the size he measured. Read the handwritten numbers, not the printed ones.
- A plain page with a list: a point name (often shortened: "chest", "sh", "CB len", "slv", "bicep", "cuff", or Hindi words such as "chhaati", "kandha", "lambai", "aasteen", "kamar", "gala", "mohri") and a number.
- Numbered lines (1, 2, 3...) that follow the order of the sheet. A line number is not a measurement.
- Only numbers with no names. Place them in the sheet's order ONLY if there are exactly as many numbers as points. Otherwise put them under "unmatched".

Reading the number:
- Give a decimal number. Fractions are written many ways: "16 1/2", "16½", "16-1/2", "16.5", "3/8", "16 3/4". 16 1/2 is 16.5, 3/8 is 0.375, 16 3/4 is 16.75.
- A number that is struck through is cancelled: use the number written beside or above it. If the same point has two numbers and one is clearly the correction, use the correction.
- "ok", "OK", a tick mark or "same" with no number means the measured value equals the required value of that point.
- A number written with a plus or minus sign ("-1/4", "+0.5"), or one far smaller than the required value where a full measurement is expected (required 43, written 0.5), is a difference: the measured value is the required value plus or minus it.
- The required value is there to help you read unclear handwriting (to tell 1 from 7, 4 from 9, 16 from 18). If a digit is unclear, choose the reading closest to the required value and say what you saw in "heard".
- If you cannot read a number with reasonable confidence, do not guess: put it under "unmatched" with what you could see.
- Never invent a value for a point that is not on the paper. Leave those points out of "values".
- Ignore everything that is not a measurement: the style name, the date, a signature, the size, page numbers, tolerance columns, printed required values.

Return ONLY a JSON object, no other text:
{"values": [{"index": the number of the point in the list above, "value": the measured number as a decimal, "heard": what was written on the paper for it}], "unmatched": [{"heard": what was written that you could not place or read, "value": the number if you could read one, else null}]}`

