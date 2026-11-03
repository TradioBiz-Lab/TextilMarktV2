import { describe, test, expect } from 'vitest'
import { shortenAmazonLink, autoShortenLink } from '../links.js'

describe('the link box shortens a pasted Amazon link', () => {
  test('to the product only', () => {
    expect(autoShortenLink('www.amazon.in/Womens-Dress/dp/B0ABCDEFGH/ref=sr_1_1?th=1')).toBe('https://www.amazon.in/dp/B0ABCDEFGH')
    expect(autoShortenLink('https://www.amazon.in/FYLTR-Womens-Blouson/dp/B0H6N7T7GR/ref=sr_1_2?crid=2SRE&qid=1&sr=1-2')).toBe('https://www.amazon.in/dp/B0H6N7T7GR')
    expect(autoShortenLink('https://www.amazon.in/Title/dp/B0H6N7T7GR?th=1&psc=1')).toBe('https://www.amazon.in/dp/B0H6N7T7GR')
    expect(autoShortenLink('https://www.amazon.com/gp/product/B08N5WRWNW?ref=x')).toBe('https://www.amazon.com/dp/B08N5WRWNW')
  })

  test('and leaves everything else (and half-typed text) as it is', () => {
    for (const same of ['', 'https://www.amaz', 'https://www.amazon.in/s?k=dress', 'https://amzn.in/d/abc', 'https://example.com/dp/B0H6N7T7GR', 'hello ']) expect(autoShortenLink(same)).toBe(same)
    expect(shortenAmazonLink('not a url')).toBe('not a url')
  })
})
