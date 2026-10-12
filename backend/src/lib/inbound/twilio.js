// Twilio's WhatsApp channel, behind the same two interfaces as the mock provider (lib/inbound/adapters.js).
//
//   inbound   Twilio POSTs a form to /api/inbound/webhook/twilio for every message a factory sends our number. The call
//             is proved to come from Twilio by its X-Twilio-Signature (HMAC-SHA1 of the URL and the form, keyed by the
//             auth token): Twilio cannot send our shared-secret header, so this is its authentication.
//   media     a photo or voice note arrives as a URL. It is fetched ONLY from api.twilio.com (with the account's
//             credentials) and, after the one redirect Twilio makes, from Twilio's own storage hosts: a URL in a
//             webhook can never point this server at some other host.
//   outbound  a short reply ("challan read") through the Messages API. Free text works inside the 24 hours after the
//             factory last wrote; sending first, outside that window, needs an approved template (not built here).
//
// Settings: WHATSAPP_PROVIDER=twilio, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM (the sender's number,
// like +14155238886), and TWILIO_WEBHOOK_URL when the public address Twilio calls differs from what this server sees.
import crypto from 'node:crypto'
import { InboundAdapter, OutboundAdapter } from './base.js'

const API_HOST = 'api.twilio.com'
const STORAGE_HOSTS = [/(^|\.)twilio\.com$/i, /(^|\.)twiliocdn\.com$/i, /(^|\.)amazonaws\.com$/i]
export const MAX_MEDIA_BYTES = 8 * 1024 * 1024

// Tests stand in for Twilio's servers here, so no test reaches the network (and the global fetch stays the test client's).
let fetchForTests = null
export const setTwilioFetchForTests = fn => { fetchForTests = fn || null }
const send = (...args) => (fetchForTests || fetch)(...args)

export const twilioConfig = () => ({
  sid: process.env.TWILIO_ACCOUNT_SID || '', token: process.env.TWILIO_AUTH_TOKEN || '', from: process.env.TWILIO_WHATSAPP_FROM || '',
})
export const twilioConfigured = () => { const c = twilioConfig(); return !!(c.sid && c.token) }

/** Twilio's signature: base64 HMAC-SHA1 of the full URL followed by every form field (name, then value) sorted by name. */
export function twilioSignature(authToken, url, params = {}) {
  const data = Object.keys(params).sort().reduce((s, k) => s + (Array.isArray(params[k]) ? params[k].map(v => k + v).join('') : k + (params[k] ?? '')), url)
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64')
}

/** Was this request signed by Twilio with our auth token? (Compared in constant time.) */
export function validTwilioSignature(authToken, signature, url, params) {
  if (!authToken || !signature) return false
  const a = Buffer.from(String(signature)), b = Buffer.from(twilioSignature(authToken, url, params))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

const basic = (sid, token) => `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`

async function readCapped(res, max) {
  const declared = Number(res.headers.get('content-length'))
  if (declared > max) throw new Error('Media too large')
  const reader = res.body?.getReader?.()
  if (!reader) { const buf = Buffer.from(await res.arrayBuffer()); if (buf.length > max) throw new Error('Media too large'); return buf }
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > max) { await reader.cancel().catch(() => {}); throw new Error('Media too large') }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

/**
 * The bytes of a message's media. The URL must be Twilio's API on https; the one redirect to Twilio's storage is followed
 * without the account's credentials, and only to a Twilio or Amazon storage host.
 */
export async function fetchTwilioMedia(url, { sid, token, fetchImpl = send, maxBytes = MAX_MEDIA_BYTES } = {}) {
  let u
  try { u = new URL(url) } catch { throw new Error('Media link is not valid') }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== API_HOST) throw new Error('Media must come from Twilio')
  const first = await fetchImpl(u.toString(), { headers: { Authorization: basic(sid, token) }, redirect: 'manual' })
  let res = first
  if ([301, 302, 303, 307, 308].includes(first.status)) {
    let next
    try { next = new URL(first.headers.get('location') || '', u) } catch { throw new Error('Media link is not valid') }
    if (next.protocol !== 'https:' || !STORAGE_HOSTS.some(re => re.test(next.hostname))) throw new Error('Media must come from Twilio')
    res = await fetchImpl(next.toString(), { redirect: 'error' })
  }
  if (!res.ok) throw new Error(`Media could not be fetched (${res.status})`)
  return readCapped(res, maxBytes)
}

const mimeOf = v => String(v || '').split(';')[0].trim().toLowerCase()

export class TwilioInboundAdapter extends InboundAdapter {
  constructor({ sid, token, fetchImpl = send } = {}) { super(); this.sid = sid; this.token = token; this.fetchImpl = fetchImpl }

  /** @param {object} p  the form Twilio posted (From, Body, NumMedia, MediaUrl0, MediaContentType0, MessageSid) */
  async normalize(p = {}) {
    const from = String(p.From || '').replace(/^whatsapp:/i, '').trim()
    if (!from) throw new Error('From required')
    const out = { sender_number: from, type: 'text', media_bytes: null, mime_type: null, text: typeof p.Body === 'string' ? p.Body : '', received_at: new Date(), message_id: typeof p.MessageSid === 'string' ? p.MessageSid.slice(0, 64) : null }
    if ((parseInt(p.NumMedia, 10) || 0) > 0) {
      const mime = mimeOf(p.MediaContentType0)
      out.mime_type = mime
      out.type = mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : 'document'
      out.media_bytes = await fetchTwilioMedia(p.MediaUrl0, { sid: this.sid, token: this.token, fetchImpl: this.fetchImpl })
    }
    return out
  }
}

export class TwilioOutboundAdapter extends OutboundAdapter {
  constructor({ sid, token, from, fetchImpl = send } = {}) { super(); Object.assign(this, { sid, token, from, fetchImpl }) }

  async sendText(to, text) {
    const digits = String(to || '').replace(/\D/g, '')
    if (!this.from || digits.length < 8) throw new Error('No sender or recipient number')
    const body = new URLSearchParams({ From: `whatsapp:${this.from}`, To: `whatsapp:+${digits}`, Body: String(text).slice(0, 1500) })
    const r = await this.fetchImpl(`https://${API_HOST}/2010-04-01/Accounts/${this.sid}/Messages.json`, {
      method: 'POST', headers: { Authorization: basic(this.sid, this.token), 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    })
    if (!r.ok) throw new Error(`Twilio could not send the message (${r.status})`)
  }

  async sendList(to, bodyText, options = []) {
    return this.sendText(to, [bodyText, ...options.map((o, i) => `${i + 1}. ${o?.title || o}`)].join('\n'))
  }
}
