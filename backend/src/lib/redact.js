// Request-log helper: describes a request body without ever printing its values.
const SENSITIVE_FIELDS = new Set(['password', 'currentPassword', 'newPassword', 'passwordHash', 'Authorization'])

// A rejected request used to log its whole body: up to 14 MB of base64 for a refused upload, plus
// emails, phone numbers and notes. Now only the field names, types and sizes are logged, which is
// enough to see what shape of request failed. A short allowlist of identifiers keeps their values.
const LOGGABLE_VALUES = new Set(['id', 'orderId', 'mfrId', 'status', 'kind', 'type', 'index', 'stageIndex', 'lineIndex'])

export function redact(obj) {
  if (!obj || typeof obj !== 'object') return typeof obj
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_FIELDS.has(k)) out[k] = '[REDACTED]'
    else if (LOGGABLE_VALUES.has(k) && (typeof v === 'string' || typeof v === 'number') && String(v).length <= 100) out[k] = v
    else if (typeof v === 'string') out[k] = `string(${v.length})`
    else if (Array.isArray(v)) out[k] = `array(${v.length})`
    else if (v && typeof v === 'object') out[k] = `object(${Object.keys(v).length} keys)`
    else out[k] = typeof v
  }
  return out
}
