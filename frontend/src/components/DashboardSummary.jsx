import { useEffect, useState, useCallback } from 'react'
import { Sparkles, RefreshCw } from 'lucide-react'
import { useApp } from '../context.jsx'
import { generateSummary } from '../dashboardSummary.js'
import { T } from '../constants.js'

// **bold** segments in a summary line render as emphasis.
const renderLine = text => text.split('**').map((part, i) => i % 2 ? <strong key={i} style={{ color: T.text }}>{part}</strong> : part)

/**
 * "AI summary" card for the top of every role's dashboard, under the metrics.
 * It calls generateSummary() (see dashboardSummary.js), which is a placeholder
 * today and the single place to plug a real model in later.
 */
export function DashboardSummary() {
  const { orders, actionItems, currentUser: user, loading } = useApp()
  const [summary, setSummary] = useState(null)
  const [busy, setBusy] = useState(false)

  const run = useCallback(async () => {
    if (!user) return
    setBusy(true)
    try { setSummary(await generateSummary({ role: user.role, user, orders, actionItems })) }
    catch { setSummary(null) }
    finally { setBusy(false) }
  }, [user, orders, actionItems])

  // Regenerates whenever the underlying data changes, so it stays current as updates land.
  useEffect(() => { if (!loading) run() }, [run, loading])

  if (!summary && !busy) return null
  return (
    <div style={{
      marginBottom: 14, borderRadius: 14, padding: 1,
      background: 'linear-gradient(135deg, #f97316 0%, #fb923c 40%, #a78bfa 100%)',
    }}>
      <div style={{ background: T.surface, borderRadius: 13, padding: '14px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 800, letterSpacing: '0.04em', color: '#c2410c', background: '#fff7ed', border: '1px solid #fed7aa', padding: '3px 9px', borderRadius: 999 }}>
            <Sparkles size={12} /> AI SUMMARY
          </span>
          <span style={{ fontSize: 11, color: T.textLight }}>
            {summary ? `Updated ${new Date(summary.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Generating…'}
          </span>
          <button onClick={run} disabled={busy} title="Regenerate summary" aria-label="Regenerate summary"
            style={{ marginLeft: 'auto', border: 'none', background: 'transparent', cursor: busy ? 'default' : 'pointer', color: T.textMuted, display: 'inline-flex', padding: 4, borderRadius: 6 }}>
            <RefreshCw size={14} style={busy ? { animation: 'tradio-spin 0.8s linear infinite' } : undefined} />
          </button>
        </div>
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 5 }}>
          {(summary?.lines || []).map((l, i) => (
            <li key={i} style={{ display: 'flex', gap: 9, fontSize: 13.5, lineHeight: 1.5, color: T.textMuted }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#fb923c', marginTop: 8, flexShrink: 0 }} />
              <span>{renderLine(l)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
