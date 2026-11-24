// What to do about a step today, said as an instruction a coordinator can act on ("Check if the fabric is in-house"),
// in English and Hindi. Read off the step's name, because the plans name their steps freely (34 names on Live in Nov
// 2026). The first rule that matches wins, so the narrower ones come first. Pure: no React, no network.
const RULES = [
  [/lab\s*dip.*approv/i, { en: 'Ask if the lab dip is approved', hi: 'पूछें कि लैब डिप अप्रूव हुआ या नहीं' }],
  [/lab\s*dip/i, { en: 'Check the lab dip: is it made and sent? Match the shade', hi: 'लैब डिप चेक करें: बना और भेजा गया? शेड मिलाएँ' }],
  [/(fpt|gpt).*approv|test.*approv/i, { en: 'Ask if the test report has passed', hi: 'पूछें कि टेस्ट रिपोर्ट पास हुई या नहीं' }],
  [/\b(fpt|gpt)\b|test/i, { en: 'Check the test sample has gone to the lab', hi: 'चेक करें कि टेस्ट सैंपल लैब गया या नहीं' }],
  [/approv/i, { en: 'Ask if the approval has come. If not, find out what is holding it', hi: 'पूछें कि अप्रूवल आया या नहीं। नहीं आया तो कारण पता करें' }],
  [/fabric.*order/i, { en: 'Check the fabric is ordered and get the arrival date', hi: 'चेक करें कि फ़ैब्रिक का ऑर्डर हुआ, आने की तारीख लें' }],
  [/greige/i, { en: 'Check if the greige fabric is in-house', hi: 'चेक करें कि ग्रे फ़ैब्रिक फ़ैक्टरी में आया या नहीं' }],
  [/dye/i, { en: 'Check dyeing: has it started? Match the shade', hi: 'डाइंग चेक करें: शुरू हुई? शेड मिलाएँ' }],
  [/fabric/i, { en: 'Check if the fabric is in-house. Check the quantity and shade', hi: 'चेक करें कि फ़ैब्रिक फ़ैक्टरी में आया या नहीं। मात्रा और शेड देखें' }],
  [/trim.*order/i, { en: 'Check the trims are ordered and get the arrival date', hi: 'चेक करें कि ट्रिम्स का ऑर्डर हुआ, आने की तारीख लें' }],
  [/trim/i, { en: 'Audit the trims against the BOM', hi: 'बीओएम से मिलाकर ट्रिम्स की जाँच करें' }],
  [/sample|proto|\bpp\b|\bfit\b/i, { en: 'Check the sample: is it ready and sent?', hi: 'सैंपल चेक करें: तैयार है और भेजा गया?' }],
  [/cut/i, { en: 'Check cutting: count the pieces cut', hi: 'कटिंग चेक करें: कटे हुए पीस गिनें' }],
  [/embroid|print/i, { en: 'Check embroidery or print: count pieces and look at quality', hi: 'एम्ब्रॉयडरी या प्रिंट चेक करें: पीस गिनें और क्वालिटी देखें' }],
  [/stitch|sew/i, { en: 'Check stitching on the line: count pieces and look at quality', hi: 'लाइन पर सिलाई चेक करें: पीस गिनें और क्वालिटी देखें' }],
  [/finish|pack/i, { en: 'Check finishing and packing: count the packed pieces', hi: 'फ़िनिशिंग और पैकिंग चेक करें: पैक हुए पीस गिनें' }],
  [/inspect|audit|\bqc\b/i, { en: 'Do the inspection and send photos', hi: 'इंस्पेक्शन करें और फ़ोटो भेजें' }],
  [/production.*start|ready for production/i, { en: 'Check bulk production has started', hi: 'चेक करें कि बल्क प्रोडक्शन शुरू हुआ' }],
  [/production.*end/i, { en: 'Check production is finished: count the pieces', hi: 'चेक करें कि प्रोडक्शन पूरा हुआ: पीस गिनें' }],
  [/production/i, { en: 'Check production: count pieces and look at quality', hi: 'प्रोडक्शन चेक करें: पीस गिनें और क्वालिटी देखें' }],
  [/deliver|dispatch|ship/i, { en: 'Check the goods are packed and ready to dispatch', hi: 'चेक करें कि माल पैक है और डिस्पैच के लिए तैयार है' }],
]
const FALLBACK = { en: name => `Check ${name} and send an update`, hi: name => `${name} चेक करें और अपडेट भेजें` }

/** The instruction for a step, in the coordinator's language ('hi' or 'en'). */
export function stepInstruction(stageName, lang = 'en') {
  const l = lang === 'hi' ? 'hi' : 'en'
  const name = String(stageName || '').trim()
  const hit = RULES.find(([re]) => re.test(name))
  return hit ? hit[1][l] : FALLBACK[l](name || (l === 'hi' ? 'यह स्टेप' : 'this step'))
}
