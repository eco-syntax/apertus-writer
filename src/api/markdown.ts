import DOMPurify from 'dompurify'
import { marked } from 'marked'

// Render markdown from untrusted sources (e.g. LLM replies) to HTML with all
// script vectors stripped: event handlers, javascript: URLs, script/iframe, etc.
export function renderMarkdown(md: string): string {
  return DOMPurify.sanitize(marked.parse(md, { async: false }) as string)
}