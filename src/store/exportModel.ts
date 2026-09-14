// Shared intermediate model for document export.
// Parses editor HTML into a flat list of typed blocks; the DOCX and ODT
// builders each render these blocks with the active CSS theme applied.
import type { ThemeVars } from '../components/StylePanel'

// Heading font-size multiplier per level (1–4), shared by the DOCX/ODT exporters.
export const HEADING_SCALE = [2, 1.5, 1.25, 1.1]

export interface InlineRun {
  text: string
  bold?: boolean
  italic?: boolean
  strike?: boolean
  code?: boolean
  link?: string
}

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; runs: InlineRun[] }
  | { kind: 'paragraph'; runs: InlineRun[] }
  | { kind: 'quote'; runs: InlineRun[] }
  | { kind: 'codeBlock'; text: string }
  | { kind: 'list'; ordered: boolean; items: InlineRun[][] }
  | { kind: 'table'; header: string[]; rows: InlineRun[][][] } // rows → cells → runs
  | { kind: 'image'; dataUrl: string; alt: string }
  | { kind: 'hr' }

// ---- Theme helpers ----

export interface ExportTheme {
  font: string       // primary family name, e.g. "Georgia"
  fontSizePt: number // e.g. 12.75
  textColor: string  // hex without '#'
  bg: string
  headingColor: string
  accent: string
  codeFont: string
  codeBg: string
}

function firstFont(stack: string): string {
  return stack.split(',')[0].trim().replace(/^['"]|['"]$/g, '')
}

function pxToPt(px: string): number {
  const n = parseFloat(px)
  return isNaN(n) ? 12.75 : n * 0.75
}

export function themeFromVars(vars: ThemeVars): ExportTheme {
  return {
    font: firstFont(vars['--doc-font']),
    fontSizePt: pxToPt(vars['--doc-font-size']),
    textColor: vars['--doc-text-color'].replace('#', ''),
    bg: vars['--doc-bg'].replace('#', ''),
    headingColor: vars['--doc-heading-color'].replace('#', ''),
    accent: vars['--doc-accent'].replace('#', ''),
    codeFont: firstFont(vars['--doc-code-font']),
    codeBg: vars['--doc-code-bg'].replace('#', ''),
  }
}

// ---- HTML parsing ----

function parseInline(node: Node, run: Omit<InlineRun, 'text'>, out: InlineRun[]) {
  if (node.nodeType === Node.TEXT_NODE) {
    if (node.textContent) out.push({ ...run, text: node.textContent })
    return
  }
  if (!(node instanceof HTMLElement)) return
  const tag = node.tagName.toLowerCase()
  const next = { ...run }
  if (tag === 'strong' || tag === 'b') next.bold = true
  if (tag === 'em' || tag === 'i') next.italic = true
  if (tag === 's' || tag === 'del') next.strike = true
  if (tag === 'code') next.code = true
  if (tag === 'a') next.link = node.getAttribute('href') ?? undefined
  if (tag === 'br') { out.push({ ...run, text: '\n' }); return }
  for (const child of Array.from(node.childNodes)) parseInline(child, next, out)
}

function inlineOf(el: Element): InlineRun[] {
  const out: InlineRun[] = []
  for (const child of Array.from(el.childNodes)) parseInline(child, {}, out)
  return out
}

function cellText(el: Element): string {
  return el.textContent ?? ''
}

export function htmlToBlocks(html: string): Block[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const blocks: Block[] = []

  const walk = (el: Element) => {
    for (const node of Array.from(el.children)) {
      const tag = node.tagName.toLowerCase()
      if (/^h[1-4]$/.test(tag)) {
        blocks.push({ kind: 'heading', level: Number(tag[1]) as 1|2|3|4, runs: inlineOf(node) })
      } else if (tag === 'p') {
        // paragraphs that are just an image
        const img = node.querySelector('img')
        if (img && !node.textContent?.trim()) {
          blocks.push({ kind: 'image', dataUrl: img.getAttribute('src') ?? '', alt: img.getAttribute('alt') ?? '' })
        } else {
          blocks.push({ kind: 'paragraph', runs: inlineOf(node) })
        }
      } else if (tag === 'blockquote') {
        const runs: InlineRun[] = []
        for (const p of Array.from(node.querySelectorAll('p'))) runs.push(...inlineOf(p), { text: '\n' })
        blocks.push({ kind: 'quote', runs: runs.length ? runs : inlineOf(node) })
      } else if (tag === 'pre') {
        blocks.push({ kind: 'codeBlock', text: node.textContent ?? '' })
      } else if (tag === 'ul' || tag === 'ol') {
        const items = Array.from(node.querySelectorAll(':scope > li')).map((li) => inlineOf(li))
        blocks.push({ kind: 'list', ordered: tag === 'ol', items })
      } else if (tag === 'table') {
        const headerRow = node.querySelector('thead tr, tr')
        const header = headerRow ? Array.from(headerRow.querySelectorAll('th,td')).map(cellText) : []
        const bodyRows = Array.from(node.querySelectorAll('tbody tr')).length
          ? Array.from(node.querySelectorAll('tbody tr'))
          : Array.from(node.querySelectorAll('tr')).slice(1)
        const rows = bodyRows.map((tr) =>
          Array.from(tr.querySelectorAll('td,th')).map((td) => inlineOf(td)),
        ).filter((row) => row.length > 0)
        blocks.push({ kind: 'table', header, rows })
      } else if (tag === 'hr') {
        blocks.push({ kind: 'hr' })
      } else if (tag === 'img') {
        blocks.push({ kind: 'image', dataUrl: node.getAttribute('src') ?? '', alt: node.getAttribute('alt') ?? '' })
      } else {
        walk(node) // divs etc.
      }
    }
  }
  walk(doc.body)
  return blocks
}
