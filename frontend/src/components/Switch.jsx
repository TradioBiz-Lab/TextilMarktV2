import { T } from '../constants.js'

/** An on/off switch with a real touch target, announced to screen readers as a switch. */
export function Switch({ on, onChange, disabled, label }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      style={{ width: 52, height: 30, borderRadius: 15, border: 'none', padding: 3, cursor: disabled ? 'not-allowed' : 'pointer', background: on ? T.success : '#cbd5e1', opacity: disabled ? 0.6 : 1, display: 'flex', alignItems: 'center', justifyContent: on ? 'flex-end' : 'flex-start', transition: 'background 0.15s', flexShrink: 0 }}>
      <span style={{ width: 24, height: 24, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.25)' }} />
    </button>
  )
}
