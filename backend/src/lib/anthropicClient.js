import Anthropic from '@anthropic-ai/sdk'

// Shared lazy Anthropic client bootstrap — extracted from assistant.js so
// materialsAi.js (the AI BOM-draft feature, a one-shot structured-extraction
// call with nothing in common with assistant.js's chat/tool-loop machinery
// beyond "uses Anthropic") doesn't duplicate it. Lazy so importing either
// file never throws just because ANTHROPIC_API_KEY is unset.
export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'

let anthropicClient = null
export function getClient() {
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return anthropicClient
}
