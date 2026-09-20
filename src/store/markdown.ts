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

// AI placeholder blocks round-trip through markdown as a standalone
// `[[ai: <description>]]` line. On the way in, such a line is swapped for a
// raw-HTML paragraph carrying the description in a data attribute, which the
// aiPlaceholder TipTap node parses; on the way out, a turndown rule below
// turns the node's <div data-ai-placeholder> back into the marker line.
const AI_PLACEHOLDER_LINE = /^[ \t]*\[\[ai:[ \t]*(.*?)[ \t]*\]\][ \t]*$/

const escapeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// AI placeholder node → `[[ai: <description>]]`. The node's rendered HTML is
// a <div data-ai-placeholder> wrapping a visible note; the note text is
// discarded here so only the marker line survives the round trip.
turndown.addRule('aiPlaceholder', {
  filter: (node) =>
    node.nodeType === 1 && (node as HTMLElement).hasAttribute('data-ai-placeholder'),
  replacement: (_content, node) => {
    const desc = (node as HTMLElement).getAttribute('data-ai-placeholder') || ''
    return `\n\n[[ai: ${desc}]]\n\n`
  },
})

export function markdownToHtml(md: string): string {
  const pre = md
    .split('\n')
    .map((line) => {
      const m = line.match(AI_PLACEHOLDER_LINE)
      // A <div>, not a <p>: StarterKit's paragraph rule (tag 'p') would claim
      // a <p> element before the aiPlaceholder rule ([data-ai-placeholder])
      // ever sees it, so the node is silently dropped on setContent and the
      // placeholder is lost on reload. No default extension claims <div>, and
      // it matches the node's own renderHTML output.
      return m ? `<div data-ai-placeholder="${escapeAttr(m[1])}"></div>` : line
    })
    .join('\n')
  // Sanitized: the editor content path (opened files, session restore,
  // code-view round-trip) feeds untrusted markdown here, so it goes through
  // DOMPurify exactly like LLM replies — ProseMirror's schema whitelist is not
  // treated as a security boundary on its own. DOMPurify keeps data-* attrs by
  // default, so the placeholder div above survives.
  return DOMPurify.sanitize(marked.parse(pre, { async: false }) as string)
}

// Render markdown from untrusted sources (e.g. LLM replies) to HTML. Now
// identical to markdownToHtml — kept as a distinct name for call-site clarity.
export function renderMarkdown(md: string): string {
  return markdownToHtml(md)
}

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html)
}
