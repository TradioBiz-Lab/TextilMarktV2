import { useState } from 'react'
import { AlertTriangle, CheckCircle2 } from '../icons.jsx'
import { T } from '../constants.js'
import { Input } from '../components/ui.jsx'
import { authApi } from '../api.js'

// The sign-in card's other two faces: asking for a reset link ('forgot'), and choosing a new password from that link
// ('reset', the token comes from the emailed URL). The server answers a request the same way whether or not the email has
// an account, and says when email is not set up, in which case Tradio resets the password instead.
const strong = pw => pw.length >= 8 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw)

export function PasswordHelp({ mode, token, initialEmail = '', onBack }) {
  const [email, setEmail] = useState(initialEmail)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(null)   // the message to show once it worked

  const ask = async e => {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const r = await authApi.forgotPassword(email.trim())
      setDone(r?.emailEnabled === false
        ? 'Email is not set up yet, so no link can be sent. Ask your Tradio contact to reset your password.'
        : 'If an account uses that email, a link to reset the password is on its way. It works once, for 30 minutes.')
    } catch (err) { setError(err?.message || 'Could not send the link. Try again.') }
    finally { setBusy(false) }
  }

  const choose = async e => {
    e.preventDefault()
    if (!strong(pw)) { setError('Use at least 8 characters, with an uppercase and a lowercase letter, a number and a special character.'); return }
    if (pw !== pw2) { setError('The two passwords do not match.'); return }
    setBusy(true); setError('')
    try { await authApi.resetPassword(token, pw); setDone('Your password is changed. Sign in with the new one.') }
    catch (err) { setError(err?.message || 'Could not change the password.') }
    finally { setBusy(false) }
  }

  const title = mode === 'reset' ? 'Choose a new password' : 'Reset your password'
  const sub = mode === 'reset' ? 'For the account the reset link was sent to' : "Enter your account's email and we will send you a link"
  const button = { background: busy ? '#fb923c' : T.primary, color: '#fff', border: 'none', padding: '12px', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit' }

  return (
    <div>
      <div style={{ textAlign: 'center', marginBottom: 24 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: T.text }}>{title}</div>
        <div style={{ fontSize: 13, color: T.textMuted, marginTop: 6 }}>{sub}</div>
      </div>
      {done ? (
        <div style={{ fontSize: 13, color: '#166534', background: '#dcfce7', border: '1px solid #86efac', borderRadius: 8, padding: '10px 12px', display: 'flex', gap: 8, alignItems: 'flex-start', lineHeight: 1.5 }}>
          <CheckCircle2 size={15} style={{ flexShrink: 0, marginTop: 1 }} /> {done}
        </div>
      ) : (
        <form onSubmit={mode === 'reset' ? choose : ask} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {mode === 'reset' ? (<>
            <Input label="New password" type="password" value={pw} onChange={e => { setPw(e.target.value); setError('') }} autoComplete="new-password" required />
            <Input label="New password again" type="password" value={pw2} onChange={e => { setPw2(e.target.value); setError('') }} autoComplete="new-password" required />
          </>) : (
            <Input label="Email Address" type="email" value={email} onChange={e => { setEmail(e.target.value); setError('') }} placeholder="you@company.com" autoComplete="email" required />
          )}
          {error && <div style={{ fontSize: 12, color: T.danger, fontWeight: 500, background: T.dangerBg, padding: '8px 12px', borderRadius: 8, border: `1px solid ${T.dangerBorder}`, display: 'flex', alignItems: 'center', gap: 6 }}><AlertTriangle size={13} /> {error}</div>}
          <button type="submit" disabled={busy} style={button}>{busy ? 'Please wait...' : mode === 'reset' ? 'Change password' : 'Send reset link'}</button>
        </form>
      )}
      <div style={{ marginTop: 16, textAlign: 'center' }}>
        <button type="button" onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: T.primary, fontWeight: 600, fontFamily: 'inherit' }}>Back to sign in</button>
      </div>
    </div>
  )
}
