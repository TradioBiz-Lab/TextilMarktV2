import { useEffect, useState, useCallback } from 'react'
import { MapPin, Factory, Clock, RefreshCw } from '../../icons.jsx'
import { T, fmtDate, getToday } from '../../constants.js'
import { PageHeader, Card, Select, Input, Btn, EmptyState, LoadingScreen, Alert } from '../../components/ui.jsx'
import { visitsApi } from '../../api.js'
import { useNavState } from '../../navState.js'
import { timeIST, durationText, distanceText, visitsByDay } from '../../visits.js'

const daysAgo = n => new Date(new Date(`${getToday()}T00:00:00Z`).getTime() - n * 86400000).toISOString().slice(0, 10)

// One end of a visit: the time, how far from the factory the phone was, and a link to the spot.
function Point({ label, p }) {
  if (!p) return <div style={{ fontSize: 12, color: T.textLight }}>{label}: none</div>
  return (
    <div style={{ fontSize: 13, color: T.text, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span style={{ fontWeight: 700 }}>{label} {timeIST(p.at)}</span>
      <a href={p.mapsUrl} target="_blank" rel="noopener noreferrer" title="Open this spot in Google Maps" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: T.info, fontWeight: 600, textDecoration: 'none', fontSize: 12 }}><MapPin size={12} /> Map</a>
      {p.distanceM != null && (
        <span style={{ fontSize: 11, fontWeight: 700, padding: '1px 8px', borderRadius: 10, background: p.away ? T.dangerBg : T.successBg, color: p.away ? T.dangerDeep : T.successDeep }}>
          {p.away ? `Away from factory, ${distanceText(p.distanceM)}` : `At the factory, ${distanceText(p.distanceM)}`}
        </span>
      )}
      {p.distanceM == null && <span style={{ fontSize: 11, color: T.textLight }}>factory has no location</span>}
      {p.accuracy != null && <span style={{ fontSize: 11, color: T.textLight }}>±{p.accuracy} m</span>}
    </div>
  )
}

/** Admins: who visited which factory, when, for how long, and how far from the factory each tap was. */
export function VisitsPage({ onNavigate }) {
  const [from, setFrom] = useNavState('visits.from', daysAgo(6))
  const [to, setTo] = useNavState('visits.to', getToday())
  const [coordinatorId, setCoordinatorId] = useNavState('visits.coordinator', '')
  const [factoryId, setFactoryId] = useNavState('visits.factory', '')
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      setData(await visitsApi.list({ ...(from ? { from } : {}), ...(to ? { to } : {}), ...(coordinatorId ? { coordinatorId } : {}), ...(factoryId ? { factoryId } : {}) }))
    } catch (e) { setError(e?.message || 'Could not load the visits') } finally { setLoading(false) }
  }, [from, to, coordinatorId, factoryId])
  useEffect(() => { load() }, [load])

  if (!data && loading) return <LoadingScreen />
  const groups = visitsByDay(data?.visits)

  return (
    <div>
      <PageHeader title="Factory Visits" subtitle="When each coordinator checked in and out, and where the phone was at each tap"
        action={<Btn variant="secondary" onClick={load} disabled={loading} icon={<RefreshCw size={13} />}>Refresh</Btn>} />

      {data?.missingLocation?.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <Alert type="warning">
            <span>{data.missingLocation.length === 1 ? 'One allocated factory has' : `${data.missingLocation.length} allocated factories have`} no location yet, so a check-in there cannot be measured against it: </span>
            {data.missingLocation.map((m, i) => (
              <span key={m.id}>{i > 0 && ', '}
                {m.partnerId
                  ? <button type="button" onClick={() => onNavigate?.('partner_detail', { id: m.partnerId })} style={{ background: 'none', border: 'none', padding: 0, color: T.info, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit', textDecoration: 'underline' }}>{m.name}</button>
                  : <strong>{m.name}</strong>}
              </span>
            ))}
            <span>. Add it on the partner's page (Location).</span>
          </Alert>
        </div>
      )}

      <Card style={{ marginBottom: 14 }}>
        <div className="form-grid-2" style={{ gap: 12 }}>
          <Input label="From" type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} />
          <Input label="To" type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} />
          <Select label="Coordinator" value={coordinatorId} onChange={e => setCoordinatorId(e.target.value)}>
            <option value="">All coordinators</option>
            {(data?.coordinators || []).map(c => <option key={c.id} value={c.id}>{c.name}{c.isActive ? '' : ' (inactive)'}</option>)}
          </Select>
          <Select label="Factory" value={factoryId} onChange={e => setFactoryId(e.target.value)}>
            <option value="">All factories</option>
            {(data?.factories || []).map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>
        </div>
      </Card>

      {error && <div style={{ marginBottom: 14 }}><Alert type="danger">{error}</Alert></div>}

      {groups.length === 0 && !loading && (
        <Card><EmptyState icon={<Factory size={26} color={T.textLight} />} title="No visits in this period" desc={(data?.coordinators || []).length === 0 ? 'Create an Ops & QC Coordinator in User Setup and allocate factories to them.' : 'Change the dates or filters above.'} /></Card>
      )}

      {groups.map(g => (
        <div key={g.day} style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 8px 2px' }}>{g.day === getToday() ? `Today, ${fmtDate(g.day)}` : fmtDate(g.day)} · {g.visits.length} visit{g.visits.length === 1 ? '' : 's'}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {g.visits.map(v => (
              <Card key={v.id}>
                <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 180, flex: '1 1 200px' }}>
                    <div style={{ fontSize: 14, fontWeight: 800, color: T.text }}>{v.coordinatorName || 'Coordinator'}</div>
                    <div style={{ fontSize: 13, color: T.textMuted, display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}><Factory size={13} /> {v.factoryName || 'Factory'}</div>
                  </div>
                  <div style={{ flex: '2 1 280px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <Point label="In" p={v.checkIn} />
                    {v.checkOut ? <Point label="Out" p={v.checkOut} /> : (
                      <div style={{ fontSize: 13, fontWeight: 700, color: v.open ? T.successDeep : T.dangerDeep }}>{v.open ? 'Still checked in' : 'Did not check out'}</div>
                    )}
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: T.text, display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
                    {v.minutes != null && <><Clock size={14} color={T.textMuted} /> {durationText(v.minutes)}</>}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
