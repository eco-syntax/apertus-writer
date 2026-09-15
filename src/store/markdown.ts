import DOMPurify from 'dompurify'
import { marked } from 'marked'
import TurndownService from 'turndown'

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  hr: '---',
})

// Emit MarkdownGuide-style pipe tables (https://www.markdownguide.org/cheat-sheet/)
// instead of raw HTML. Pipe tables are single-line per row, so block content
// inside a cell is flattened to <br>. colspans/rowspans cannot be expressed
// in pipe syntax, so they are collapsed rather than padded.
turndown.addRule('table', {
  filter: ['table'],
  replacement: (_content, node) => {
    const table = node as HTMLElement
    // Only rows belonging directly to this table, not any nested tables —
    // querySelectorAll('tr') would otherwise grab nested-table rows too.
    const rows = Array.from(table.querySelectorAll('tr')).filter((r) => r.closest('table') === table)
    if (!rows.length) return ''

    const renderCell = (cell: Element) =>
      turndown
        .turndown(cell.innerHTML)
        .trim()
        .replace(/\|/g, '\\|') // escape literal pipes so they don't break cells
        .replace(/\n+/g, '<br>')
        .replace(/ +<br>/g, '<br>') // strip hardbreak spaces turndown adds before line breaks

    let header: string[] | null = null
    const body: string[][] = []
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('th, td')).map(renderCell)
      // The first row containing a <th> becomes the pipe table's header.
      if (header === null && row.querySelector('th')) header = cells
      else body.push(cells)
    }
    // Pipe tables require a header row; synthesize an empty one if absent.
    if (header === null) header = []

    const colCount = Math.max(header.length, ...body.map((r) => r.length), 1)
    const pad = (cells: string[]) => {
      while (cells.length < colCount) cells.push('')
      return cells
    }
    const line = (cells: string[]) => '| ' + cells.join(' | ') + ' |'
    const lines = [
      line(pad(header)),
      '| ' + Array(colCount).fill('---').join(' | ') + ' |',
      ...body.map((r) => line(pad(r))),
    ]
    return '\n\n' + lines.join('\n') + '\n\n'
  },
})

export function markdownToHtml(md: string): string {
  return marked.parse(md, { async: false }) as string
}

// Render markdown from untrusted sources (e.g. LLM replies) to HTML with all
// script vectors stripped: event handlers, javascript: URLs, script/iframe, etc.
export function renderMarkdown(md: string): string {
  return DOMPurify.sanitize(marked.parse(md, { async: false }) as string)
}

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html)
}
