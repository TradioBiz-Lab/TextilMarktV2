// Colourway helpers: a swatch is never blank, and a Pantone reference is tidied and checked, not guessed at.
//
// The swatch of a colourway comes from, in order: the colour someone picked (hex), the nearest known colour for
// its name, and only then a neutral grey. Nearest means a table of apparel colour names (including the fashion ones
// a CSS colour list lacks: camel, marshmallow, salsa, pine, jet), with light/dark style words applied on top.
// It is an approximation for the eye; the factory matches the Pantone reference, not the swatch.

export const NEUTRAL_SWATCH = '#cbd5e1'

// phrase or word -> hex. Longer phrases are tried first.
const COLOURS = {
  // neutrals
  black: '#1a1a1a', 'jet black': '#0a0a0a', jet: '#0a0a0a', white: '#fafafa', 'off white': '#f3eee3', ivory: '#fffff0', cream: '#fff3d6', marshmallow: '#f5eee4', ecru: '#e7dcc3',
  oatmeal: '#d8ccb4', beige: '#d9c4a0', sand: '#d6c3a1', stone: '#b8b2a6', nude: '#d9b8a0', taupe: '#8b7765', grey: '#8a8d8f', gray: '#8a8d8f', charcoal: '#36454f', silver: '#c0c0c0', ash: '#b2b2b2',
  // browns
  brown: '#6b4423', 'camel brown': '#b5835a', camel: '#c19a6b', tan: '#d2b48c', khaki: '#b8a77a', 'coffee brown': '#4b3621', coffee: '#4b3621', mocha: '#6f4e37', chocolate: '#3d2314',
  'dark brown': '#3b2a20', copper: '#b87333', bronze: '#8c6a3a', rust: '#b7410e', terracotta: '#c8553d', cocoa: '#5a3a2a',
  // blues
  blue: '#2f5fa8', sky: '#87ceeb', navy: '#1f2a44', 'navy blue': '#1f2a44', peacoat: '#232f4b', peacot: '#232f4b', royal: '#2b4fb5', denim: '#3b5b8c', 'denim blue': '#3b5b8c', indigo: '#3f3d8b', cobalt: '#1f4fa3',
  teal: '#1f7a7a', turquoise: '#30b8b0', aqua: '#5fd0d0',
  // greens
  green: '#3f8f4f', olive: '#6b6b2e', 'olive green': '#708238', 'pine green': '#1f5a47', pine: '#1f5a47', forest: '#1f5a30', 'pista green': '#93c572', pista: '#93c572', pistachio: '#93c572',
  sage: '#9caf88', mint: '#98d8b8', lime: '#a8d130', emerald: '#1f9d6b', olivine: '#8f9d3a', bottle: '#0b4f3a',
  // warm
  yellow: '#f2c230', mustard: '#d4a017', gold: '#c9a227', orange: '#e8731a', peach: '#f4b98d', coral: '#f26d5b', 'coral pink': '#f4877d',
  red: '#c0262d', 'salsa red': '#c4262e', salsa: '#c4262e', maroon: '#6d1a2a', burgundy: '#6d0f28', wine: '#5e1a2d', brick: '#a0362c',
  // pinks and purples
  pink: '#e88ca5', blush: '#f0c7c7', rose: '#d46a85', fuchsia: '#c2185b', magenta: '#c2268f', purple: '#6b3fa0', lavender: '#b7a3d9', lilac: '#c8a2c8', violet: '#7a4fb5', plum: '#6a2c5a', mauve: '#a77b94',
}

const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
const rgbToHex = c => '#' + c.map(n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('')
const mix = (h, toward, amount) => rgbToHex(hexToRgb(h).map((v, i) => v + (hexToRgb(toward)[i] - v) * amount))
// style words that shift a base colour
const SHADE = { light: ['#ffffff', 0.4], pale: ['#ffffff', 0.6], pastel: ['#ffffff', 0.55], bright: null, dark: ['#000000', 0.35], deep: ['#000000', 0.25], dusty: ['#8a8d8f', 0.3], washed: ['#ffffff', 0.35] }
const PHRASES = Object.keys(COLOURS).filter(k => k.includes(' ')).sort((a, b) => b.length - a.length)

export const isHex = v => /^#[0-9a-fA-F]{6}$/.test(String(v || '').trim())

/** The nearest known colour for a name, or null when nothing in it is recognisable. */
export function nearestColourHex(name) {
  const text = String(name || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!text) return null
  if (COLOURS[text]) return COLOURS[text]
  const words = text.split(' ')
  const shade = words.map(w => SHADE[w]).find(Boolean) || null
  const rest = words.filter(w => !(w in SHADE)).join(' ')
  let base = COLOURS[rest] || null
  if (!base) {
    const phrase = PHRASES.find(p => rest.includes(p))
    if (phrase) base = COLOURS[phrase]
  }
  // otherwise the last recognisable word, since the base colour is usually named last ("Dusty Rose", "Burnt Orange")
  if (!base) for (let i = words.length - 1; i >= 0 && !base; i--) base = COLOURS[words[i]] || null
  if (!base) return null
  return shade ? mix(base, shade[0], shade[1]) : base
}

/** What to paint for a colourway: its picked colour, else the nearest known colour for its name, else a neutral grey. */
export function swatchHex(colourway, cssFallback = () => null) {
  const hex = String(colourway?.hex || '').trim()
  if (isHex(hex)) return hex
  return nearestColourHex(colourway?.name) || cssFallback(colourway?.name) || NEUTRAL_SWATCH
}

// ── Pantone ────────────────────────────────────────────────────────────────
export const PANTONE_HINT = 'Pantone reference for the factory to match: the TCX code from the Pantone Fashion, Home + Interiors book, for example 19-4052 TCX (TPX is the paper edition). It is a reference only; the swatch comes from the colour name unless you pick one.'
export const PANTONE_PLACEHOLDER = 'e.g. 19-4052 TCX'

/**
 * Tidy a typed Pantone reference. Accepts "pantone 19-4052 tcx", "19 4052tcx", "194052 tcx" and the graphics-book
 * style "2728 C". Returns { value, valid }: value is the tidy form when it is recognised, otherwise exactly what was
 * typed (never dropped), and valid says whether it looks like a Pantone code. An empty entry is valid (it is optional).
 */
export function normalisePantone(input) {
  const raw = String(input || '').trim()
  if (!raw) return { value: '', valid: true }
  const t = raw.replace(/^pantone\s*/i, '').replace(/\s+/g, ' ').trim()
  let m = /^(\d{2})[-\s]?(\d{4})\s*(TCX|TPX|TPG|TN|TC)?$/i.exec(t)
  if (m) return { value: `${m[1]}-${m[2]}${m[3] ? ' ' + m[3].toUpperCase() : ''}`, valid: true }
  m = /^(\d{3,4})\s*(C|U|CP|UP)$/i.exec(t)
  if (m) return { value: `${m[1]} ${m[2].toUpperCase()}`, valid: true }
  return { value: raw, valid: false }
}
