import { describe, test, expect } from 'vitest'
import { nearestColourHex, swatchHex, normalisePantone, NEUTRAL_SWATCH } from '../colours.js'

const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
const lum = h => { const [r, g, b] = rgb(h); return 0.299 * r + 0.587 * g + 0.114 * b }
const hue = h => { const [r, g, b] = rgb(h).map(v => v / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx === mn) return -1; const d = mx - mn; const x = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (x * 60 + 360) % 360 }

describe('nearest colour for a name', () => {
  test('the Cocoblu colourways all get a real colour, not blank or grey', () => {
    const names = ['Olive', 'Navy', 'Orange', 'Navy Blue', 'Salsa Red', 'Coffee Brown', 'Camel Brown', 'Jet Black', 'Marshmallow', 'Pine Green']
    for (const n of names) { const h = nearestColourHex(n); expect(h, n).toMatch(/^#[0-9a-f]{6}$/); expect(h, n).not.toBe(NEUTRAL_SWATCH) }
  })

  test('the colours land where the eye expects', () => {
    expect(lum(nearestColourHex('Jet Black'))).toBeLessThan(40)
    expect(lum(nearestColourHex('Marshmallow'))).toBeGreaterThan(220)
    const red = hue(nearestColourHex('Salsa Red')); expect(red < 15 || red > 345).toBe(true)
    const green = hue(nearestColourHex('Pine Green')); expect(green).toBeGreaterThan(90); expect(green).toBeLessThan(180)
    const navy = hue(nearestColourHex('Navy Blue')); expect(navy).toBeGreaterThan(200); expect(navy).toBeLessThan(250)
    const camel = hue(nearestColourHex('Camel Brown')); expect(camel).toBeGreaterThan(20); expect(camel).toBeLessThan(45)
  })

  test('style words lighten and darken', () => {
    expect(lum(nearestColourHex('Light Grey'))).toBeGreaterThan(lum(nearestColourHex('Grey')))
    expect(lum(nearestColourHex('Dark Green'))).toBeLessThan(lum(nearestColourHex('Green')))
    expect(nearestColourHex('Dusty Rose')).not.toBe(nearestColourHex('Rose'))
  })

  test('case, punctuation and the base colour named last all work', () => {
    expect(nearestColourHex('  NAVY ')).toBe(nearestColourHex('navy'))
    expect(nearestColourHex('Burnt Orange')).toBe(nearestColourHex('Orange'))
    expect(nearestColourHex('Midnight-Navy!')).toBe(nearestColourHex('navy'))
  })

  test('an unrecognisable name gives null, and the swatch falls back to neutral grey only then', () => {
    expect(nearestColourHex('Zzyzx')).toBeNull()
    expect(nearestColourHex('')).toBeNull()
    expect(swatchHex({ name: 'Zzyzx' })).toBe(NEUTRAL_SWATCH)
    expect(swatchHex({ name: 'Zzyzx' }, () => '#123456')).toBe('#123456')
  })

  test('a picked colour always wins over the name', () => {
    expect(swatchHex({ name: 'Navy', hex: '#ff0000' })).toBe('#ff0000')
    expect(swatchHex({ name: 'Navy', hex: 'not a colour' })).toBe(nearestColourHex('Navy'))
  })
})

describe('Pantone reference', () => {
  test('tidies the usual ways of typing a TCX code', () => {
    for (const t of ['19-4052 TCX', 'pantone 19-4052 tcx', 'PANTONE 19-4052TCX', '19 4052 tcx', '194052 TCX', '  19-4052   Tcx '])
      expect(normalisePantone(t)).toEqual({ value: '19-4052 TCX', valid: true })
  })
  test('accepts TPX, a bare number, and the graphics-book style', () => {
    expect(normalisePantone('17-5641 tpx')).toEqual({ value: '17-5641 TPX', valid: true })
    expect(normalisePantone('19-4052')).toEqual({ value: '19-4052', valid: true })
    expect(normalisePantone('Pantone 2728 c')).toEqual({ value: '2728 C', valid: true })
  })
  test('empty is fine (optional); anything else is kept exactly as typed and flagged', () => {
    expect(normalisePantone('')).toEqual({ value: '', valid: true })
    expect(normalisePantone('   ')).toEqual({ value: '', valid: true })
    expect(normalisePantone('Olive-ish')).toEqual({ value: 'Olive-ish', valid: false })
    expect(normalisePantone('19-405 TCX')).toEqual({ value: '19-405 TCX', valid: false })
  })
})
