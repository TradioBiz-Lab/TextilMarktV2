import { useEffect, useState } from 'react'
import { partnersApi } from '../api.js'

/**
 * The companies this brand or manufacturer is connected with: the only ones it may name on a new
 * order or master order. Loads once when `enabled` (a Tradio admin has no partners and would be refused).
 */
export function usePartners(enabled = true) {
  const [state, setState] = useState({ partners: [], loading: !!enabled, error: '' })
  useEffect(() => {
    if (!enabled) { setState({ partners: [], loading: false, error: '' }); return undefined }
    let live = true
    partnersApi.list()
      .then(partners => { if (live) setState({ partners, loading: false, error: '' }) })
      .catch(e => { if (live) setState({ partners: [], loading: false, error: e?.message || 'Could not load your partners' }) })
    return () => { live = false }
  }, [enabled])
  return state
}
