import mongoose from 'mongoose'

// A spreadsheet of styles waiting to be previewed and created (routes/styleImports.js). It is held for an hour so the
// Import styles window and Kriyaa can each preview and then create from the same upload without the file travelling
// again; MongoDB removes it on its own. Owned by the admin who uploaded it: nobody else can read or use it.
const styleImportUploadSchema = new mongoose.Schema({
  _id:        { type: String },                                   // imp_ + 16 hex characters
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  filename:   { type: String, required: true, maxlength: 200 },
  data:       { type: Buffer, required: true },
  // Set while a create is running, so a double click or a repeated Kriyaa call cannot create the styles twice.
  committing: { type: Boolean, default: false },
  createdAt:  { type: Date, default: Date.now, expires: 60 * 60 },
})

export const StyleImportUpload = mongoose.model('StyleImportUpload', styleImportUploadSchema)
