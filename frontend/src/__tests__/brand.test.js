import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BRAND_NAVY, BRAND_ORANGE, MARK_GEOMETRY, MARK_SVG, markSvg } from '../brandMark.js'
import { Logo, LogoMark, BRAND_NAVY as NAVY_FROM_BRAND, MARK_SVG as SVG_FROM_BRAND } from '../components/Brand.jsx'
import { T } from '../constants.js'

// The mark exists in three places: brandMark.js (what the React logo and the backend use), the
// favicon file, and the website's icon.svg. These tests keep the first two from drifting apart.
const squash = svg => svg.replace(/>\s+</g, '><').trim()

describe('brand mark', () => {
  test('the brand colours are the website colours, and the theme uses the same ones', () => {
    expect(BRAND_NAVY).toBe('#1D2D50')
    expect(BRAND_ORANGE).toBe('#C4622D')
    expect(T.brandNavy).toBe(BRAND_NAVY)
    expect(T.brandOrange).toBe(BRAND_ORANGE)
  })

  test('the geometry is the website icon: a rounded tile and a T made of two bars', () => {
    expect(MARK_GEOMETRY.tile).toEqual({ width: 100, height: 100, rx: 20 })
    expect(MARK_GEOMETRY.bars).toEqual([
      { x: 24, y: 24, width: 52, height: 13, rx: 2 },
      { x: 43.5, y: 24, width: 13, height: 52, rx: 2 },
    ])
  })

  test('the markup is exactly the website icon.svg', () => {
    expect(MARK_SVG).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">'
      + '<rect width="100" height="100" rx="20" fill="#1D2D50"/>'
      + '<rect x="24" y="24" width="52" height="13" rx="2" fill="#C4622D"/>'
      + '<rect x="43.5" y="24" width="13" height="52" rx="2" fill="#C4622D"/>'
      + '</svg>',
    )
  })

  test('public/favicon.svg is the same drawing', () => {
    const favicon = readFileSync(new URL('../../public/favicon.svg', import.meta.url), 'utf8')
    expect(squash(favicon)).toBe(MARK_SVG)
  })

  test('markSvg sizes the output and can recolour it, always on the 100 unit drawing', () => {
    const small = markSvg({ size: 32 })
    expect(small).toContain('width="32" height="32" viewBox="0 0 100 100"')
    const mono = markSvg({ tile: '#000', bar: '#fff' })
    expect(mono).toContain('fill="#000"')
    expect(mono).toContain('fill="#fff"')
    expect(mono).not.toContain(BRAND_NAVY)
  })

  test('the markup has no script, style or external reference, so it is safe to inline in email and PDF', () => {
    expect(MARK_SVG).not.toMatch(/<script|<style|href=|url\(|on\w+=/i)
  })
})

describe('Logo and LogoMark', () => {
  const html = el => renderToStaticMarkup(el)

  test('Brand.jsx re-exports the plain constants, so there is one place to import the brand from', () => {
    expect(NAVY_FROM_BRAND).toBe(BRAND_NAVY)
    expect(SVG_FROM_BRAND).toBe(MARK_SVG)
  })

  test('LogoMark draws the tile and both bars of the T at the size asked for', () => {
    const out = html(createElement(LogoMark, { size: 40 }))
    expect(out).toContain('width="40"')
    expect(out).toContain('viewBox="0 0 100 100"')
    expect(out.match(/<rect/g)).toHaveLength(3)
    expect(out).toContain(`fill="${BRAND_NAVY}"`)
    expect(out.match(new RegExp(`fill="${BRAND_ORANGE}"`, 'g'))).toHaveLength(2)
    expect(out).toContain('aria-hidden="true"') // decorative unless it is given a title
  })

  test('LogoMark with a title is a named image; on dark it gains a ring around the tile', () => {
    expect(html(createElement(LogoMark, { title: 'Tradio' }))).toContain('role="img"')
    expect(html(createElement(LogoMark, { onDark: true })).match(/<rect/g)).toHaveLength(4)
  })

  test('the full logo has the mark, the name and the by Tradio line', () => {
    const out = html(createElement(Logo, null))
    expect(out).toContain('TextilMarkt')
    expect(out).toContain('by Tradio')
    expect(out).toContain('brand-text')
    expect(out).toContain('<svg')
    expect(out).toContain(`color:${BRAND_NAVY}`) // navy name on a light surface
  })

  test('on a dark surface the name is white', () => {
    expect(html(createElement(Logo, { onDark: true }))).toContain('color:#FFFFFF')
  })

  test('the compact logo is the mark alone, named for screen readers', () => {
    const out = html(createElement(Logo, { variant: 'compact' }))
    expect(out).not.toContain('TextilMarkt</span>')
    expect(out).not.toContain('brand-text')
    expect(out).toContain('aria-label="TextilMarkt by Tradio"')
    expect(out.match(/<svg/g)).toHaveLength(1)
  })

  test('the name and caption scale with the mark', () => {
    const small = html(createElement(Logo, { size: 28 }))
    const large = html(createElement(Logo, { size: 44 }))
    expect(small).toContain('font-size:15px') // 28 * 0.54
    expect(large).toContain('font-size:24px') // 44 * 0.54
  })

  test('uses a class hook for the header to hide the name on very narrow screens', () => {
    expect(html(createElement(Logo, { className: 'header-x' }))).toContain('class="brand-logo header-x"')
  })
})
