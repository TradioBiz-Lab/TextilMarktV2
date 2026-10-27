import { cleanLink, normalizeCluster, normalizeStatus, normalizePriority, normalizeType, splitCell, splitPhone } from './partners.js'
import { zipContacts } from './partnerImport.js'

// Turns the rows of the two research spreadsheets into partner bodies for scripts/importManufacturers.mjs.
//   Athleisure_LowMOQ_Manufacturer_Plan.xlsx, sheet "Leads"
//   Cocoblu_Vendor_Contacts_Clean.xlsx, sheet "Vendors (deduped)"
// Pure functions over { header: text } rows, so the mapping is tested without the files (tests/partners.seed.test.js).

const text = v => (v === undefined || v === null ? '' : String(v).replace(/\s+/g, ' ').trim())
const NOTHING = /^(not listed|not found|tbd|n\/?a|unknown|-|none)$/i
const clear = v => (NOTHING.test(text(v)) ? '' : text(v))

// Only SPECIALISED products are named, as keywords: generic garments (tees, joggers, dresses) are what the category
// already says. Fabrics stay in their own field.
const SPECIALISED_WORDS = [
  ['sports bras', /sports?[\s-]*bras?|racerback|longline/i], ['leggings', /legging|tights/i], ['thermals', /thermals?/i],
  ['socks', /\bsocks\b/i], ['innerwear', /innerwear|lingerie/i], ['tracksuits', /tracksuits?/i], ['kidswear', /kidswear|babywear/i],
]
const FABRIC_WORDS = [
  ['poly_spandex', /poly(?:ester)?[\s-]*(?:spandex|lycra)/i], ['cotton_lycra', /cotton[\s-]*(?:lycra|spandex)/i],
  ['nylon_spandex', /nylon[\s-]*(?:spandex|lycra)/i], ['bamboo_blend', /bamboo/i],
  ['cotton', /cotton(?![\s-]*(?:lycra|spandex))/i], ['denim', /\bdenim\b/i], ['fleece', /fleece/i], ['jersey', /jersey/i],
]
// Categories are only set where the text says so plainly; fusion is never guessed, and a partner with no clear signal
// is left uncategorised for a person to fill in.
const CATEGORY_WORDS = [
  ['athleisure', /athleisure|activewear|active wear|sportswear|sports wear|gym wear|gymwear|sports?[\s-]*bras?|legging/i],
  ['indian', /\bethnic\b|kurta|kurti|saree|sari\b|lehenga|indian wear|indianwear/i],
  ['western', /western|\bjeans\b|\bdenim\b|\bsuits?\b|waistcoat|formal(?:wear| suits)?|resortwear/i],
  ['home_textiles', /home textile|home furnishing|bed ?sheets?|bed ?linen|\btowels?\b|curtain|cushion|\bquilts?\b/i],
]
export const inferCategories = t => CATEGORY_WORDS.filter(([, re]) => re.test(t)).map(([k]) => k)
export const extractSpecialisedProducts = t => SPECIALISED_WORDS.filter(([, re]) => re.test(t)).map(([k]) => k)
export const extractFabrics = t => FABRIC_WORDS.filter(([, re]) => re.test(t)).map(([k]) => k)

/** Keywords: the specialised products a partner is known for (nothing generic, no city or fabric). */
export const keywordsFor = ({ specialised = [] }) => [...new Set(specialised)]

/** "100 pcs/style" -> { moqPerStyleColour: 100, moqNote: '100 pcs/style' }; "Not listed" and prose are notes only. */
export function parseMoq(raw) {
  const t = text(raw)
  if (!t) return {}
  const m = /^(\d[\d,]*)\s*(?:pcs?|pieces?|units?)\b/i.exec(t)
  return { ...(m ? { moqPerStyleColour: Number(m[1].replace(/,/g, '')) } : {}), moqNote: t }
}

/** A cell that may hold a web address; anything else ("via TradeIndia listing") is not one. */
export const websiteOf = raw => { const t = text(raw); return t && !/\s/.test(t) ? (cleanLink(t) || '') : '' }

const sourceWith = (raw, importedOn) => {
  const t = text(raw)
  if (!t) return `Seed import ${importedOn}`
  return /captured|deduped|\d{4}/i.test(t) ? t : `${t}; imported ${importedOn}`
}

