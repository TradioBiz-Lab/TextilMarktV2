import { describe, test, expect } from 'vitest'
import { fitWithin, jpgName, compressImage } from '../lib/imageCompress.js'

describe('fitWithin', () => {
  test('scales a landscape photo down so the longest edge is the limit', () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 })
  })

  test('scales a portrait photo down by its height', () => {
    expect(fitWithin(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 })
  })

  test('scales a square down', () => {
    expect(fitWithin(2000, 2000, 1600)).toEqual({ width: 1600, height: 1600 })
  })

  test('never scales up', () => {
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 })
    expect(fitWithin(1, 1, 1600)).toEqual({ width: 1, height: 1 })
  })

  test('leaves an image that is exactly at the limit alone', () => {
    expect(fitWithin(1600, 900, 1600)).toEqual({ width: 1600, height: 900 })
  })

  test('rounds to whole pixels', () => {
    // 1000 * 1600 / 1999 = 800.4...
    expect(fitWithin(1999, 1000, 1600)).toEqual({ width: 1600, height: 800 })
    const { width, height } = fitWithin(4032.7, 3024.2, 1600)
    expect(Number.isInteger(width)).toBe(true)
    expect(Number.isInteger(height)).toBe(true)
  })

  test('the longest edge never ends up over the limit', () => {
    for (const [w, h] of [[4032, 3024], [3024, 4032], [5000, 123], [123, 5000], [1601, 1601], [9999, 7777]]) {
      const out = fitWithin(w, h, 1600)
      expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(1600)
    }
  })

  test('keeps the aspect ratio closely', () => {
    const out = fitWithin(4000, 3000, 1000)
    expect(out.width / out.height).toBeCloseTo(4 / 3, 2)
  })

  test('a very thin image keeps at least one pixel on its short side', () => {
    expect(fitWithin(10000, 1, 1600)).toEqual({ width: 1600, height: 1 })
    expect(fitWithin(1, 10000, 1600)).toEqual({ width: 1, height: 1600 })
  })

  test('unusable sizes give zero, an unusable limit means no limit', () => {
    expect(fitWithin(0, 100, 1600)).toEqual({ width: 0, height: 0 })
    expect(fitWithin(100, -5, 1600)).toEqual({ width: 0, height: 0 })
    expect(fitWithin(NaN, 100, 1600)).toEqual({ width: 0, height: 0 })
    expect(fitWithin(undefined, undefined, 1600)).toEqual({ width: 0, height: 0 })
    expect(fitWithin(3000, 2000, 0)).toEqual({ width: 3000, height: 2000 })
    expect(fitWithin(3000, 2000, undefined)).toEqual({ width: 3000, height: 2000 })
    expect(fitWithin(3000, 2000, Infinity)).toEqual({ width: 3000, height: 2000 })
  })
})

describe('jpgName', () => {
  test('swaps the extension for .jpg and keeps the base name', () => {
    expect(jpgName('IMG_0012.PNG')).toBe('IMG_0012.jpg')
    expect(jpgName('scan.final.webp')).toBe('scan.final.jpg')
    expect(jpgName('photo.jpg')).toBe('photo.jpg')
  })

  test('adds .jpg when there is no extension, and copes with no name', () => {
    expect(jpgName('scan')).toBe('scan.jpg')
    expect(jpgName('')).toBe('image.jpg')
    expect(jpgName(undefined)).toBe('image.jpg')
  })
})

// These cases return before any canvas is touched, so they need no browser: the contract is that
// anything that is not a big photo, or that cannot be processed, comes back as the very same file.
describe('compressImage hands the original back', () => {
  const MB = 1024 * 1024

  test('for a file that is not an image', async () => {
    const pdf = { name: 'spec.pdf', type: 'application/pdf', size: 5 * MB }
    expect(await compressImage(pdf)).toBe(pdf)
  })

  test('for an image under the size floor', async () => {
    const small = { name: 'a.jpg', type: 'image/jpeg', size: 300 * 1024 }
    expect(await compressImage(small)).toBe(small)
    const justUnder = { name: 'b.jpg', type: 'image/jpeg', size: 600 * 1024 - 1 }
    expect(await compressImage(justUnder)).toBe(justUnder)
  })

  test('honours a custom size floor', async () => {
    const f = { name: 'a.jpg', type: 'image/jpeg', size: 2 * MB }
    expect(await compressImage(f, { minBytes: 3 * MB })).toBe(f)
  })

  test('for animated or vector images', async () => {
    const gif = { name: 'a.gif', type: 'image/gif', size: 5 * MB }
    const svg = { name: 'a.svg', type: 'image/svg+xml', size: 5 * MB }
    expect(await compressImage(gif)).toBe(gif)
    expect(await compressImage(svg)).toBe(svg)
  })

  test('for nothing at all, or something that is not a file', async () => {
    expect(await compressImage(null)).toBe(null)
    expect(await compressImage(undefined)).toBe(undefined)
    const odd = { type: 42, size: 5 * MB }
    expect(await compressImage(odd)).toBe(odd)
  })

  test('when the image cannot be decoded (no browser here, so decoding throws)', async () => {
    const big = { name: 'big.jpg', type: 'image/jpeg', size: 5 * MB }
    expect(await compressImage(big)).toBe(big)
  })
})
