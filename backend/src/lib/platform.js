// PLATFORM_MODE decides which product this deployment is.
//
//   tradio      (default, and what production runs) Tradio's own portal: Tradio staff coordinate
//               every order, buyers and manufacturers only report and approve.
//   standalone  The manufacturer-and-brand product: the parties transact with each other
//               directly, and Tradio staff are viewers who can act only for manufacturers that
//               Tradio has enabled.
//
// Read at call time, never at import, so a test suite can switch it and so an unset variable
// can never change behaviour on a deployment that predates it.
export const platformMode = () => (process.env.PLATFORM_MODE === 'standalone' ? 'standalone' : 'tradio')
export const isStandalone = () => platformMode() === 'standalone'
