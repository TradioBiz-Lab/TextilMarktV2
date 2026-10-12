import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { register, bump, bumpAll, changedVersionKeys } from '../stores/refreshRegistry.js'

// The registry is module state, so every test unregisters what it registered.
let offs = []
const reg = (key, fn) => { const off = register(key, fn); offs.push(off); return off }

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  offs.forEach(off => off())
  offs = []
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('bump', () => {
  test('calls the registered refresher 250ms later, not before', () => {
    const fn = vi.fn()
    reg('materials', fn)
    bump('materials')
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(249)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('bumps within the window collapse into one refresh, 250ms after the last', () => {
    const fn = vi.fn()
    reg('materials', fn)
    bump('materials')
    vi.advanceTimersByTime(200)
    bump('materials')
    vi.advanceTimersByTime(200)
    bump('materials')
    vi.advanceTimersByTime(249)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5000)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('a bump after the window has passed refreshes again', () => {
    const fn = vi.fn()
    reg('materials', fn)
    bump('materials')
    vi.advanceTimersByTime(250)
    bump('materials')
    vi.advanceTimersByTime(250)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('keys are debounced independently', () => {
    const a = vi.fn()
    const b = vi.fn()
    reg('a', a)
    reg('b', b)
    bump('a')
    vi.advanceTimersByTime(100)
    bump('b')
    vi.advanceTimersByTime(150)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(b).toHaveBeenCalledTimes(1)
  })

  test('does nothing for a key nobody registered', () => {
    expect(() => bump('nobody')).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('a refresher that throws, or rejects, does not break the others', async () => {
    const good = vi.fn()
    reg('bad-sync', () => { throw new Error('boom') })
    reg('bad-async', () => Promise.reject(new Error('boom')))
    reg('good', good)
    bump('bad-sync')
    bump('bad-async')
    bump('good')
    expect(() => vi.advanceTimersByTime(250)).not.toThrow()
    await Promise.resolve()
    expect(good).toHaveBeenCalledTimes(1)
  })
})

describe('unregister', () => {
  test('stops the refresher being called', () => {
    const fn = vi.fn()
    const off = reg('materials', fn)
    off()
    bump('materials')
    vi.advanceTimersByTime(1000)
    expect(fn).not.toHaveBeenCalled()
  })

  test('cancels a refresh that was already pending', () => {
    const fn = vi.fn()
    const off = reg('materials', fn)
    bump('materials')
    vi.advanceTimersByTime(100)
    off()
    vi.advanceTimersByTime(1000)
    expect(fn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('calling it twice is harmless', () => {
    const off = reg('materials', vi.fn())
    off()
    expect(() => off()).not.toThrow()
  })

  test('an old registration cannot remove its replacement (a store that remounted)', () => {
    const oldFn = vi.fn()
    const newFn = vi.fn()
    const offOld = reg('materials', oldFn)
    reg('materials', newFn)
    offOld()
    bump('materials')
    vi.advanceTimersByTime(250)
    expect(oldFn).not.toHaveBeenCalled()
    expect(newFn).toHaveBeenCalledTimes(1)
  })

  test('a refresh pending when the store is replaced runs the new one', () => {
    const oldFn = vi.fn()
    const newFn = vi.fn()
    reg('materials', oldFn)
    bump('materials')
    reg('materials', newFn)
    vi.advanceTimersByTime(250)
    expect(oldFn).not.toHaveBeenCalled()
    expect(newFn).toHaveBeenCalledTimes(1)
  })
})

describe('bumpAll', () => {
  test('refreshes every registered key once', () => {
    const a = vi.fn()
    const b = vi.fn()
    reg('a', a)
    reg('b', b)
    bumpAll()
    bumpAll()
    vi.advanceTimersByTime(250)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  test('does nothing when nothing is registered', () => {
    expect(() => bumpAll()).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('changedVersionKeys', () => {
  test('lists the keys whose version moved', () => {
    expect(changedVersionKeys({ orders: 5, docs: 'a1', materials: 2 }, { orders: 6, docs: 'a1', materials: 3 })).toEqual(['orders', 'materials'])
  })

  test('the first poll has nothing to compare with, so nothing moved', () => {
    expect(changedVersionKeys(null, { orders: 1 })).toEqual([])
    expect(changedVersionKeys(undefined, { orders: 1 })).toEqual([])
  })

  test('a key seen for the first time counts as moved; one that has gone does not', () => {
    expect(changedVersionKeys({ orders: 1 }, { orders: 1, invoices: 4 })).toEqual(['invoices'])
    expect(changedVersionKeys({ orders: 1, invoices: 4 }, { orders: 1 })).toEqual([])
  })

  test('versions are strings or numbers, compared exactly', () => {
    expect(changedVersionKeys({ a: 1 }, { a: '1' })).toEqual(['a'])
    expect(changedVersionKeys({ a: 'x' }, { a: 'x' })).toEqual([])
    expect(changedVersionKeys({ a: 0 }, { a: 0 })).toEqual([])
  })

  test('ignores a missing or malformed new map', () => {
    expect(changedVersionKeys({ a: 1 }, undefined)).toEqual([])
    expect(changedVersionKeys({ a: 1 }, null)).toEqual([])
    expect(changedVersionKeys({ a: 1 }, 'nope')).toEqual([])
    expect(changedVersionKeys({ a: 1 }, [1, 2])).toEqual([])
  })
})
