// Ready-to-paste image-generator prompts for the Partner Directory tiles. The tiles are generated drawings (a flat drawing of
// the kind of place a partner is), never photos of the partner's own premises, and the prompts are kept stylistically
// uniform so the card grid reads as one set. Nothing here fetches or generates an image.

// One style sentence for every tile, so the grid reads as a set. `primary` is the app's brand colour.
const tileStyle = primary => `simple vector style with soft shading, square 1:1, no text, no logos, no people, consistent muted palette matching ${primary}`

// Three scenes for each kind of partner, so tiles of the same kind do not all show the same room; `w` is " in <city>" or
// empty. The picture a partner gets is picked by its place in the list (see imagePromptFor).
const SCENES = {
  knit: [
    w => `a knitwear factory floor${w}, rows of sewing machines and cutting tables`,
    w => `a knitting and stitching hall${w}, circular knitting machines beside overlock sewing stations`,
    w => `a garment finishing room${w}, folded knit tees and pressing tables`,
  ],
  activewear: [
    w => `an activewear factory floor${w}, flatlock sewing lines under bright overhead lights`,
    w => `an activewear cutting room${w}, stretch fabric laid out on a long cutting table`,
    w => `an athleisure sewing line${w}, finished tops and bottoms moving along the line`,
  ],
  woven: [
    w => `a woven garment factory floor${w}, long sewing lines and fabric bundles`,
    w => `a cutting room${w} with rolls of woven fabric and pattern pieces on a long table`,
    w => `a shirt and dress stitching hall${w}, rows of single-needle machines`,
  ],
  fabric_supplier: [
    w => `stacked rolls of fabric in a textile warehouse${w}`,
    w => `a fabric mill${w} with colourful rolls on tall racks`,
    w => `a swatch room${w} with fabric samples hanging on a wall rail`,
  ],
  trims_supplier: [
    w => `buttons, zippers, drawcords and woven labels arranged in a neat flat lay${w ? `, a trims market${w}` : ''}`,
    w => `a trims counter${w} with small drawers of buttons and spools of thread`,
    w => `rolls of elastic, zip tapes and label sheets on a workbench${w}`,
  ],
  dyer_processor: [
    w => `a dye house${w} with fabric on rollers and dye vats`,
    w => `a processing plant${w} with long fabric running through finishing machines`,
    w => `hanks of freshly dyed fabric drying on tall racks${w}`,
  ],
  trader: [
    w => `a trading office${w} with garment samples on racks and folded stacks`,
    w => `a sample room${w} with a long table of folded garments`,
    w => `a small warehouse${w} with cartons and a packing table`,
  ],
  buying_house: [
    w => `a sourcing office${w} with garment samples on a long table and racks`,
    w => `a merchandising desk${w} with tech packs, swatches and sample garments`,
    w => `a buying house showroom${w} with garments on rails`,
  ],
  unknown: [
    w => `an apparel industry building${w} with a sewing floor visible through large windows`,
    w => `a garment unit${w} seen from the street, with a sewing floor behind the windows`,
    w => `an apparel workshop${w} with a few sewing machines and fabric bundles`,
  ],
}

// Details drawn into the scene from what the partner is known for, so a sports-bra unit does not look like a denim one.
const CATEGORY_HINTS = {
  athleisure: 'stretch fabric and activewear samples',
  indian: 'embroidered ethnic panels and draped fabric',
  western: 'western casual garments on racks',
  fusion: 'indo-western garments mixing prints and cuts',
  home_textiles: 'folded bed linen and towels',
}
const KEYWORD_HINTS = [
  [/sports bra/i, 'sports bras on a rack'], [/legging/i, 'leggings on hangers'], [/thermal/i, 'thermal tops'],
  [/socks/i, 'socks coming off a knitting line'], [/innerwear/i, 'packs of innerwear'], [/tracksuit/i, 'tracksuits on hangers'],
  [/kidswear/i, 'small kids garments'],
]

// How the picture is framed, and the base colour it sits on. Orange (the brand colour) stays the accent in every one.
const VIEWS = ['seen from a high angle', 'straight-on front view', 'isometric cutaway view', 'wide view down a long aisle', 'close crop on one work table', 'side elevation with large windows', 'view through a doorway']
const TONES = ['warm cream', 'soft grey', 'pale sage', 'light sand', 'dusty blue-grey', 'pale peach']

const ACTIVEWEAR = new Set(['leggings', 'sports_bra', 'jogger', 'shorts', 'tracksuit'])

/** The scene key for a partner: garment units split into activewear, woven (Indian wear, or woven in the notes) and knit. */
function sceneKey(p) {
  if (p.type !== 'garment_manufacturer') return SCENES[p.type] ? p.type : 'unknown'
  const cats = p.categories || []
  if (cats.includes('athleisure') || (p.products || []).some(x => ACTIVEWEAR.has(x))) return 'activewear'
  if (cats.includes('indian') || /woven/i.test(`${p.notes || ''} ${(p.keywords || []).join(' ')}`)) return 'woven'
  return 'knit'
}

const CLUSTER_LABEL = { ludhiana: 'Ludhiana', ncr: 'Delhi NCR', jaipur: 'Jaipur', kolkata: 'Kolkata', tiruppur: 'Tiruppur' }

/** The place named in a prompt: the city without its bracketed area, else the cluster, else nothing. */
export function placeFor(p) {
  const city = String(p.city || '').replace(/\(.*?\)/g, '').replace(/[;/].*$/, '').replace(/\s+/g, ' ').trim()
  return city || CLUSTER_LABEL[p.cluster] || ''
}

