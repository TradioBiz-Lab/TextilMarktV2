// The factory's supplier book and purchase orders, loaded when a purchasing screen is first opened (not
// at login) and kept fresh by the live feed: another phone adding a supplier moves the feed's `suppliers`
// version, which refetches this store (see LiveRefresh).
import { createFeatureStore } from './createFeatureStore.jsx'
import { suppliersApi, purchaseOrdersApi } from '../api.js'

export const suppliersStore = createFeatureStore('suppliers', { load: () => suppliersApi.list({ all: true }), initial: [] })
export const posStore = createFeatureStore('purchase-orders', { load: () => purchaseOrdersApi.list(), initial: [] })

/** Wrap every purchasing screen: the PO builder needs suppliers, the supplier page needs POs. */
export function ProcurementProviders({ children }) {
  return (
    <suppliersStore.Provider>
      <posStore.Provider>{children}</posStore.Provider>
    </suppliersStore.Provider>
  )
}
