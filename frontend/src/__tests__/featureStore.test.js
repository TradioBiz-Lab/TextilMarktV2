import { describe, test, expect } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { createFeatureStore } from '../stores/createFeatureStore.jsx'

// No browser here, so only what a server render shows: the shape of the store, its first state
// (effects do not run, so nothing is loaded or registered), and the guard against misuse.
describe('createFeatureStore', () => {
  test('returns a Provider and a useStore hook', () => {
    const store = createFeatureStore('t1', { load: async () => [] })
    expect(typeof store.Provider).toBe('function')
    expect(typeof store.useStore).toBe('function')
  })

  test('a consumer first sees the initial items, loading, no error, and the full API', () => {
    const initial = [{ id: 1 }]
    const store = createFeatureStore('t2', { load: async () => [], initial })
    let seen
    const Probe = () => { seen = store.useStore(); return null }
    renderToString(createElement(store.Provider, null, createElement(Probe)))
    expect(seen.items).toBe(initial)
    expect(seen.loading).toBe(true)
    expect(seen.error).toBe(null)
    expect(typeof seen.refresh).toBe('function')
    expect(typeof seen.setItems).toBe('function')
  })

  test('items default to an empty list', () => {
    const store = createFeatureStore('t3', { load: async () => [1] })
    let seen
    const Probe = () => { seen = store.useStore(); return null }
    renderToString(createElement(store.Provider, null, createElement(Probe)))
    expect(seen.items).toEqual([])
  })

  test('does not load until the Provider mounts', () => {
    let calls = 0
    const store = createFeatureStore('t4', { load: async () => { calls++; return [] } })
    expect(calls).toBe(0)
    renderToString(createElement(store.Provider, null, null))
    expect(calls).toBe(0) // a server render runs no effects
  })

  test('useStore outside its Provider says which store it was', () => {
    const store = createFeatureStore('materials', { load: async () => [] })
    const Probe = () => { store.useStore(); return null }
    expect(() => renderToString(createElement(Probe))).toThrow(/materials/)
  })
})
