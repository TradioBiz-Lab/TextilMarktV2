import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ breaks: true })

// Wiki pages are admin-authored Markdown, stored as plain text — never trusted
// as raw HTML. marked passes inline HTML straight through by default, so every
// render goes through DOMPurify before it can reach the DOM (same XSS-prevention
// posture as the data: URL validation in documents.js's upload route).
export function renderMarkdownSafe(markdown) {
  return DOMPurify.sanitize(marked.parse(markdown || ''))
}
