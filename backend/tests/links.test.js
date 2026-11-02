// A pasted Amazon product link is saved in its short form, wherever it is entered (create, edit, import, a copied replen).

import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeLink, shortenAmazonLink, cleanLink } from '../src/lib/links.js'

const SHORT = 'https://www.amazon.in/dp/B0H6N7T7GR'

describe('shortening an Amazon link', () => {
  test('keeps only the product: title, tracking and the colour picked are dropped', () => {
    for (const long of [
      'https://www.amazon.in/FYLTR-Womens-Blouson-Sleeves-Button/dp/B0H6N7T7GR/ref=sr_1_2?crid=2SRE6I39S0FTK&dib=eyJ2IjoiMSJ9&dib_tag=se&keywords=FYLSS26WD-4002&qid=1792737069&s=apparel&sprefix=fylss26wd-400%2Capparel%2C288&sr=1-2',
      'https://www.amazon.in/FYLTR-Womens-Solid-Midi-Dress/dp/B0H6N7T7GR?th=1&psc=1',
      'https://amazon.in/dp/B0H6N7T7GR/',
      'http://www.amazon.in/gp/product/B0H6N7T7GR?ref=x',
      'https://m.amazon.in/dp/b0h6n7t7gr',
      'https://www.amazon.in/gp/aw/d/B0H6N7T7GR/',
      '  https://www.amazon.in/some-title/dp/B0H6N7T7GR/ref=sr_1_6  ',
      'amazon.in/some-title/dp/B0H6N7T7GR/ref=sr_1_6?psc=1',
    ]) assert.equal(normalizeLink(long), SHORT, long)
  })

  test('keeps the Amazon site: .com, .co.uk and .de stay as they are', () => {
    assert.equal(normalizeLink('https://www.amazon.com/Some-Title/dp/B08N5WRWNW/ref=x'), 'https://www.amazon.com/dp/B08N5WRWNW')
    assert.equal(normalizeLink('https://www.amazon.co.uk/Title/dp/B08N5WRWNW?th=1'), 'https://www.amazon.co.uk/dp/B08N5WRWNW')
    assert.equal(normalizeLink('https://www.amazon.de/Titel/dp/B08N5WRWNW'), 'https://www.amazon.de/dp/B08N5WRWNW')
  })

  test('leaves anything that is not an Amazon product page exactly as it was', () => {
    for (const same of [
      'https://www.amazon.in/s?k=fyltr+dress',
      'https://www.amazon.in/stores/FYLTR/page/ABC',
      'https://amzn.in/d/abc123',
      'https://example.com/dp/B0H6N7T7GR',
      'https://notamazon.in/dp/B0H6N7T7GR',
      'https://www.amazon.in.evil.com/dp/B0H6N7T7GR',
      'https://drive.example.com/tp/1',
      'https://www.amazon.in/dp/TOOSHORT',
    ]) assert.equal(normalizeLink(same), same, same)
  })

  test('a link that is not a web address is still refused, and a blank one is allowed', () => {
    assert.match(cleanLink('javascript:alert(1)', 'Link').error, /http/)
    assert.deepEqual(cleanLink('', 'Link'), { link: '' })
    assert.equal(cleanLink('https://www.amazon.in/Title/dp/B0H6N7T7GR?th=1', 'Link').link, SHORT)
    assert.equal(shortenAmazonLink('not a url'), 'not a url')
  })
})
