// A new write route that ships without a guard is a hole, and nothing else would notice. This
// walks the routers that hold order and master-order writes and fails if any POST route's handler
// chain lacks one of the named guards, so adding a route forces a decision about who may call it.
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-not-used-anywhere-real'

const { default: ordersRouter } = await import('../src/routes/orders.js')
const { default: masterOrdersRouter } = await import('../src/routes/masterOrders.js')
const authz = await import('../src/lib/authz.js')
const { requireAdmin, requireMaster } = await import('../src/middleware/auth.js')

const postRoutes = router => router.stack
  .filter(l => l.route?.methods?.post)
  .map(l => ({ path: l.route.path, chain: l.route.stack.map(s => s.handle) }))

describe('orders router', () => {
  const guards = new Set([authz.orderWriteGuard, authz.requireOrderOwner, authz.requirePlanEditor, authz.requireAssigner, authz.canCreateOrders])
  // These check their own policy inside the handler (it needs the request body), and have a test of
  // that behaviour in standalone.admin.test.js: bulk creation and bulk materials need the manufacturers
  // named in the rows; escalation is a brand-only action on the brand's own order.
  const checkedInHandler = new Set(['/bulk', '/materials/bulk', '/:id/escalate'])

  test('every write route names a guard', () => {
    const routes = postRoutes(ordersRouter)
    assert.ok(routes.length >= 20, `expected the orders router to hold its write routes, found ${routes.length}`)
    const unguarded = routes.filter(r => !checkedInHandler.has(r.path) && !r.chain.some(h => guards.has(h))).map(r => r.path)
    assert.deepEqual(unguarded, [], 'these order routes have no standalone guard (add orderWriteGuard, or a stricter one)')
  })

  test('the routes that check inside the handler still require an admin or a brand at the door', () => {
    const routes = postRoutes(ordersRouter).filter(r => checkedInHandler.has(r.path))
    assert.equal(routes.length, 3)
    for (const r of routes) assert.ok(r.chain.length >= 3, `${r.path} should have auth plus a role gate or limiter`)
    assert.ok(routes.find(r => r.path === '/bulk').chain.includes(requireAdmin))
    assert.ok(routes.find(r => r.path === '/materials/bulk').chain.includes(requireAdmin))
  })
})

describe('master orders router', () => {
  test('creation names its gate; edit and delete require the owner', () => {
    const routes = postRoutes(masterOrdersRouter)
    assert.equal(routes.length, 3)
    assert.ok(routes.find(r => r.path === '/').chain.includes(authz.canCreateOrders))
    assert.ok(routes.find(r => r.path === '/:id').chain.includes(authz.requireMasterOrderOwner))
    assert.ok(routes.find(r => r.path === '/:id/delete').chain.includes(authz.requireMasterOrderOwner))
  })
})

describe('the organization routes', async () => {
  const { default: orgsRouter } = await import('../src/routes/orgs.js')
  test('everything that changes a company is master-admin only, except the owner\'s own privacy switch', () => {
    const routes = postRoutes(orgsRouter)
    const ownerOnly = new Set(['/me/privacy'])
    const unguarded = routes.filter(r => !ownerOnly.has(r.path) && !r.chain.includes(requireMaster)).map(r => r.path)
    assert.deepEqual(unguarded, [])
  })
})
