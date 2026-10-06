// Provider-agnostic WhatsApp seam. A real provider (decided later) implements
// InboundAdapter.normalize and OutboundAdapter; the pipeline never sees a
// provider payload, only the normalized shape below:
//   {sender_number, type, media_bytes (Buffer) | null, mime_type, text, received_at}
//
// Provider media is deliberately NOT fetched from a URL in the payload: that
// would let a webhook caller point the server at arbitrary hosts. A real
// adapter fetches from its provider's own known API host inside normalize().

export class InboundAdapter {
  /** @returns {Promise<{sender_number:string,type:string,media_bytes:Buffer|null,mime_type:string|null,text:string,received_at:Date}>} */
  // eslint-disable-next-line no-unused-vars
  async normalize(_payload) { throw new Error('not implemented') }
}

export class OutboundAdapter {
  // eslint-disable-next-line no-unused-vars
  async sendText(_to, _text) { throw new Error('not implemented') }
  // eslint-disable-next-line no-unused-vars
  async sendList(_to, _body, _options) { throw new Error('not implemented') }
}

const TYPES = ['image', 'audio', 'document', 'text']

/** Mock provider: payload is already close to the normalized shape, media is inline base64. */
export class MockInboundAdapter extends InboundAdapter {
  async normalize(payload) {
    const p = payload || {}
    if (!p.sender_number || typeof p.sender_number !== 'string') throw new Error('sender_number required')
    if (!TYPES.includes(p.type)) throw new Error('type must be image, audio, document or text')
    let media = null
    if (p.type !== 'text') {
      if (typeof p.media_base64 !== 'string' || !p.media_base64) throw new Error('media_base64 required for media messages')
      media = Buffer.from(p.media_base64, 'base64')
    }
    return {
      sender_number: p.sender_number,
      type: p.type,
      media_bytes: media,
      mime_type: p.mime_type || null,
      text: typeof p.text === 'string' ? p.text : '',
      received_at: p.received_at ? new Date(p.received_at) : new Date(),
    }
  }
}

export class MockOutboundAdapter extends OutboundAdapter {
  constructor() { super(); this.sent = [] }
  async sendText(to, text) { this.sent.push({ to, text }) }
  async sendList(to, body, options) { this.sent.push({ to, body, options }) }
}

const INBOUND = { mock: new MockInboundAdapter() }
export const getInboundAdapter = provider => INBOUND[provider] || null
export const outbound = new MockOutboundAdapter()
