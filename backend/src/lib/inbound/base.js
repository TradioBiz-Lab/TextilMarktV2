// The two interfaces a WhatsApp provider implements (see adapters.js for the mock and twilio.js for Twilio).

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
