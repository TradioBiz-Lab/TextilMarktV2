// Express 4 does not forward a rejected promise from an async route handler to the
// error middleware, so a thrown error (a CastError on a bad id, a DB blip) left the
// request hanging until the client timed out. This patches Layer so any handler that
// returns a promise has its rejection passed to next(err), and the global error
// handler in app.js answers it. Must be imported before any router is used.
import Layer from 'express/lib/router/layer.js'

Layer.prototype.handle_request = function handleRequest(req, res, next) {
  const fn = this.handle
  if (fn.length > 3) return next() // error-handling middleware, not for this path
  try {
    const result = fn(req, res, next)
    if (result && typeof result.catch === 'function') result.catch(next)
  } catch (err) {
    next(err)
  }
}
