import { useState } from 'react'
import { T } from '../constants.js'
import { Input } from '../components/ui.jsx'
import { useApp } from '../context.jsx'
import { SignUpPage } from './SignUpPage.jsx'

export function LoginPage() {
  const { login } = useApp()
  const [showSignUp, setShowSignUp] = useState(false)
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [error, setError] = useState('')
  const [attempts, setAttempts] = useState({})
  const [locked, setLocked] = useState({})
  const [showPw, setShowPw] = useState(false)
  const [loading, setLoading] = useState(false)

  const submit = async e => {
    e.preventDefault()
    const lockUntil = locked[email]
    if (lockUntil && lockUntil > Date.now()) {
      const mins = Math.ceil((lockUntil - Date.now()) / 60000)
      setError(`Account locked. Try again in ${mins} minute(s).`)
      return
    }
    setLoading(true)
    try {
      await login(email, pw)
    } catch (err) {
      const cnt = (attempts[email] || 0) + 1
      setAttempts(p => ({ ...p, [email]: cnt }))
      if (cnt >= 5) {
        setLocked(p => ({ ...p, [email]: Date.now() + 15 * 60 * 1000 }))
        setError('Too many attempts. Account locked for 15 minutes.')
      } else {
        setError(`${err || 'Invalid email or password'}. ${5 - cnt} attempt(s) remaining.`)
      }
    } finally {
      setLoading(false)
    }
  }

  if (showSignUp) return <SignUpPage onBackToLogin={() => setShowSignUp(false)} />

  return (
    <div style={{ minHeight: '100vh', background: T.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, overflow: 'auto' }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div style={{ background: T.surface, borderRadius: 20, border: `1px solid ${T.border}`, padding: '40px 36px', boxShadow: '0 4px 24px rgba(0,0,0,0.06)' }}>

          {/* Logo */}
          <div style={{ textAlign: 'center', marginBottom: 32 }}>
            <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', lineHeight: 1 }}>
                <span style={{ fontSize: 30, fontWeight: 800, color: '#003B73', letterSpacing: '-0.02em', fontFamily: 'inherit' }}>Textil</span>
                <span style={{ fontSize: 30, fontWeight: 800, color: '#C2410C', letterSpacing: '-0.02em', fontFamily: 'inherit' }}>Markt</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
                <div style={{ width: 16, height: 1.5, background: '#C2410C', borderRadius: 1 }} />
                <span style={{ fontSize: 8, fontWeight: 700, color: '#94a3b8', letterSpacing: '0.08em', textTransform: 'uppercase' }}>by Tradio</span>
              </div>
            </div>
          </div>

          {/* Title */}
          <div style={{ textAlign: 'center', marginBottom: 28 }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: T.text }}>Welcome back</div>
            <div style={{ fontSize: 13, color: T.textMuted, marginTop: 6 }}>Sign in to access your portal</div>
          </div>

          {/* Form */}
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <Input label="Email Address" type="email" value={email} onChange={e => { setEmail(e.target.value); setError('') }} placeholder="you@company.com" required />
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>Password</label>
              <div style={{ position: 'relative' }}>
                <input type={showPw ? 'text' : 'password'} value={pw} onChange={e => { setPw(e.target.value); setError('') }} placeholder="Enter your password" required
                  style={{ width: '100%', border: `1px solid ${error ? T.danger : T.border}`, borderRadius: 8, padding: '10px 40px 10px 12px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit' }} />
                <button type="button" onClick={() => setShowPw(p => !p)}
                  style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 15, color: T.textMuted, padding: '0 4px' }}>
                  {showPw ? '🙈' : '👁'}
                </button>
              </div>
              {error && <div style={{ fontSize: 12, color: T.danger, marginTop: 6, fontWeight: 500, background: T.dangerBg, padding: '8px 12px', borderRadius: 8, border: `1px solid ${T.dangerBorder}` }}>⚠ {error}</div>}
            </div>
            <button type="submit" disabled={loading}
              style={{ background: loading ? '#fb923c' : T.primary, color: '#fff', border: 'none', padding: '12px', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: loading ? 'wait' : 'pointer', marginTop: 4, transition: 'background 0.15s', fontFamily: 'inherit', letterSpacing: '0.01em' }}>
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          {/* Security info */}
          <div style={{ marginTop: 24, textAlign: 'center', fontSize: 11, color: T.textLight, lineHeight: 1.7 }}>
            Session expires after 60 min · Passwords hashed with bcrypt
          </div>

          {/* Sign up link */}
          <div style={{ marginTop: 16, textAlign: 'center' }}>
            <button
              type="button"
              onClick={() => setShowSignUp(true)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: T.textMuted, fontFamily: 'inherit' }}
            >
              Don't have an account?{' '}
              <span style={{ color: T.primary, fontWeight: 600 }}>Request Access</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
