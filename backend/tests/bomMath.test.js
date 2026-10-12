// The BOM quantity maths against the factory's own fabric plan (5117/5118) and the cases around it.
// The expected figures come from tests/fixtures/bomMath.cases.json, which the frontend suite runs too.
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { roundTo, isCountUnit, splitBySize, consumptionBySize, weightedConsumption, normalisePlan, computeLine, computeBom } from '../src/lib/bomMath.js'

const cases = JSON.parse(readFileSync(new URL('./fixtures/bomMath.cases.json', import.meta.url), 'utf8'))

describe('the shared cases', () => {
  for (const c of cases) {
    test(c.name, () => {
      const r = computeLine(c.plan, c.line)
      assert.equal(r.net, c.expected.net)
      assert.equal(r.buffer, c.expected.buffer)
      assert.equal(r.orderQty, c.expected.orderQty)
      assert.equal(r.perColour.length, c.expected.perColour.length)
      c.expected.perColour.forEach((e, i) => {
        assert.deepEqual(
          { colour: r.perColour[i].colour, sizePcs: r.perColour[i].sizePcs, net: r.perColour[i].net, buffer: r.perColour[i].buffer, orderQty: r.perColour[i].orderQty },
          { colour: e.colour, sizePcs: e.sizePcs, net: e.net, buffer: e.buffer, orderQty: e.orderQty })
      })
      if (c.expected.sizePcs) assert.deepEqual(r.sizePcs, c.expected.sizePcs)
    })
  }
})

describe('rounding the way the spreadsheet does', () => {
  test('half rounds away from zero, and float noise is ignored', () => {
    assert.equal(roundTo(303.45000000000005, 1), 303.5)
    assert.equal(roundTo(4638.5, 0), 4639)
    assert.equal(roundTo(1.005, 2), 1.01)
    assert.equal(roundTo(2.5, 0), 3)
    assert.equal(roundTo(-2.5, 0), -3)
    assert.equal(roundTo('x', 2), 0)
  })

  test('units bought by the piece are rounded up, cloth is rounded to nearest', () => {
    assert.equal(isCountUnit('Pcs'), true)
    assert.equal(isCountUnit(' cones '), true)
    assert.equal(isCountUnit('kg'), false)
    assert.equal(isCountUnit('m'), false)
    const plan = { sizes: ['ONE'], ratio: [1], colours: [{ name: 'A', qty: 1001 }] }
    assert.equal(computeLine(plan, { unit: 'pcs', consumption: 1, wastagePct: 0.03, perColour: false }).orderQty, 1002)
    assert.equal(computeLine(plan, { unit: 'm', consumption: 1, wastagePct: 0.03, perColour: false }).orderQty, 1001)
  })
})

describe('the size split', () => {
  test('is each size\'s share rounded to whole pieces', () => {
    assert.deepEqual(splitBySize(3600, [1, 2, 3, 2, 1]), [400, 800, 1200, 800, 400])
    assert.deepEqual(splitBySize(6000, [1, 2, 3, 2, 1]), [667, 1333, 2000, 1333, 667])
  })

  test('an empty or zero ratio gives nothing rather than dividing by zero', () => {
    assert.deepEqual(splitBySize(100, [0, 0]), [0, 0])
    assert.deepEqual(splitBySize(100, []), [])
  })

  test('a size\'s own consumption is used when given, otherwise the line\'s', () => {
    assert.deepEqual(consumptionBySize({ consumption: 0.5, perSize: [0.4, null, '', undefined, 'abc'] }, 5), [0.4, 0.5, 0.5, 0.5, 0.5])
    assert.deepEqual(consumptionBySize({ consumption: 2 }, 3), [2, 2, 2])
  })

  test('the average across the size mix is what a cost sheet takes', () => {
    const plan = { sizes: ['S', 'M', 'L', 'XL', 'XXL'], ratio: [1, 2, 3, 2, 1] }
    assert.equal(weightedConsumption(plan, { consumption: 0.72, perSize: [0.63, 0.675, 0.72, 0.765, 0.8325] }), 0.7225)
    assert.equal(weightedConsumption(plan, { consumption: 1.5 }), 1.5)
  })
})

