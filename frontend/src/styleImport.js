// Pure helpers for importing a sheet of styles: reading the chosen file, the template to download, and the line that
// tells Kriyaa which upload an admin attached to a chat message.

export const MAX_SHEET_BYTES = 8 * 1024 * 1024
export const SHEET_ACCEPT = '.xlsx,.csv'

/** The problem with a chosen file, or '' when it can be uploaded. */
export function sheetFileProblem(file) {
  if (!file) return 'Choose a file.'
  if (!/\.(xlsx|csv)$/i.test(file.name || '')) return 'Choose an Excel (.xlsx) or CSV (.csv) file.'
  if (file.size > MAX_SHEET_BYTES) return 'That file is over 8MB.'
  if (!file.size) return 'That file is empty.'
  return ''
}

/** The file as { filename, data } with data base64 (no data: prefix), the shape the upload route takes. */
export function readSheetFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ filename: file.name, data: String(reader.result).replace(/^data:[^,]*,/, '') })
    reader.onerror = () => reject(new Error('Could not read that file.'))
    reader.readAsDataURL(file)
  })
}

// The columns the importer reads. Factory, cost and price columns are not part of it (and are ignored if present).
export const TEMPLATE_HEADER = ['Brand', 'Style No', 'Description', 'Image', 'Amazon link', 'Fabric', 'Stage', 'Category', 'Tech pack link', 'Quantity', 'Colours']
export const TEMPLATE_EXAMPLE = ['FYLTR', 'FYLSS26WD-4002', "Women's Cotton Midi Dress with Belt", 'https://example.com/photo.jpg', 'https://www.amazon.in/dp/B0EXAMPLE', 'Cotton Poplin', 'Replen', 'DRESS', '', '', 'Blue; White']
const cell = v => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
export const templateCsv = () => [TEMPLATE_HEADER, TEMPLATE_EXAMPLE].map(r => r.map(cell).join(',')).join('\n') + '\n'

export function downloadTemplate() {
  const url = URL.createObjectURL(new Blob([templateCsv()], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url; a.download = 'style-import-template.csv'
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// The line put at the start of a chat message that carries an attached sheet. Kriyaa's instructions describe it; the
// upload id in it is checked by the server (shape, and that the sender owns the upload).
const safeName = name => String(name || 'sheet').replace(/["\[\]()\n\r]/g, '_').slice(0, 120)
export const attachmentLine = ({ id, filename }) => `[Attached style sheet: "${safeName(filename)}" (upload id ${id})]`
const LINE = /^\[Attached style sheet: "([^"]*)" \(upload id (imp_[a-f0-9]{16})\)\]\n?/

/** A chat message split into its attached sheet (or null) and the rest of the text. */
export function splitAttachment(content) {
  const m = LINE.exec(String(content || ''))
  return m ? { attachment: { filename: m[1], id: m[2] }, text: content.slice(m[0].length) } : { attachment: null, text: content }
}

/** The text actually sent for a message: the attachment line, then what the admin typed. */
export const withAttachment = (text, attachment) =>
  attachment ? `${attachmentLine(attachment)}\n${text || 'Please create these styles.'}` : text

// A tidy label for a stage value from the importer.
export const STAGE_LABELS = { development: 'NPD', replen: 'Replen' }
