// A factory's stock and goods received notes, loaded when a stock screen is first opened (not at login) and
// kept fresh by the live feed: a teammate's phone posting a delivery moves the feed's `inventory` and `grns`
// versions, which refetches these stores (see LiveRefresh).
import { createFeatureStore } from './createFeatureStore.jsx'
import { inventoryApi, grnsApi, jobworkApi } from '../api.js'

/** The stock list (archived items included, the screen filters) and the slips issued to orders. */
export const stockStore = createFeatureStore('inventory', {
  load: async () => {
    const [items, issues] = await Promise.all([inventoryApi.items({ archived: true }), inventoryApi.issues()])
    return { items, issues }
  },
  initial: { items: [], issues: [] },
})
export const grnsStore = createFeatureStore('grns', { load: () => grnsApi.list(), initial: [] })
/** Challans of goods sent to job workers, and who holds what. */
export const jobworkStore = createFeatureStore('jobwork', {
  load: async () => {
    const [jobs, outstanding] = await Promise.all([jobworkApi.list(), jobworkApi.outstanding()])
    return { jobs, outstanding }
  },
  initial: { jobs: [], outstanding: [] },
})

export function InventoryProviders({ children }) {
  return (
    <stockStore.Provider>
      <grnsStore.Provider>
        <jobworkStore.Provider>{children}</jobworkStore.Provider>
      </grnsStore.Provider>
    </stockStore.Provider>
  )
}
