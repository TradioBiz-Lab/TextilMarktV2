import mammoth from 'mammoth'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
// Relies on pdfjs-dist's GlobalWorkerOptions.workerPort already being set —
// components/ui.jsx does this once at module load, and every page that can
// reach this importer already imports from ui.jsx first.
import * as pdfjsLib from 'pdfjs-dist'

const MAX_SOURCE_BYTES = 25 * 1024 * 1024 // 25MB — generous for a real SOP/tech pack doc

const turndownService = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
turndownService.use(gfm)

function readAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('Could not read file'))
    reader.readAsArrayBuffer(file)
  })
}

// docx → Markdown, images included inline as base64 data URIs (mammoth's
// default image handler already embeds them that way) — same format
// WikiPage.bodyMarkdown already expects and renders.
async function importDocx(arrayBuffer) {
  const { value: html, messages } = await mammoth.convertToHtml({ arrayBuffer })
  const markdown = turndownService.turndown(html)
  const warnings = messages.filter(m => m.type === 'warning').map(m => m.message)
  return { markdown, warnings }
}

// PDF → plain text only. PDFs don't carry the structural markup docx does
// (headings, lists, embedded images as separate objects with a real
// position), so this is a best-effort text dump per page, not a real
// Markdown reconstruction — always flagged to the admin as a warning.
async function importPdf(arrayBuffer) {
  const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
  const pages = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    pages.push(content.items.map(it => it.str).join(' '))
  }
  return {
    markdown: pages.join('\n\n'),
    warnings: ['PDF import extracts text only — images and formatting (headings, lists, tables) are not carried over. Review and reformat before saving.'],
  }
}

/**
 * @returns {Promise<{markdown: string, warnings: string[]}>}
 * @throws if the file is too large or an unsupported type
 */
export async function importDocument(file) {
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error(`File too large (max ${MAX_SOURCE_BYTES / (1024 * 1024)}MB)`)
  }
  const name = file.name.toLowerCase()
  const arrayBuffer = await readAsArrayBuffer(file)

  if (name.endsWith('.docx') || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return importDocx(arrayBuffer)
  }
  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    return importPdf(arrayBuffer)
  }
  if (name.endsWith('.doc')) {
    throw new Error('Legacy .doc files are not supported — please save as .docx first')
  }
  throw new Error('Unsupported file type — use .docx or .pdf')
}
