import mongoose from 'mongoose'

export const MESSAGE_TYPES = ['image', 'audio', 'document', 'text']
export const MESSAGE_STATES = ['new', 'auto_applied', 'needs_review', 'applied', 'rejected']

// One stage change this message caused, with the "before" snapshot so a
// coordinator rejecting the message can revert exactly what the AI did.
const changeSchema = new mongoose.Schema({
  orderId:    { type: String, required: true },
  mfrId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  stageIndex: { type: Number, required: true },
  stageName:  { type: String, default: '' },
  before:     { type: mongoose.Schema.Types.Mixed, default: {} },
  after:      { type: mongoose.Schema.Types.Mixed, default: {} },
}, { _id: false })

// The raw inbound message is the audit trail: media bytes (dataUrl), the
// transcript/caption, and the model's parsed JSON are kept forever. Never
// deleted by the pipeline, only moved between states.
const inboundMessageSchema = new mongoose.Schema({
  factoryId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  senderNumber: { type: String, default: null },
  channel:     { type: String, enum: ['whatsapp', 'web'], required: true },
  type:        { type: String, enum: MESSAGE_TYPES, required: true },
  dataUrl:     { type: String, default: null },
  mimeType:    { type: String, default: null },
  rawText:     { type: String, default: '' },     // caption, text body, or transcript
  parsed:      { type: mongoose.Schema.Types.Mixed, default: null },
  confidence:  { type: Number, default: null },
  orderId:     { type: String, default: null },
  stageApplied: { type: String, default: null },
  state:       { type: String, enum: MESSAGE_STATES, default: 'new' },
  reviewReason: { type: String, default: '' },
  hasDefect:   { type: Boolean, default: false },
  changes:     [changeSchema],
  reviewedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt:  { type: Date, default: null },
  receivedAt:  { type: Date, default: Date.now },
}, { timestamps: true })

inboundMessageSchema.index({ state: 1, createdAt: 1 })
inboundMessageSchema.index({ orderId: 1, createdAt: -1 })
inboundMessageSchema.index({ factoryId: 1, createdAt: -1 })

export const InboundMessage = mongoose.model('InboundMessage', inboundMessageSchema)
