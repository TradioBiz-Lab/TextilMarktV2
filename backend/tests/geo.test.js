import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseMapsLocation, distanceM, isAway, cleanPoint, dayIST, startOfDayIST, mapsUrlFor } from '../src/lib/geo.js'

describe('reading a pasted location', () => {
  test('a plain pair, with a comma or a space', () => {
    assert.deepEqual(parseMapsLocation('26.9124, 75.7873'), { lat: 26.9124, lng: 75.7873, mapsUrl: mapsUrlFor(26.9124, 75.7873) })
    assert.equal(parseMapsLocation(' 26.9124 75.7873 ').lng, 75.7873)
    assert.equal(parseMapsLocation('-33.8688,151.2093').lat, -33.8688)
  })
  test('the shapes of a full Google Maps link', () => {
    assert.equal(parseMapsLocation('https://www.google.com/maps/place/Neobrands/@26.85,75.80,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d26.851234!4d75.805678').lat, 26.851234, 'the place pin wins over the view centre')
    assert.deepEqual([parseMapsLocation('https://www.google.com/maps/@26.85,75.8,17z').lat, parseMapsLocation('https://www.google.com/maps/@26.85,75.8,17z').lng], [26.85, 75.8])
    assert.equal(parseMapsLocation('https://www.google.com/maps?q=26.9,75.7').lng, 75.7)
    assert.equal(parseMapsLocation('https://maps.google.com/?q=loc:26.9,75.7&z=15').lat, 26.9)
    assert.equal(parseMapsLocation('https://www.google.com/maps/search/?api=1&query=26.9%2C75.7').lng, 75.7)
  })
  test('the stored link is built from the coordinates, never the pasted text', () => {
    const r = parseMapsLocation('https://evil.example/@26.9,75.7')
    assert.equal(r.mapsUrl, 'https://www.google.com/maps?q=26.9,75.7')
  })
  test('nothing, a short link and nonsense', () => {
    assert.equal(parseMapsLocation(''), null)
    assert.equal(parseMapsLocation(undefined), null)
    assert.match(parseMapsLocation('https://maps.app.goo.gl/AbCdEf123').error, /short Maps link/)
    assert.match(parseMapsLocation('https://www.google.com/maps/place/Jaipur').error, /No location found/)
    assert.ok(parseMapsLocation('Sitapura, Jaipur').error)
    assert.ok(parseMapsLocation('126.9, 75.7').error)
    assert.ok(parseMapsLocation(12).error)
    assert.ok(parseMapsLocation('https://www.google.com/maps/@26.9,75.7,' + '1'.repeat(3000)).error)
  })
})

describe('distance and the away mark', () => {
  test('haversine against known distances', () => {
    assert.equal(distanceM({ lat: 26.9, lng: 75.8 }, { lat: 26.9, lng: 75.8 }), 0)
    const jaipurDelhi = distanceM({ lat: 26.9124, lng: 75.7873 }, { lat: 28.6139, lng: 77.2090 })
    assert.ok(jaipurDelhi > 230000 && jaipurDelhi < 245000, String(jaipurDelhi))
    const oneHundredMetres = distanceM({ lat: 26.9, lng: 75.8 }, { lat: 26.9009, lng: 75.8 })
    assert.ok(oneHundredMetres > 95 && oneHundredMetres < 105, String(oneHundredMetres))
    assert.equal(distanceM(null, { lat: 1, lng: 1 }), null)
  })
  test('away only beyond 300 m plus the reading\'s own accuracy; unknown distance is never away', () => {
    assert.equal(isAway({ distanceM: 250, accuracy: 20 }), false)
    assert.equal(isAway({ distanceM: 380, accuracy: 100 }), false)
    assert.equal(isAway({ distanceM: 420, accuracy: 100 }), true)
    assert.equal(isAway({ distanceM: null, accuracy: 10 }), false)
  })
})

describe('what a phone sends with a tap', () => {
  test('location is required and must be real', () => {
    assert.equal(cleanPoint({}).code, 'LOCATION_REQUIRED')
    assert.equal(cleanPoint({ lat: '26.9', lng: 75.8 }).code, 'LOCATION_REQUIRED')
    assert.equal(cleanPoint({ lat: 95, lng: 75.8 }).code, 'LOCATION_REQUIRED')
    assert.ok(cleanPoint({ lat: 26.9, lng: 75.8, accuracy: -1 }).error)
    assert.ok(cleanPoint({ lat: 26.9, lng: 75.8, deviceAt: 'yesterday' }).error)
    const ok = cleanPoint({ lat: 26.91234567, lng: 75.8, accuracy: 18.4, deviceAt: '2026-11-23T05:12:00.000Z' })
    assert.deepEqual(ok.point, { lat: 26.912346, lng: 75.8, accuracy: 18, deviceAt: new Date('2026-11-23T05:12:00.000Z') })
  })
  test('days are days in India', () => {
    assert.equal(dayIST(new Date('2026-11-23T19:00:00.000Z')), '2026-11-24')
    assert.equal(startOfDayIST('2026-11-24').toISOString(), '2026-11-23T18:30:00.000Z')
    assert.equal(startOfDayIST('24/11/2026'), null)
  })
})
