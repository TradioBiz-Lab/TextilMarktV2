import mongoose from 'mongoose'

// One visit by an Ops & QC coordinator to a factory: a check-in and, when he leaves, a check-out. `at` is the server's
// clock (the one that is trusted); `deviceAt` is what the phone said. `distanceM` is how far the phone was from the
// factory's pin (Manufacturer.geo), null when the factory has none. A visit left open past midnight in India is closed
// with closedBy 'auto' and no check-out: no time is invented. Visits are never deleted.
const pointSchema = new mongoose.Schema({
  at:        { type: Date, required: true },
  deviceAt:  { type: Date, default: null },
  lat:       { type: Number, required: true, min: -90, max: 90 },
  lng:       { type: Number, required: true, min: -180, max: 180 },
  accuracy:  { type: Number, default: null, min: 0 },
  distanceM: { type: Number, default: null, min: 0 },
}, { _id: false })

const factoryVisitSchema = new mongoose.Schema({
  coordinatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  factoryId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  checkIn:       { type: pointSchema, required: true },
  checkOut:      { type: pointSchema, default: null },
  closedBy:      { type: String, enum: ['coordinator', 'auto', null], default: null },
}, { timestamps: true })

factoryVisitSchema.index({ coordinatorId: 1, 'checkIn.at': -1 })
factoryVisitSchema.index({ factoryId: 1, 'checkIn.at': -1 })
// One open visit per coordinator, enforced by the database as well as the route.
factoryVisitSchema.index({ coordinatorId: 1 }, { unique: true, partialFilterExpression: { closedBy: null }, name: 'one_open_visit' })

export const FactoryVisit = mongoose.model('FactoryVisit', factoryVisitSchema)
