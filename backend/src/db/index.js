import mongoose from 'mongoose'

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 3000

export async function connectDB() {
  const uri = process.env.MONGO_DB_URI
  if (!uri) throw new Error('MONGO_DB_URI is not set in environment variables')

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        maxPoolSize: 10,
      })
      console.log(`MongoDB connected: ${mongoose.connection.host}`)

      // Log disconnection events
      mongoose.connection.on('disconnected', () => {
        console.warn(`[${new Date().toISOString()}] MongoDB disconnected`)
      })
      mongoose.connection.on('reconnected', () => {
        console.log(`[${new Date().toISOString()}] MongoDB reconnected`)
      })
      mongoose.connection.on('error', (err) => {
        console.error(`[${new Date().toISOString()}] MongoDB error:`, err.message)
      })

      return
    } catch (err) {
      console.error(`MongoDB connection attempt ${attempt}/${MAX_RETRIES} failed:`, err.message)
      if (attempt === MAX_RETRIES) throw err
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
    }
  }
}

// Re-export models so routes can import from a single place
export { User }         from '../models/User.js'
export { Order }        from '../models/Order.js'
export { Document }     from '../models/Document.js'
export { Notification } from '../models/Notification.js'
export { AuditLog }     from '../models/AuditLog.js'
export { Ribbon }       from '../models/Ribbon.js'
export { MasterOrder }  from '../models/MasterOrder.js'
