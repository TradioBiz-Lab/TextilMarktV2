import { Resend } from 'resend'

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null

const FROM = process.env.EMAIL_FROM || 'TextilMarkt <noreply@textilmarkt.com>'
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173'

// ── Helpers ──────────────────────────────────────────────────────────────────

// Escape user-controlled strings before interpolating into HTML email bodies.
// Without this, signup form / document name / company fields could inject
// HTML or links into the email recipient's inbox.
function esc(v) {
  if (v == null) return ''
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Escape values used inside an href/src attribute. Disallows javascript:/data:
// schemes — falls back to "#" if a non-http(s)/mailto scheme is supplied.
function escUrl(u) {
  if (u == null) return '#'
  const s = String(u).trim()
  if (!/^(https?:|mailto:)/i.test(s)) return '#'
  return esc(s)
}

function header(title) {
  return `
    <div style="background:#0f172a;padding:24px 32px;border-radius:12px 12px 0 0">
      <span style="font-size:20px;font-weight:800;color:#93a3d1;font-family:system-ui">Textil</span><span style="font-size:20px;font-weight:800;color:#d4956a;font-family:system-ui">Markt</span>
      <div style="font-size:10px;color:#475569;margin-top:4px;letter-spacing:0.08em;text-transform:uppercase">powered by Tradio</div>
    </div>
    <div style="padding:28px 32px">
      <h2 style="margin:0 0 16px;font-size:18px;color:#1e293b;font-family:system-ui">${esc(title)}</h2>
  `
}

function footer() {
  return `
    </div>
    <div style="padding:16px 32px;background:#f8fafc;border-radius:0 0 12px 12px;border-top:1px solid #e2e8f0">
      <p style="margin:0;font-size:11px;color:#94a3b8;font-family:system-ui">
        This is an automated message from TextilMarkt. <a href="${escUrl(FRONTEND_URL)}" style="color:#f97316">Open Platform</a>
      </p>
    </div>
  `
}

function wrap(body) {
  return `
  <div style="max-width:560px;margin:0 auto;font-family:system-ui,-apple-system,sans-serif;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden">
    ${body}
  </div>`
}

function badge(status) {
  const colors = {
    Processing: '#3b82f6', 'On Hold': '#f59e0b', Delayed: '#ef4444', Delivered: '#22c55e',
  }
  const c = colors[status] || '#64748b'
  return `<span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700;color:#fff;background:${c}">${esc(status)}</span>`
}

// `label` is always a literal; `value` may be either a plain user-controlled
// string (escaped here) OR a callsite-built HTML fragment (e.g. `<code>…</code>`
// produced from a literal template). Templates that need to embed user input
// inside the value MUST esc() the user portion before passing it in.
function row(label, value) {
  return `<tr><td style="padding:6px 0;color:#64748b;font-size:13px;width:140px">${esc(label)}</td><td style="padding:6px 0;font-size:13px;font-weight:600;color:#1e293b">${value}</td></tr>`
}

function table(rows) {
  return `<table style="width:100%;border-collapse:collapse">${rows}</table>`
}

function btn(text, url) {
  return `<div style="margin:20px 0"><a href="${escUrl(url)}" style="display:inline-block;padding:10px 24px;background:#f97316;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:13px">${esc(text)}</a></div>`
}

// ── Send function (no-op if RESEND_API_KEY not set) ────────────────────────

export async function sendEmail({ to, subject, html }) {
  if (!resend) {
    if (process.env.NODE_ENV !== 'test') {
      console.log(`[Email skipped — no RESEND_API_KEY] To: ${to}, Subject: ${subject}`)
    }
    return null
  }
  // Send one Resend API call per recipient rather than one call with multiple
  // "to" addresses — a single multi-recipient send was failing outright, and
  // sending individually also means one bad address can't block the others.
  const recipients = Array.isArray(to) ? to : [to]
  const results = []
  for (const recipient of recipients) {
    try {
      results.push(await resend.emails.send({ from: FROM, to: [recipient], subject, html }))
    } catch (err) {
      console.error(`[Email failed] To: ${recipient}, Subject: ${subject}`, err.message)
      results.push(null)
    }
  }
  return recipients.length === 1 ? results[0] : results
}

// ── Email templates ─────────────────────────────────────────────────────────

export function emailUserCreated({ name, email, password, role, company }) {
  const roleLabel = role === 'buyer' ? 'Buyer' : role === 'manufacturer' ? 'Manufacturer' : 'Admin'
  const html = wrap(
    header('Welcome to TextilMarkt') +
    `<p style="font-size:14px;color:#334155;line-height:1.6;margin:0 0 16px">Hi <strong>${esc(name)}</strong>, your ${esc(roleLabel)} account has been created.</p>` +
    table(
      row('Email', esc(email)) +
      row('Temporary Password', `<code style="background:#f1f5f9;padding:2px 8px;border-radius:4px;font-size:13px">${esc(password)}</code>`) +
      row('Company', esc(company)) +
      row('Role', esc(roleLabel))
    ) +
    `<div style="margin:16px 0;padding:12px 16px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-size:13px;color:#92400e">
      You must change your password on first login.
    </div>` +
    btn('Sign In', `${FRONTEND_URL}?login=1`) +
    footer()
  )
  return { to: email, subject: 'Your TextilMarkt Account is Ready', html }
}

export function emailPasswordReset({ name, email, tempPassword }) {
  const html = wrap(
    header('Password Reset') +
    `<p style="font-size:14px;color:#334155;line-height:1.6;margin:0 0 16px">Hi <strong>${esc(name)}</strong>, your password has been reset by the platform administrator.</p>` +
    table(
      row('New Temporary Password', `<code style="background:#f1f5f9;padding:2px 8px;border-radius:4px;font-size:13px">${esc(tempPassword)}</code>`)
    ) +
    `<div style="margin:16px 0;padding:12px 16px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-size:13px;color:#92400e">
      You will be required to change this password on next login.
    </div>` +
    btn('Sign In', `${FRONTEND_URL}?login=1`) +
    footer()
  )
  return { to: email, subject: 'TextilMarkt — Password Reset', html }
}

export function emailOrderCreated({ to, orderId, product, qty, delivery, buyerCompany, role }) {
  const isBuyer = role === 'buyer'
  const html = wrap(
    header('New Order Created') +
    `<p style="font-size:14px;color:#334155;line-height:1.6;margin:0 0 16px">${isBuyer
      ? 'A new order has been created for your company.'
      : 'A new order has been assigned to you.'}</p>` +
    table(
      row('Order ID', `<code style="background:#f1f5f9;padding:2px 8px;border-radius:4px">${esc(orderId)}</code>`) +
      row('Product', esc(product)) +
      row('Quantity', `${esc(Number(qty).toLocaleString())} pcs`) +
      row('Delivery Date', esc(delivery)) +
      (isBuyer ? '' : row('Buyer', esc(buyerCompany || '—')))
    ) +
    btn('View Order', `${FRONTEND_URL}`) +
    footer()
  )
  return { to, subject: `New Order: ${orderId}`, html }
}

export function emailStageUpdated({ to, orderId, stageName, unitsDone, totalUnits, updatedBy }) {
  const pct = totalUnits > 0 ? Math.round((unitsDone / totalUnits) * 100) : 0
  const html = wrap(
    header('Production Update') +
    `<p style="font-size:14px;color:#334155;line-height:1.6;margin:0 0 16px">A production stage has been updated on your order.</p>` +
    table(
      row('Order ID', `<code style="background:#f1f5f9;padding:2px 8px;border-radius:4px">${esc(orderId)}</code>`) +
      row('Stage', esc(stageName)) +
      row('Progress', `${esc(unitsDone)} / ${esc(totalUnits)} units (${pct}%)`) +
      row('Updated By', esc(updatedBy))
    ) +
    `<div style="margin:16px 0;background:#f1f5f9;border-radius:6px;height:10px;overflow:hidden">
      <div style="width:${pct}%;height:100%;background:${pct >= 100 ? '#22c55e' : '#f97316'};border-radius:6px"></div>
    </div>` +
    btn('View Order', `${FRONTEND_URL}`) +
    footer()
  )
  return { to, subject: `Production Update: ${orderId} — ${stageName} ${pct}%`, html }
}

export function emailStatusChanged({ to, orderId, product, newStatus, note, changedBy }) {
  const html = wrap(
    header('Order Status Changed') +
    `<p style="font-size:14px;color:#334155;line-height:1.6;margin:0 0 16px">The status of an order has been updated.</p>` +
    table(
      row('Order ID', `<code style="background:#f1f5f9;padding:2px 8px;border-radius:4px">${esc(orderId)}</code>`) +
      row('Product', esc(product)) +
      row('New Status', badge(newStatus)) +
      row('Changed By', esc(changedBy)) +
      (note ? row('Note', esc(note)) : '')
    ) +
    btn('View Order', `${FRONTEND_URL}`) +
    footer()
  )
  return { to, subject: `Order ${orderId} → ${newStatus}`, html }
}

export function emailEscalation({ to, orderId, product, reason, escalatedBy, buyerCompany }) {
  const html = wrap(
    header('Order Escalation Alert') +
    `<div style="margin:0 0 16px;padding:12px 16px;background:#fff1f2;border:1px solid #fecdd3;border-radius:8px;font-size:13px;color:#9f1239;font-weight:600">
      A buyer has escalated an order — immediate attention required.
    </div>` +
    table(
      row('Order ID', `<code style="background:#f1f5f9;padding:2px 8px;border-radius:4px">${esc(orderId)}</code>`) +
      row('Product', esc(product || '—')) +
      row('Escalated By', `${esc(escalatedBy)} (${esc(buyerCompany)})`) +
      row('Reason', esc(reason))
    ) +
    btn('View Order', `${FRONTEND_URL}`) +
    footer()
  )
  return { to, subject: `ESCALATION: Order ${orderId}`, html }
}

export function emailCertExpiry({ to, certName, expiryDate, daysLeft, status }) {
  const isExpired = status === 'expired'
  const safeDaysLeft = Number.isFinite(Number(daysLeft)) ? Number(daysLeft) : 0
  const html = wrap(
    header(isExpired ? 'Certificate Expired' : 'Certificate Expiring Soon') +
    `<div style="margin:0 0 16px;padding:12px 16px;background:${isExpired ? '#fff1f2' : '#fffbeb'};border:1px solid ${isExpired ? '#fecdd3' : '#fde68a'};border-radius:8px;font-size:13px;color:${isExpired ? '#9f1239' : '#92400e'};font-weight:600">
      ${isExpired
        ? 'A compliance certificate has expired. Please renew immediately.'
        : `A compliance certificate is expiring in ${safeDaysLeft} day${safeDaysLeft !== 1 ? 's' : ''}.`}
    </div>` +
    table(
      row('Certificate', esc(certName)) +
      row('Expiry Date', esc(expiryDate)) +
      row('Status', isExpired ? '<span style="color:#ef4444;font-weight:700">Expired</span>' : `<span style="color:#f59e0b;font-weight:700">${safeDaysLeft} days remaining</span>`)
    ) +
    btn('View Certificates', `${FRONTEND_URL}`) +
    footer()
  )
  return { to, subject: `${isExpired ? 'EXPIRED' : 'EXPIRING'}: ${certName}`, html }
}

export function emailSignupInquiry({ name, email, company, phone, role, message }) {
  const TRADIO_EMAIL = (process.env.TRADIO_CONTACT_EMAIL || 'Tradio.sourcing@tradiobiz.com')
    .split(',').map(e => e.trim()).filter(Boolean)
  // The signup endpoint is public — every field here is attacker-controlled.
  const safeEmail = typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
    ? email.trim()
    : ''
  const html = wrap(
    header('New Sign-Up Inquiry') +
    `<div style="margin:0 0 16px;padding:12px 16px;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;font-size:13px;color:#15803d;font-weight:600">
      A new user has submitted a sign-up request from the TextilMarkt platform.
    </div>` +
    table(
      row('Name', esc(name)) +
      row('Email', safeEmail ? `<a href="${escUrl('mailto:' + safeEmail)}" style="color:#f97316">${esc(safeEmail)}</a>` : esc(email || '—')) +
      row('Company', esc(company || '—')) +
      row('Phone', esc(phone || '—')) +
      row('Role Interest', esc(role || '—')) +
      (message ? row('Message', `<span style="white-space:pre-wrap">${esc(message)}</span>`) : '')
    ) +
    footer()
  )
  return { to: TRADIO_EMAIL, subject: `New Sign-Up Request: ${name} (${company || email})`, html }
}

export function emailBuyerDocumentReceived({ docName, docType, buyerName, buyerCompany, buyerEmail, orderId }) {
  const TRADIO_EMAIL = (process.env.TRADIO_CONTACT_EMAIL || 'Tradio.sourcing@tradiobiz.com')
    .split(',').map(e => e.trim()).filter(Boolean)
  const safeBuyerEmail = typeof buyerEmail === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail.trim())
    ? buyerEmail.trim()
    : ''
  const html = wrap(
    header('Buyer Document Received — Action Required') +
    `<div style="margin:0 0 16px;padding:12px 16px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;font-size:13px;color:#1d4ed8;font-weight:600">
      A buyer has submitted a document. Please review and take action.
    </div>` +
    table(
      row('Document', esc(docName)) +
      row('Type', esc(docType)) +
      (orderId ? row('Order ID', `<code style="background:#f1f5f9;padding:2px 8px;border-radius:4px">${esc(orderId)}</code>`) : row('Order ID', '—')) +
      row('Buyer', esc(buyerName || '—')) +
      row('Company', esc(buyerCompany || '—')) +
      row('Email', safeBuyerEmail ? `<a href="${escUrl('mailto:' + safeBuyerEmail)}" style="color:#f97316">${esc(safeBuyerEmail)}</a>` : '—')
    ) +
    btn('Open Platform', `${FRONTEND_URL}`) +
    footer()
  )
  return { to: TRADIO_EMAIL, subject: `Document Received: ${docName}${orderId ? ` — Order ${orderId}` : ''}`, html }
}

export function emailDocumentUploaded({ to, docName, docType, orderId, uploadedBy }) {
  const html = wrap(
    header('Document Uploaded') +
    `<p style="font-size:14px;color:#334155;line-height:1.6;margin:0 0 16px">A new document has been uploaded to an order.</p>` +
    table(
      row('Document', esc(docName)) +
      row('Type', esc(docType)) +
      row('Order ID', `<code style="background:#f1f5f9;padding:2px 8px;border-radius:4px">${esc(orderId)}</code>`) +
      row('Uploaded By', esc(uploadedBy))
    ) +
    btn('View Document', `${FRONTEND_URL}`) +
    footer()
  )
  return { to, subject: `New Document: ${docName} — Order ${orderId}`, html }
}