const hashOf = text => { let h = 0; for (const ch of String(text || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h }

/** Up to two details for the scene: what the partner is known for (specialised keywords first, then its categories). */
function hintsFor(p) {
  const found = KEYWORD_HINTS.filter(([re]) => (p.keywords || []).some(k => re.test(k))).map(([, h]) => h)
  const cats = (p.categories || []).map(c => CATEGORY_HINTS[c]).filter(Boolean)
  return [...new Set([...found, ...cats])].slice(0, 2)
}

/**
 * One prompt for one partner. `primary` is the app's brand colour (T.primary in frontend/src/constants.js). The style
 * sentence is the same for every tile; the scene, the framing and the base colour change from one partner to the next.
 * `n` is the partner's place in the list being made (so a whole batch is all different); without it the name decides.
 */
export function imagePromptFor(p, primary, n = hashOf(p.name) % 126) {
  const place = placeFor(p)
  const scene = SCENES[sceneKey(p)][n % 3](place ? ` in ${place}` : '')
  const hints = hintsFor(p)
  const view = VIEWS[Math.floor(n / 3) % VIEWS.length]
  // Chosen so the first ~40 partners all differ in (scene, framing, base colour) and every scene meets every colour.
  const tone = TONES[(Math.floor(n / 3) * 5 + n + Math.floor(n / 21)) % TONES.length]
  return `flat illustrative tile of ${scene}${hints.length ? `, with ${hints.join(' and ')}` : ''}, ${view}, ${tone} base colours, ${tileStyle(primary)}`
}

/** "Dossil Fashions Pvt Ltd" -> "dossil-fashions-pvt-ltd": the file name to save the generated tile under. */
export const tileFileName = name => `${String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'partner'}.png`

const TYPE_LABEL = {
  garment_manufacturer: 'garment manufacturer', fabric_supplier: 'fabric supplier', trims_supplier: 'trims supplier',
  dyer_processor: 'dyer/processor', trader: 'trader', buying_house: 'buying house', unknown: 'type unknown',
}

/**
 * The report: one line per partner. `redo` is for making every tile again (they all looked alike); otherwise it lists
 * the partners that still have no tile.
 */
export function imageReportMarkdown(partners, { primary, generatedOn, redo = false }) {
  const rows = partners.map((p, i) => {
    const place = placeFor(p)
    return `- **${p.name}** | ${TYPE_LABEL[p.type] || p.type} | ${place || 'city unknown'} | save as \`${tileFileName(p.name)}\`\n  \`${imagePromptFor(p, primary, i)}\``
  })
  return [
    redo ? '# Partner tiles: redo, all partners' : '# Partners needing images',
    '',
    redo
      ? `Generated ${generatedOn}. ${partners.length} partner${partners.length === 1 ? '' : 's'}. The first set looked too alike, so every prompt below names a different room, framing and base colour (and what the partner is known for).`
      : `Generated ${generatedOn}. ${partners.length} partner${partners.length === 1 ? '' : 's'} have no tile yet.`,
    '',
    'Paste each prompt into the image generator, save the result under the file name shown, then upload it on the partner\'s page (Partners, open the partner, "Upload image"). The tiles are generated drawings, not photos of the factory.',
    '',
    `All prompts end with the same style sentence (${tileStyle(primary)}) so the grid still looks like a set. Do not use photos or logos taken from a partner's website.`,
    '',
    ...rows,
    '',
  ].join('\n')
}

/**
 * Pairs generated tile files with partners by the file name the report asked for (tileFileName). A file matches on its
 * name without the extension, whatever the extension (png, jpg, webp).
 * @returns {{ matched: {file, partner}[], unmatchedFiles: string[], partnersWithoutFile: object[] }}
 */
export function matchTileFiles(files, partners) {
  const byStem = new Map(partners.map(p => [tileFileName(p.name).replace(/\.png$/, ''), p]))
  const matched = []
  const unmatchedFiles = []
  const used = new Set()
  for (const file of [...files].sort()) {
    const stem = file.replace(/\.(png|jpe?g|webp)$/i, '').toLowerCase()
    const partner = byStem.get(stem)
    if (partner && !used.has(stem)) { matched.push({ file, partner }); used.add(stem) } else unmatchedFiles.push(file)
  }
  return { matched, unmatchedFiles, partnersWithoutFile: partners.filter(p => !used.has(tileFileName(p.name).replace(/\.png$/, ''))) }
}

/**
 * Adds partners to an existing image report (the markdown text), in the same line format and prompt style. A partner already
 * in the report is skipped. Prompts are numbered on from the lines already there, so the new tiles differ from the old ones
 * and from each other. Returns { md, added } where added is the names appended.
 */
export function appendToImageReport(md, partners, { primary }) {
  const have = new Set([...md.matchAll(/^- \*\*(.+?)\*\* \|/gm)].map(m => m[1]))
  const fresh = partners.filter(p => !have.has(p.name))
  if (fresh.length === 0) return { md, added: [] }
  const offset = have.size
  const lines = fresh.map((p, i) => {
    const place = placeFor(p)
    return `- **${p.name}** | ${TYPE_LABEL[p.type] || p.type} | ${place || 'city unknown'} | save as \`${tileFileName(p.name)}\`\n  \`${imagePromptFor(p, primary, offset + i)}\``
  })
  const total = have.size + fresh.length
  const body = md.replace(/(\d+) partners? (have|has) no tile yet\./, `${total} partner${total === 1 ? '' : 's'} ${total === 1 ? 'has' : 'have'} no tile yet.`)
  return { md: `${body.replace(/\n*$/, '')}\n${lines.join('\n')}\n`, added: fresh.map(p => p.name) }
}
