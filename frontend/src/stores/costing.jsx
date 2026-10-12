// Cost sheets (one row per sheet): a factory's own, or what has been shared with a brand. Loaded when a
// costing screen is first opened and kept fresh by the live feed: a brand's comment or approval, or the
// factory sharing a new version, moves the feed's `cost-sheets` version on both sides (see LiveRefresh).
import { createFeatureStore } from './createFeatureStore.jsx'
import { costSheetsApi } from '../api.js'

export const costSheetsStore = createFeatureStore('cost-sheets', { load: () => costSheetsApi.list(), initial: [] })

/** Wrap the costing list and sheet screens. */
export function CostingProviders({ children }) {
  return <costSheetsStore.Provider>{children}</costSheetsStore.Provider>
}