const NOTES = parts => parts.filter(Boolean).join('\n')

/** A "Leads" row of Athleisure_LowMOQ_Manufacturer_Plan.xlsx. null for a row without a company. */
export function leadToPartner(r, { importedOn }) {
  const name = text(r['Company'])
  if (!name) return null
  const capability = clear(r['Products / capability'])
  const city = clear(r['City'])
  const specialised = extractSpecialisedProducts(capability)
  const fabrics = extractFabrics(capability)
  const { phone, whatsapp } = splitPhone(r['Phone'])
  const contacts = zipContacts({
    name: splitCell(clear(r['Contact']), ';'), phone: phone ? [phone] : [], email: splitCell(clear(r['Email']), ';,'), whatsapp: whatsapp ? [whatsapp] : [],
  })
  const cluster = normalizeCluster(r['Cluster'], city)
  const confidence = text(r['Confidence'])
  const next = text(r['Next action'])
  return {
    name, city,
    ...(cluster ? { cluster } : {}),
    type: normalizeType(r['Type']) || 'unknown',
    fabrics,
    categories: inferCategories(capability),
    ...parseMoq(r['MOQ claim (self-reported)']),
    contacts,
    website: websiteOf(r['Website']),
    source: sourceWith(r['Source'], importedOn),
    priority: normalizePriority(r['Priority']) || 'C',
    status: normalizeStatus(r['Status']) || 'new',
    keywords: keywordsFor({ specialised }),
    notes: NOTES([capability, confidence && `Confidence: ${confidence}`, next && `Next action: ${next}`]),
  }
}

/**
 * How a "Category" of Cocoblu_Vendor_Contacts_Clean.xlsx becomes a type. Service providers, brands only and
 * individuals are kept, as type unknown and not active, so they stay on file but out of the default list.
 */
export function vendorCategory(category) {
  const c = text(category)
  if (/service provider/i.test(c)) return { type: 'unknown', isActive: false }
  if (/^individual/i.test(c) || /^brand\b/i.test(c) || /^unknown \(likely brand\)/i.test(c)) return { type: 'unknown', isActive: false }
  if (/leather/i.test(c)) return { type: 'unknown', isActive: true } // a manufacturer, but not of garments
  if (/manufactur/i.test(c)) return { type: 'garment_manufacturer', isActive: true }
  return { type: 'unknown', isActive: true }
}

/** A "Vendors (deduped)" row. Several contacts in one cell (separated by ;) become separate contact entries. */
export function vendorToPartner(r, { importedOn }) {
  let name = text(r['Company'])
  const contactNames = splitCell(clear(r['Contact name(s)']), ';').filter(n => !/^\(.*\)$/.test(n)) // "(info desk)" is no person
  // A row whose company was never identified is filed under the contact's own name rather than as "Not identified".
  if (/^not identified$/i.test(name)) name = contactNames[0] ? `${contactNames[0]} (company not identified)` : ''
  if (!name) return null
  const { type, isActive } = vendorCategory(r['Category'])
  const doing = clear(r['What they do'])
  const city = clear(r['City'])
  const specialised = extractSpecialisedProducts(doing)
  const fabrics = extractFabrics(doing)
  const phones = splitCell(r['Phone(s)'], ';,').map(splitPhone)
  const contacts = zipContacts({
    name: contactNames, email: splitCell(clear(r['Email(s)']), ';,'),
    phone: phones.map(p => p.phone), whatsapp: phones.map(p => p.whatsapp),
  })
  const address = clear(r['Address'])
  const cluster = normalizeCluster('', city)
  const confidence = text(r['Confidence'])
  return {
    name, city, address,
    ...(cluster ? { cluster } : {}),
    type, isActive,
    fabrics, contacts,
    categories: inferCategories(doing),
    website: websiteOf(r['Website']),
    source: `Cocoblu vendor file (Cocoblu_Vendor_Contacts_Clean.xlsx, deduped 27 Oct 2026); ${importedOn}`,
    priority: isActive ? 'C' : 'D',
    status: isActive ? 'new' : 'off_scope',
    keywords: keywordsFor({ specialised }),
    notes: NOTES([doing, `Category: ${text(r['Category'])}`, confidence && `Research confidence: ${confidence}`]),
  }
}
