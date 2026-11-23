import mongoose from 'mongoose'

// One update from an Ops & QC coordinator on a step of a style, sent from the factory floor: what he typed or said,
// the photos and voice note with it (Documents that point back here with fieldUpdateId), and where and when. It does
// not change the plan. An account manager reads it on the Field Updates page, with what the AI made of it, and changes
// the step through the admin routes. It is Tradio's own until an admin releases it to the customer. Never deleted.
const colourSchema = new mongoose.Schema({ name: { type: String, maxlength: 80 }, note: { type: String, maxlength: 300 } }, { _id: false })

const fieldUpdateSchema = new mongoose.Schema({
  coordinatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  visitId:       { type: mongoose.Schema.Types.ObjectId, ref: 'FactoryVisit', required: true },
  factoryId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  orderId:       { type: String, ref: 'Order', required: true },
  buyerId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  stageIndex:    { type: Number, required: true, min: 0 },
  stageName:     { type: String, default: '', maxlength: 200 },
  // The step he first picked, kept when an admin moves the update to another step.
  movedFromStageIndex: { type: Number, default: null },

  text:     { type: String, default: '', maxlength: 2000 },
  viaVoice: { type: Boolean, default: false },   // the text began as speech (the recording is one of the documents)
  language: { type: String, default: null, maxlength: 12 },

  // Where the phone was when he saved, when it would say; `at` is the server's clock.
  at:       { type: Date, required: true },
  deviceAt: { type: Date, default: null },
  lat:      { type: Number, default: null, min: -90, max: 90 },
  lng:      { type: Number, default: null, min: -180, max: 180 },
  accuracy: { type: Number, default: null, min: 0 },

  // What the AI read in it, for the account manager to confirm. Suggestions only: nothing here touches the plan.
  ai: {
    state: { type: String, enum: ['off', 'pending', 'done', 'failed'], default: 'off' },
    summary: { type: String, default: '', maxlength: 400 },
    suggestedStageIndex: { type: Number, default: null },
    units: { type: Number, default: null, min: 0 },
    statusHint: { type: String, enum: ['started', 'finished', null], default: null },
    result: { type: String, enum: ['pass', 'fail', null], default: null },
    issues: { type: [{ type: String, maxlength: 300 }], default: [] },
    colours: { type: [colourSchema], default: [] },
    confidence: { type: Number, default: null, min: 0, max: 1 },
    at: { type: Date, default: null },
  },

  state:      { type: String, enum: ['new', 'actioned', 'dismissed'], default: 'new' },
  actionedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  actionedAt: { type: Date, default: null },
  applied:    { type: [{ type: String, maxlength: 200 }], default: [] },   // what the admin confirmed, in words

  // Shown to the customer only from here on.
  releasedAt: { type: Date, default: null },
  releasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true })

fieldUpdateSchema.index({ state: 1, createdAt: -1 })
fieldUpdateSchema.index({ orderId: 1, createdAt: -1 })
fieldUpdateSchema.index({ coordinatorId: 1, createdAt: -1 })

export const FieldUpdate = mongoose.model('FieldUpdate', fieldUpdateSchema)
