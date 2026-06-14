import { useState } from 'react'
import { T } from '../constants.js'
import { Input, Btn } from '../components/ui.jsx'
import api from '../api.js'

const ROLE_OPTIONS = [
  { value: '', label: '— Select your role —' },
  { value: 'Buyer', label: 'Buyer' },
  { value: 'Manufacturer', label: 'Manufacturer' },
  { value: 'Other', label: 'Other' },
]

export function SignUpPage({ onBackToLogin }) {
  const [f, setF] = useState({ name: '', email: '', company: '', phone: '', role: '', message: '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  const set = key => e => setF(p => ({ ...p, [key]: e.target.value }))

  const submit = async e => {
    e.preventDefault()
    setErr('')
    if (!f.name.trim()) { setErr('Please enter your name.'); return }
    if (!f.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) {
      setErr('Please enter a valid email address.')
      return
    }
    setBusy(true)
    try {
      await api.post('/signup', {
        name: f.name.trim(),
        email: f.email.trim(),
        company: f.company.trim(),
        phone: f.phone.trim(),
        role: f.role,
        message: f.message.trim(),
      })
      setDone(true)
    } catch (e) {
      setErr(typeof e === 'string' ? e : 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: T.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ width: '100%', maxWidth: 480 }}>
        {/* Brand header */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 0, marginBottom: 6 }}>
            <span style={{ fontSize: 26, fontWeight: 900, color: '#93a3d1', fontFamily: 'system-ui' }}>Textil</span>
            <span style={{ fontSize: 26, fontWeight: 900, color: T.primary, fontFamily: 'system-ui' }}>Markt</span>
          </div>
          <div style={{ fontSize: 11, color: T.textLight, letterSpacing: '0.08em', textTransform: 'uppercase' }}>powered by Tradio</div>
        </div>

        <div style={{ background: T.surface, borderRadius: 14, border: `1px solid ${T.border}`, padding: 32, boxShadow: '0 8px 32px rgba(0,0,0,0.08)' }}>
          {done ? (
            <div style={{ textAlign: 'center', padding: '12px 0' }}>
              <div style={{ fontSize: 40, marginBottom: 16 }}>✅</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: T.text, marginBottom: 10 }}>Request Received!</div>
              <div style={{ fontSize: 14, color: T.textMuted, lineHeight: 1.7, marginBottom: 24 }}>
                Thank you for your interest in TextilMarkt. Your information has been recorded and a member of the Tradio team will contact you shortly to set up your account.
              </div>
              <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 10, padding: '12px 16px', marginBottom: 24, fontSize: 13, color: '#15803d' }}>
                We typically respond within 1 business day.
              </div>
              <button
                onClick={onBackToLogin}
                style={{ background: 'none', border: 'none', color: T.primary, cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', textDecoration: 'underline' }}
              >
                Back to Sign In
              </button>
            </div>
          ) : (
            <>
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: T.text, marginBottom: 4 }}>Request Access</div>
                <div style={{ fontSize: 13, color: T.textMuted }}>Fill in your details and our team will get in touch to set up your account.</div>
              </div>

              <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <Input
                  label="Full Name *"
                  value={f.name}
                  onChange={set('name')}
                  placeholder="Jane Smith"
                  required
                />
                <Input
                  label="Work Email *"
                  type="email"
                  value={f.email}
                  onChange={set('email')}
                  placeholder="jane@company.com"
                  required
                />
                <Input
                  label="Company / Brand"
                  value={f.company}
                  onChange={set('company')}
                  placeholder="ACME Apparel Ltd."
                />
                <Input
                  label="Phone Number"
                  type="tel"
                  value={f.phone}
                  onChange={set('phone')}
                  placeholder="+1 555 000 0000"
                />

                <div>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                    I am a…
                  </label>
                  <select
                    value={f.role}
                    onChange={set('role')}
                    style={{ width: '100%', border: `1px solid ${T.border}`, borderRadius: 8, padding: '9px 12px', fontSize: 13, color: f.role ? T.text : T.textLight, background: T.surface, fontFamily: 'inherit' }}
                  >
                    {ROLE_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                    Additional Notes
                  </label>
                  <textarea
                    value={f.message}
                    onChange={set('message')}
                    placeholder="Tell us a bit about your business or any specific requirements…"
                    rows={3}
                    maxLength={2000}
                    style={{ width: '100%', boxSizing: 'border-box', border: `1px solid ${T.border}`, borderRadius: 8, padding: '9px 12px', fontSize: 13, color: T.text, background: T.surface, fontFamily: 'inherit', resize: 'vertical', lineHeight: 1.5 }}
                  />
                </div>

                {err && (
                  <div style={{ fontSize: 12, color: T.danger, fontWeight: 500, background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: 8, padding: '8px 12px' }}>
                    ⚠ {err}
                  </div>
                )}

                <Btn type="submit" block disabled={busy}>
                  {busy ? 'Submitting…' : 'Submit Request'}
                </Btn>
              </form>

              <div style={{ textAlign: 'center', marginTop: 16 }}>
                <button
                  type="button"
                  onClick={onBackToLogin}
                  style={{ background: 'none', border: 'none', color: T.textMuted, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}
                >
                  Already have an account? <span style={{ color: T.primary, fontWeight: 600 }}>Sign in</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
