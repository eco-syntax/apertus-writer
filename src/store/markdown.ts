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
// inside a cell is flattened to <br>. colspan/rowspan cannot be expressed in
// pipe syntax: a colspan pads the row with empty cells to keep it aligned;
// a rowspan's content appears once.
turndown.addRule('table', {
  filter: ['table'],
  replacement: (_content, node) => {
    const table = node as HTMLElement
    // Only rows belonging directly to this table, not any nested tables.
    const rows = Array.from(table.querySelectorAll('tr')).filter(
      (r) => r.closest('table') === table,
    )
    if (!rows.length) return ''

    const renderCell = (cell: Element) =>
      turndown
        .turndown(cell.innerHTML)
        .trim()
        .replace(/\|/g, '\\|') // escape literal pipes so they don't break cells
        .replace(/\n+/g, '<br>')
        .replace(/ +<br>/g, '<br>') // strip hardbreak spaces turndown adds before line breaks

    // Expand colspans so every logical row has the same cell count.
    const expand = (cells: Element[]) => {
      const out: string[] = []
      for (const c of cells) {
        out.push(renderCell(c))
        const span = Number(c.getAttribute('colspan') || 1)
        for (let i = 1; i < span; i++) out.push('')
      }
      return out
    }

    const colCount = Math.max(...rows.map((r) => expand(Array.from(r.querySelectorAll('th, td'))).length))
    const pad = (cells: string[]) => {
      while (cells.length < colCount) cells.push('')
      return cells
    }

    let header: string[] | null = null
    const body: string[][] = []
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('th, td'))
      const rendered = pad(expand(cells))
      // The first row containing a <th> becomes the pipe table's header.
      if (header === null && cells.some((c) => c.tagName === 'TH')) header = rendered
      else body.push(rendered)
    }
    // Pipe tables require a header row; synthesize an empty one if absent.
    if (header === null) header = pad([])

    const line = (cells: string[]) => '| ' + cells.join(' | ') + ' |'
    const lines = [
      line(header),
      '| ' + Array(colCount).fill('---').join(' | ') + ' |',
      ...body.map(line),
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
      return m ? `<p data-ai-placeholder="${escapeAttr(m[1])}"></p>` : line
    })
    .join('\n')
  return marked.parse(pre, { async: false }) as string
}

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html)
}
