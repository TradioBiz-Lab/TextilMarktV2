import { useState } from 'react'
import { T, isExpiringSoon, isExpired } from '../../constants.js'
import { Badge, Btn, Card, FlexRow, Mono, EmptyState, DocCard, Tabs, Alert, LoadingScreen, StageTimeline, MfrProfileLink, StageDocGroup, dataUrlToBlobUrl, ProductThumb } from '../../components/ui.jsx'
import { useApp } from '../../context.jsx'


function fmtDate(d) {
  if (!d) return '—'
  const dt = new Date(d)
  const dd = String(dt.getDate()).padStart(2, '0')
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  return `${dd}-${mm}-${dt.getFullYear()}`
}

export function BuyerOrderDetail({ orderId, onBack, initialMid }) {
  const { orders, docs, users, loading, getDocData } = useApp()
  const [tab, setTab] = useState('progress')
  const [selectedMid, setSelectedMid] = useState(initialMid || null)
  const [viewerBlob, setViewerBlob] = useState(null)
  const [viewerName, setViewerName] = useState('')
  const [viewerLoading, setViewerLoading] = useState(false)

  const closeViewer = () => { if (viewerBlob) { viewerBlob.revoke(); setViewerBlob(null) }; setViewerLoading(false) }

  if (loading) return <LoadingScreen />

  const openDoc = async (doc) => {
    // External link → new tab
    if (doc.externalUrl) {
      window.open(doc.externalUrl, '_blank', 'noopener,noreferrer')
      return
    }
    try {
      setViewerName(doc.name || doc.fileName || 'Document')
      setViewerLoading(true)
      setViewerBlob(null)
      const d = await getDocData(doc.id)
      if (!d?.dataUrl) { setViewerLoading(false); return }
      const blob = dataUrlToBlobUrl(d.dataUrl)
      if (!blob) { setViewerLoading(false); return }
      setViewerBlob(blob)
    } catch { setViewerLoading(false) }
  }

  const order = orders.find(o => o.id === orderId)
  if (!order) return (
    <div>
      <FlexRow style={{ marginBottom: 18 }} gap={12}>
        <Btn variant="secondary" size="sm" onClick={onBack}>← Back</Btn>
      </FlexRow>
      <Card>
        <EmptyState icon="⚠️" title="Order not found" desc={`Order ${orderId} could not be loaded. It may have been removed or you may not have access.`} />
      </Card>
    </div>
  )

  // Auto-select if single assignment
  const effectiveMid = selectedMid || (order.assignments?.length === 1 ? String(order.assignments[0]?.mid) : null)
  const selectedAsgn = order.assignments?.find(a => String(a.mid) === effectiveMid) || null

  const mfrCompanyById = Object.fromEntries(
    (order.assignments || []).map(a => [String(a.mid), a.mfrCompany]).filter(([, c]) => c)
  )

  const mfrIds    = new Set((order.assignments || []).map(a => String(a.mid)))
  const orderDocs = docs.filter(d => String(d.orderId) === String(order.id) && d.isActive !== false)
  const txnDocs = effectiveMid
    ? orderDocs.filter(d => d.stageIndex == null || String(d.mfrId || '') === effectiveMid)
    : orderDocs
  const stageDocs = effectiveMid
    ? orderDocs.filter(d => d.stageIndex != null && String(d.mfrId || '') === effectiveMid)
    : []
  const compDocs  = docs.filter(d => d.mfrId && mfrIds.has(String(d.mfrId)) && d.isActive !== false && d.stageIndex == null)
  const expiring  = compDocs.filter(d => isExpiringSoon(d.expiryDate) || isExpired(d.expiryDate))

  // Notes from manufacturers worth surfacing (not visible in dashboard)
  const notes = (order.assignments || []).filter(a => a.note?.trim())

  // ── Assignment picker (multi-mfr orders) ──
  if (!effectiveMid && order.assignments?.length > 1) {
    return (
      <div>
        <FlexRow style={{ marginBottom: 18 }} gap={12}>
          <Btn variant="secondary" size="sm" onClick={onBack}>← Back</Btn>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Mono style={{ fontSize: 14, fontWeight: 800 }}>{order.id}</Mono>
            <div style={{ fontSize: 13, color: T.textMuted, marginTop: 3 }}>
              {order.product} · {order.totalQty?.toLocaleString()} pcs · Due {fmtDate(order.delivery)}
            </div>
          </div>
        </FlexRow>
        <div style={{ marginBottom: 12, fontSize: 13, fontWeight: 600, color: T.textMuted }}>Select a manufacturer to view transaction details:</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {order.assignments.map(a => {
            const stages = a.stages || []
            const totalDone = stages.reduce((s, st) => s + (st.unitsDone || 0), 0)
            const totalAll = stages.reduce((s, st) => s + (st.totalUnits || 0), 0)
            const pct = totalAll > 0 ? Math.round((totalDone / totalAll) * 100) : 0
            const stageCnt = orderDocs.filter(d => d.stageIndex != null && String(d.mfrId || '') === String(a.mid)).length
            return (
              <div key={a.mid}
                onClick={() => setSelectedMid(String(a.mid))}
                style={{ border: `1px solid ${T.border}`, borderRadius: 12, padding: '16px 18px', cursor: 'pointer', background: T.surface, transition: 'all 0.15s' }}
                onMouseEnter={e => { e.currentTarget.style.background = T.primaryLight; e.currentTarget.style.borderColor = T.primary }}
                onMouseLeave={e => { e.currentTarget.style.background = T.surface; e.currentTarget.style.borderColor = T.border }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <MfrProfileLink mfrId={a.mid} mfrName={a.mfrCompany || 'Manufacturer'} docs={docs} onGetData={getDocData} />
                  <span style={{ fontSize: 10, fontWeight: 700, color: T.textLight, background: '#f1f5f9', padding: '1px 6px', borderRadius: 4 }}>{a.sub}</span>
                  <Badge status={a.status} />
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: T.textMuted }}>{a.qty?.toLocaleString()} pcs</span>
                </div>
                <div style={{ height: 6, background: '#f1f5f9', borderRadius: 4, overflow: 'hidden', marginBottom: 6 }}>
                  <div style={{ height: 6, background: pct >= 100 ? T.success : T.primary, borderRadius: 4, width: `${pct}%`, transition: 'width 0.3s' }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: T.textMuted }}>
                  <span>{pct}% complete · {stages.filter(s => s.unitsDone >= s.totalUnits && s.totalUnits > 0).length}/{stages.length} stages done</span>
                  {stageCnt > 0 && <span style={{ color: '#1d4ed8' }}>{stageCnt} stage doc{stageCnt !== 1 ? 's' : ''}</span>}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  const viewer = (viewerBlob || viewerLoading) && (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.75)', zIndex: 2000, display: 'flex', flexDirection: 'column' }}
      onClick={e => e.target === e.currentTarget && closeViewer()}>
      <div style={{ height: 48, background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', flexShrink: 0, gap: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{viewerName}</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {viewerBlob && (
            <button onClick={() => { const a = document.createElement('a'); a.href = viewerBlob.url; a.download = viewerName; a.click() }}
              style={{ background: '#1e293b', border: '1px solid #334155', color: '#e2e8f0', borderRadius: 7, padding: '0 12px', height: 32, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>⬇ Download</button>
          )}
          <button onClick={closeViewer}
            style={{ background: '#ef4444', border: 'none', color: '#fff', borderRadius: 7, width: 32, height: 32, fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit' }}>×</button>
        </div>
      </div>
      {viewerLoading && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, background: '#0f172a' }}>
          <div style={{ width: 40, height: 40, border: '3px solid #334155', borderTopColor: '#f97316', borderRadius: '50%', animation: 'tradio-spin 0.7s linear infinite' }} />
          <div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8' }}>Loading document…</div>
        </div>
      )}
      {viewerBlob && (
        viewerBlob.mimeType?.startsWith('image/') ? (
          <div style={{ flex: 1, overflow: 'auto', display: viewerLoading ? 'none' : 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
            <img src={viewerBlob.url} alt={viewerName} onLoad={() => setViewerLoading(false)} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
          </div>
        ) : (
          <iframe src={viewerBlob.url} title={viewerName} onLoad={() => setViewerLoading(false)}
            style={{ flex: 1, border: 'none', width: '100%', minHeight: 0, display: viewerLoading ? 'none' : 'block' }} />
        )
      )}
    </div>
  )

  return (
    <div>
      {viewer}
      {/* ── Header ── */}
      <FlexRow style={{ marginBottom: 18 }} gap={12}>
        <Btn variant="secondary" size="sm" onClick={onBack}>← Back</Btn>
        <ProductThumb order={order} size="lg" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Mono style={{ fontSize: 14, fontWeight: 800 }}>{order.id}</Mono>
          <div style={{ fontSize: 13, color: T.textMuted, marginTop: 3 }}>
            {order.product}
            {order.category && (
              <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: T.textLight, background: '#f1f5f9', padding: '1px 6px', borderRadius: 4 }}>{order.category}</span>
            )}
            {order.season && <span style={{ marginLeft: 6, color: T.textLight }}>· {order.season}</span>}
            <span style={{ marginLeft: 6 }}>· {order.totalQty?.toLocaleString()} pcs</span>
            <span style={{ marginLeft: 6 }}>· Due {fmtDate(order.delivery)}</span>
          </div>
        </div>
      </FlexRow>

      {/* ── Compliance warning ── */}
      {expiring.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <Alert type="warning">
            <strong>{expiring.length} compliance certificate{expiring.length > 1 ? 's' : ''}</strong> expiring or expired for manufacturer(s) on this order.
          </Alert>
        </div>
      )}

      {/* ── Manufacturer notes (surfaced outside tabs since not shown in dashboard) ── */}
      {notes.length > 0 && (
        <div style={{ marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {notes.map(a => (
            <div key={a.id || a.sub} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: '11px 14px' }}>
              <span style={{ fontSize: 15, flexShrink: 0 }}>💬</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: T.textMuted }}><MfrProfileLink mfrId={a.mid} mfrName={a.mfrCompany || 'Manufacturer'} docs={docs} onGetData={getDocData} /> · {a.sub}</span>
                  <Badge status={a.status} />
                </div>
                <div style={{ fontSize: 13, color: T.text }}>{a.note}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Tabs ── */}
      <Card pad={false}>
        <Tabs
          tabs={[
            { id: 'progress',   label: '📊 Progress' },
            { id: 'docs',       label: `📋 Order Docs (${txnDocs.filter(d => d.stageIndex == null).length})` },
            { id: 'stage_evidence', label: `🖼 Stage Evidence (${stageDocs.length})` },
            { id: 'compliance', label: `🛡 Compliance (${compDocs.length})` },
          ]}
          active={tab}
          onChange={setTab}
        />

        <div style={{ padding: 20 }}>
          {/* ── TAB: Progress ── */}
          {tab === 'progress' && (
            <div>
              {(effectiveMid ? (order.assignments || []).filter(a => String(a.mid) === effectiveMid) : (order.assignments || [])).map((a, ai) => {
                const stages = a.stages || []
                const totalDone = stages.reduce((s, st) => s + (st.unitsDone || 0), 0)
                const totalAll = stages.reduce((s, st) => s + (st.totalUnits || 0), 0)
                const overallPct = totalAll > 0 ? Math.round((totalDone / totalAll) * 100) : 0

                return (
                  <div key={a.id || ai} style={{ marginBottom: ai < order.assignments.length - 1 ? 28 : 0 }}>
                    {/* Assignment header */}
                    {order.assignments.length > 1 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}><MfrProfileLink mfrId={a.mid} mfrName={a.mfrCompany || 'Manufacturer'} docs={docs} onGetData={getDocData} /></span>
                        <span style={{ fontSize: 10, fontWeight: 700, color: T.textLight, background: '#f1f5f9', padding: '1px 6px', borderRadius: 4 }}>{a.sub}</span>
                        <Badge status={a.status} />
                        <span style={{ fontSize: 11, color: T.textMuted, marginLeft: 'auto' }}>{a.qty?.toLocaleString()} pcs</span>
                      </div>
                    )}

                    {/* Stage timeline (circle progress bar) */}
                    <div style={{ marginBottom: 16 }}>
                      <StageTimeline stages={stages} />
                    </div>

                    {/* Overall progress */}
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Overall Production Progress</span>
                        <span style={{ fontSize: 13, fontWeight: 800, color: overallPct >= 100 ? T.success : T.primary }}>{overallPct}%</span>
                      </div>
                      <div style={{ background: '#f1f5f9', borderRadius: 6, height: 10, overflow: 'hidden' }}>
                        <div style={{ width: `${overallPct}%`, height: '100%', background: overallPct >= 100 ? T.success : T.primary, borderRadius: 6, transition: 'width 0.3s' }} />
                      </div>
                      <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>{totalDone.toLocaleString()} / {totalAll.toLocaleString()} units across {stages.length} stages</div>
                    </div>

                    {/* Stage rows with inline evidence docs */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {stages.map((s, i) => {
                        const pct = s.totalUnits > 0 ? Math.round((s.unitsDone / s.totalUnits) * 100) : 0
                        const done = pct >= 100
                        const active = pct > 0 && !done
                        const stageDocs = orderDocs.filter(d =>
                          d.stageIndex === i &&
                          (order.assignments.length === 1 || String(d.mfrId || '') === String(a.mid))
                        )
                        return (
                          <div key={i} style={{
                            border: `1px solid ${done ? T.successBorder : active ? '#fed7aa' : T.border}`,
                            borderRadius: 10, overflow: 'hidden',
                            background: done ? '#fafffe' : active ? '#fffdf8' : T.surface,
                          }}>
                            {/* Stage header row */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px' }}>
                              {/* Step bubble */}
                              <div style={{
                                width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                                background: done ? T.success : active ? T.primary : '#e2e8f0',
                                color: done || active ? '#fff' : T.textLight,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: 11, fontWeight: 800,
                              }}>
                                {done ? '✓' : i + 1}
                              </div>

                              {/* Name + bar */}
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 13, fontWeight: 600, color: done ? T.success : active ? T.text : T.textMuted, marginBottom: 4 }}>
                                  {s.name}
                                </div>
                                <div style={{ background: '#e2e8f0', borderRadius: 4, height: 5, overflow: 'hidden' }}>
                                  <div style={{ width: `${pct}%`, height: '100%', background: done ? T.success : T.primary, borderRadius: 4, transition: 'width 0.3s' }} />
                                </div>
                              </div>

                              {/* Date — actual (stageDate) once recorded, else the planned ETA */}
                              {s.stageDate
                                ? <span style={{ fontSize: 11, fontWeight: 600, color: done ? T.success : T.primary, background: done ? T.successBg : T.primaryLight, padding: '2px 8px', borderRadius: 6, flexShrink: 0 }}>{fmtDate(s.stageDate)}</span>
                                : (s.eta && s.eta !== 'NA')
                                  ? <span style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, background: '#f1f5f9', padding: '2px 8px', borderRadius: 6, flexShrink: 0 }}>Due {fmtDate(s.eta)}</span>
                                  : <span style={{ fontSize: 11, color: T.textLight, fontStyle: 'italic', flexShrink: 0 }}>No date</span>
                              }

                              {/* Pct */}
                              <span style={{ fontSize: 13, fontWeight: 800, color: done ? T.success : active ? T.primary : T.textLight, flexShrink: 0, minWidth: 38, textAlign: 'right' }}>{pct}%</span>

                              {/* Docs badge — clickable to open first doc */}
                              {stageDocs.length > 0 && (
                                <button
                                  onClick={e => { e.stopPropagation(); openDoc(stageDocs[0]) }}
                                  style={{ fontSize: 10, fontWeight: 700, color: '#1d4ed8', background: '#dbeafe', border: '1px solid #bfdbfe', borderRadius: 10, padding: '2px 9px', flexShrink: 0, cursor: 'pointer', fontFamily: 'inherit' }}
                                  title={stageDocs.length > 1 ? `${stageDocs.length} files — scroll below to view all` : 'Click to view evidence'}
                                >
                                  👁 {stageDocs.length} evidence file{stageDocs.length !== 1 ? 's' : ''}
                                </button>
                              )}
                            </div>

                            {/* Evidence docs — only if present */}
                            {stageDocs.length > 0 && (
                              <div style={{ borderTop: `1px solid ${done ? T.successBorder : '#fed7aa'}`, padding: '8px 10px', background: done ? '#f0fdf4' : '#fffbf5', display: 'flex', flexDirection: 'column', gap: 0 }}>
                                <div style={{ fontSize: 9, fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6, paddingLeft: 4 }}>Evidence Documents</div>
                                {stageDocs.map(d => <DocCard key={d.id} doc={d} users={users} onGetData={getDocData} stageName={s.name} />)}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>

                  </div>
                )
              })}
              {(!order.assignments || order.assignments.length === 0) && (
                <EmptyState icon="📊" title="No assignments" desc="No manufacturer assignments found for this order" />
              )}
            </div>
          )}

          {tab === 'docs' && (
            <div>
              {txnDocs.filter(d => d.stageIndex == null).length === 0
                ? <EmptyState icon="📋" title="No order documents" desc="Upload a PO, Tech Pack, or other document for this order" />
                : <StageDocGroup
                    docs={txnDocs.filter(d => d.stageIndex == null)}
                    stages={selectedAsgn?.stages || order.assignments[0]?.stages || []}
                    users={users}
                    onGetData={getDocData}
                  />
              }
            </div>
          )}

          {tab === 'stage_evidence' && (
            <div>
              {stageDocs.length === 0 ? (
                <EmptyState icon="🖼" title="No stage evidence" desc="Images and documents uploaded by the manufacturer for each production stage will appear here" />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {(selectedAsgn?.stages || []).map((s, i) => {
                    const sDocs = stageDocs.filter(d => d.stageIndex === i)
                    if (sDocs.length === 0) return null
                    const pct = s.totalUnits > 0 ? Math.round((s.unitsDone / s.totalUnits) * 100) : 0
                    const done = pct >= 100
                    return (
                      <div key={i} style={{ border: `1px solid ${done ? T.successBorder : T.border}`, borderRadius: 12, overflow: 'hidden' }}>
                        <div style={{ padding: '10px 14px', background: done ? T.successBg : '#f8fafc', borderBottom: `1px solid ${done ? T.successBorder : T.border}`, display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{ width: 26, height: 26, borderRadius: '50%', background: done ? T.success : T.primary, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, flexShrink: 0 }}>
                            {done ? '✓' : i + 1}
                          </div>
                          <span style={{ fontSize: 13, fontWeight: 700, color: done ? T.success : T.text }}>{s.name}</span>
                          <span style={{ fontSize: 11, color: T.textMuted }}>{pct}%</span>
                          <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: '#1d4ed8', background: '#dbeafe', padding: '2px 8px', borderRadius: 10 }}>{sDocs.length} file{sDocs.length !== 1 ? 's' : ''}</span>
                        </div>
                        <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {sDocs.map(d => <DocCard key={d.id} doc={d} users={users} onGetData={getDocData} stageName={s.name} />)}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {tab === 'compliance' && (
            compDocs.length === 0
              ? <EmptyState icon="🛡" title="No compliance docs" desc="Manufacturer certificates will appear here" />
              : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {compDocs.map(d => {
                    const company = mfrCompanyById[String(d.mfrId)] || users.find(u => String(u.id) === String(d.mfrId))?.company
                    return (
                      <DocCard
                        key={d.id}
                        doc={{ ...d, name: company ? `${d.name} — ${company}` : d.name }}
                        users={users}
                        onGetData={getDocData}
                      />
                    )
                  })}
                </div>
          )}
        </div>
      </Card>
    </div>
  )
}
