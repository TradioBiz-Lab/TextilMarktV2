// The Tradio mark as plain data. No React and no imports, so anything can use it: the logo
// components (components/Brand.jsx), the favicon (public/favicon.svg is this markup), and later the
// backend's PDF and email headers, which can copy this file as it is. Keep the geometry here and
// nowhere else.
//
// Geometry is the website's app/icon.svg: a 100 x 100 navy tile with rounded corners and an orange
// T built from two bars (a crossbar and a stem).

export const BRAND_NAVY = '#1D2D50'
export const BRAND_ORANGE = '#C4622D'

// Unit of the drawing: every number below is in these 100 x 100 units.
export const MARK_SIZE = 100

export const MARK_GEOMETRY = Object.freeze({
  tile: Object.freeze({ width: 100, height: 100, rx: 20 }),
  bars: Object.freeze([
    Object.freeze({ x: 24, y: 24, width: 52, height: 13, rx: 2 }), // crossbar of the T
    Object.freeze({ x: 43.5, y: 24, width: 13, height: 52, rx: 2 }), // stem of the T
  ]),
})

const attrs = o => Object.entries(o).map(([k, v]) => `${k}="${v}"`).join(' ')

/**
 * The mark as an SVG markup string. `size` is the rendered width and height in px (the drawing
 * always scales from its 100 x 100 viewBox). `tile` and `bar` override the two colours for the
 * odd one-colour context, such as a grayscale PDF.
 */
export function markSvg({ size = MARK_SIZE, tile = BRAND_NAVY, bar = BRAND_ORANGE } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${MARK_SIZE} ${MARK_SIZE}">`
    + `<rect ${attrs(MARK_GEOMETRY.tile)} fill="${tile}"/>`
    + MARK_GEOMETRY.bars.map(b => `<rect ${attrs(b)} fill="${bar}"/>`).join('')
    + '</svg>'
}

/** The mark at its natural 100 x 100 size, in brand colours. Same drawing as the website's icon.svg. */
export const MARK_SVG = markSvg()
