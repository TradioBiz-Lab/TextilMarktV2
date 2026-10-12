import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { PHOTO_PROMPT, DOCUMENT_PROMPT, textPrompt } from './prompts.js'

const MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'

const conf = z.number().min(0).max(1)
const nullableStr = z.string().nullish().transform(v => v ?? null)

export const photoSchema = z.object({
  stage: z.string(),
  confidence: conf,
  issues: z.array(z.string()).default([]),
  description: z.string().default(''),
  style_hint: nullableStr,
})

export const documentSchema = z.object({
  doc_type: nullableStr,
  party_from: nullableStr,
  party_to: nullableStr,
  date: nullableStr,
  style_codes: z.array(z.string()).default([]),
  items: z.array(z.object({
    description: nullableStr,
    qty: z.number().nullish().transform(v => v ?? null),
    unit: nullableStr,
  })).default([]),
  implied_stage: nullableStr,
  confidence: conf,
})

export const textSchema = z.object({
  updates: z.array(z.object({
    style_hint: nullableStr,
    stage: z.string(),
    status: z.enum(['done', 'in_progress', 'issue']),
    expected_date: nullableStr,
    note: z.string().nullish().transform(v => v ?? ''),
  })),
  confidence: conf,
})

let client = null
const getClient = () => (client ||= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }))

/** Pulls the outermost JSON object out of a model reply (tolerates code fences). */
export function parseJsonReply(text) {
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('no JSON object in reply')
  return JSON.parse(text.slice(a, b + 1))
}

/**
 * One Claude call returning strict, schema-validated JSON, with the reason when it fails. Retries once on
 * a parse/validation failure. `model` and `maxTokens` let a caller with a bigger job (a whole tech pack)
 * ask for more than the short message prompts do.
 * @returns {Promise<{ data: object | null, error: string | null }>}
 */
export async function callJsonDetailed({ content, schema, sdk = getClient(), model = MODEL(), maxTokens = 1024 }) {
  let error = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await sdk.messages.create({
        model, max_tokens: maxTokens,
        messages: [{ role: 'user', content }],
      })
      const text = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
      return { data: schema.parse(parseJsonReply(text)), error: null }
    } catch (err) {
      error = err.message
      console.error(`[ai] extraction attempt ${attempt + 1} failed:`, err.message)
    }
  }
  return { data: null, error }
}

/**
 * One Claude call returning strict, schema-validated JSON; null after a failed retry so the caller
 * routes the message to human review instead of writing a guess.
 */
export async function callJson(opts) {
  return (await callJsonDetailed(opts)).data
}

export const mediaBlock = (buffer, mimeType) => mimeType === 'application/pdf'
  ? { type: 'document', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } }
  : { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } }

export const extractPhoto = (buffer, mimeType, opts) =>
  callJson({ content: [mediaBlock(buffer, mimeType), { type: 'text', text: PHOTO_PROMPT }], schema: photoSchema, ...opts })

export const extractDocument = (buffer, mimeType, opts) =>
  callJson({ content: [mediaBlock(buffer, mimeType), { type: 'text', text: DOCUMENT_PROMPT }], schema: documentSchema, ...opts })

export const extractText = (text, activeOrders, opts) =>
  callJson({ content: [{ type: 'text', text: `${textPrompt(activeOrders)}\n\nMessage:\n${text}` }], schema: textSchema, ...opts })