describe('plans and warnings', () => {
  test('a plan with no colours is one colour of the whole quantity', () => {
    const p = normalisePlan({ sizes: ['S', 'M'], ratio: [1, 1], totalQty: 500 })
    assert.deepEqual(p.colours, [{ name: 'All', qty: 500 }])
    assert.deepEqual(normalisePlan({}).sizes, ['ONE'])
  })

  test('no ratio at all splits evenly, a zero in it takes none', () => {
    assert.deepEqual(normalisePlan({ sizes: ['S', 'M'] }).ratio, [1, 1])
    assert.deepEqual(normalisePlan({ sizes: ['S', 'M'], ratio: [1, 0] }).ratio, [1, 0])
  })

  test('the person is told when the sizes or colours do not add up', () => {
    const plan = { sizes: ['M', 'L'], ratio: [1, 1], colours: [{ name: 'RED', qty: 1000 }, { name: 'BLUE', qty: 501 }] }
    const r = computeBom(plan, [{ item: 'Fleece', unit: 'm', consumption: 1.5, perColour: true }], { totalQty: 1600 })
    assert.deepEqual(r.warnings.map(w => w.code).sort(), ['colour_total', 'size_rounding'])
    assert.match(r.warnings.find(w => w.code === 'size_rounding').message, /BLUE: the size split adds up to 502 pieces, not 501/)
    assert.match(r.warnings.find(w => w.code === 'colour_total').message, /1501 pieces, not the 1600/)
    assert.equal(r.lines[0].item, 'Fleece')
    assert.ok(r.lines[0].computed.orderQty > 0)
  })

  test('a clean plan has nothing to say', () => {
    const plan = { sizes: ['S', 'M'], ratio: [1, 1], colours: [{ name: 'A', qty: 100 }] }
    assert.deepEqual(computeBom(plan, [{ unit: 'm', consumption: 1, perColour: true }], { totalQty: 100 }).warnings, [])
  })

  test('negative wastage is treated as none, and a missing line works as zero', () => {
    const plan = { sizes: ['S'], ratio: [1], colours: [{ name: 'A', qty: 10 }] }
    assert.equal(computeLine(plan, { unit: 'm', consumption: 2, wastagePct: -5, perColour: true }).buffer, 0)
    assert.equal(computeLine(plan, {}).orderQty, 0)
  })
})

describe('a size and colour grid', () => {
  const sizes = ['S', 'M', 'L', 'XL', 'XXL']
  const fleece = { unit: 'kg', consumption: 0.72, perSize: [0.63, 0.675, 0.72, 0.765, 0.8325], wastagePct: 7, perColour: true }

  test('a gridded colour\'s quantity is the total of its sizes, whatever qty says; the pieces are whole and not negative', () => {
    const p = normalisePlan({ sizes, ratio: [1, 2, 3, 2, 1], colours: [{ name: 'BLACK', qty: 9999, sizes: [100, 300.4, 500, -5, '100'] }, { name: 'NAVY', qty: 70 }] })
    assert.deepEqual(p.colours, [{ name: 'BLACK', qty: 1000, sizes: [100, 300, 500, 0, 100] }, { name: 'NAVY', qty: 70 }])
  })

  test('a grid shorter than the sizes counts the missing sizes as none, an empty one is not a grid', () => {
    const p = normalisePlan({ sizes, colours: [{ name: 'A', sizes: [10, 20] }, { name: 'B', qty: 40, sizes: [] }] })
    assert.deepEqual(p.colours, [{ name: 'A', qty: 30, sizes: [10, 20, 0, 0, 0] }, { name: 'B', qty: 40 }])
  })

  test('each colour is worked from its own pieces, not the ratio', () => {
    const plan = { sizes, ratio: [1, 2, 3, 2, 1], colours: [{ name: 'BLACK', sizes: [100, 300, 500, 300, 100] }, { name: 'NAVY', sizes: [50, 150, 250, 150, 50] }] }
    const r = computeLine(plan, fleece)
    assert.deepEqual(r.perColour.map(c => c.sizePcs), [[100, 300, 500, 300, 100], [50, 150, 250, 150, 50]])
    assert.deepEqual(r.perColour.map(c => c.orderQty), [1004, 502])
    assert.equal(r.orderQty, 1506)
  })

  test('a line for the whole order is worked over the pieces of each size across the colours', () => {
    const plan = { sizes, ratio: [1, 2, 3, 2, 1], colours: [{ name: 'BLACK', sizes: [100, 300, 500, 300, 100] }, { name: 'NAVY', sizes: [50, 150, 250, 150, 50] }] }
    const r = computeLine(plan, { unit: 'pcs', consumption: 1, wastagePct: 0, perColour: false })
    assert.deepEqual(r.sizePcs, [150, 450, 750, 450, 150])
    assert.equal(r.orderQty, 1950)
  })

  test('the cost sheet figure is the average over the grid\'s own size mix', () => {
    const grid = { sizes, ratio: [1, 2, 3, 2, 1], colours: [{ name: 'BLACK', sizes: [100, 300, 500, 300, 100] }, { name: 'NAVY', sizes: [50, 150, 250, 150, 50] }] }
    assert.equal(weightedConsumption(grid, fleece), 0.7217)                                    // sizes sell 1:3:5:3:1 here
    assert.equal(weightedConsumption({ ...grid, colours: [{ name: 'ALL', qty: 1950 }] }, fleece), 0.7225)   // by the 1:2:3:2:1 ratio
  })

  test('a gridded colour has no rounding to warn about; colours that miss the order total still do', () => {
    const plan = { sizes, ratio: [1, 2, 3, 2, 1], colours: [{ name: 'BLACK', sizes: [111, 222, 333, 222, 112] }] }
    assert.deepEqual(computeBom(plan, [fleece], { totalQty: 1000 }).warnings, [])
    assert.deepEqual(computeBom(plan, [fleece], { totalQty: 1200 }).warnings.map(w => w.code), ['colour_total'])
  })
})

