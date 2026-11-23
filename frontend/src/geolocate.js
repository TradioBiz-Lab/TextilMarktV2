// The phone's position for a check-in, a check-out or an update. Rejects with an Error whose `code` says why:
// 'denied' (permission refused), 'unavailable' (no fix or timed out) or 'unsupported'.
export function getPosition({ timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const fail = code => reject(Object.assign(new Error(code), { code }))
    if (typeof navigator === 'undefined' || !navigator.geolocation) return fail('unsupported')
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy ?? null, deviceAt: new Date().toISOString() }),
      e => fail(e?.code === 1 ? 'denied' : 'unavailable'),
      { enableHighAccuracy: true, timeout, maximumAge: 30000 },
    )
  })
}
