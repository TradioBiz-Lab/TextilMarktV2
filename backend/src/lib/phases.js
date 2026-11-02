// Where a style stands before it is in production. New Product Development is the sampling stage; Replen is a reorder of an
// existing style (for now, work moved over from another company). Both behave the same: no delivery date or quantity needed
// yet, plans without a Delivery step, and a move into production that asks for them.
export const PRE_PRODUCTION_PHASES = ['development', 'replen']
export const ORDER_PHASES = [...PRE_PRODUCTION_PHASES, 'production']
export const isPreProduction = phase => PRE_PRODUCTION_PHASES.includes(phase)
