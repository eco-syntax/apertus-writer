// DOCX export: renders the shared block model with the active theme applied
// as native Word styles (fonts, colors, sizes, shading, table borders).
// The `docx` package is kept deliberately: it is already installed and handles
// correct OOXML (numbering, styles, relationships) in far less — and more
// battle-tested — code than hand-rolling OOXML the way exportOdt does for ODF.
import {
  Document, Packer, Paragraph, TextRun, ExternalHyperlink, ImageRun,
  HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType,
  TableLayoutType, BorderStyle, ShadingType, convertMillimetersToTwip, LevelFormat,
} from 'docx'
import type { ILevelsOptions } from 'docx'
import { htmlToBlocks, themeFromVars, HEADING_SCALE, parseImageDataUrl, type Block, type InlineRun, type ExportTheme } from './exportModel'
import type { ThemeVars } from '../components/StylePanel'

const halfPt = (pt: number) => Math.round(pt * 2)

function textRuns(runs: InlineRun[], t: ExportTheme, opts: { heading?: boolean } = {}): (TextRun | ExternalHyperlink)[] {
  const color = opts.heading ? t.headingColor : t.textColor
  return runs.map((r) => {
    const runOpts: ConstructorParameters<typeof TextRun>[0] = {
      text: r.text,
      bold: r.bold || !!opts.heading,
      italics: r.italic,
      strike: r.strike,
      font: r.code ? t.codeFont : t.font,
      size: halfPt(opts.heading ? t.fontSizePt : (r.code ? t.fontSizePt * 0.9 : t.fontSizePt)),
      color: r.link ? t.accent : (r.code ? t.textColor : color),
      shading: r.code ? { type: ShadingType.CLEAR, fill: t.codeBg } : undefined,
    }
    if (r.link) {
      return new ExternalHyperlink({ link: r.link, children: [new TextRun({ ...runOpts, style: 'Hyperlink' })] })
    }
    return new TextRun(runOpts)
  })
}

function imageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => resolve({ width: 400, height: 300 })
    img.src = dataUrl
  })
}

const border = { style: BorderStyle.SINGLE, size: 4, color: 'D0D7DE' }
const borders = { top: border, bottom: border, left: border, right: border }

type DocxOut = (Paragraph | Table)[]

async function blockToDocx(block: Block, t: ExportTheme, numId: { current: number }): Promise<DocxOut> {
  switch (block.kind) {
    case 'heading': {
      const level = ([HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4])[block.level - 1]
      const scale = HEADING_SCALE[block.level - 1]
      return [new Paragraph({
        heading: level,
        spacing: { before: 240, after: 120 },
        children: block.runs.map((r) => new TextRun({
          text: r.text, bold: true, italics: r.italic, strike: r.strike,
          font: r.code ? t.codeFont : t.font, size: halfPt(t.fontSizePt * scale), color: t.headingColor,
        })),
      })]
    }
    case 'paragraph':
      return [new Paragraph({ spacing: { after: 160 }, children: textRuns(block.runs, t) })]
    case 'quote':
      return [new Paragraph({
        spacing: { after: 160 },
        indent: { left: convertMillimetersToTwip(6) },
        border: { left: { style: BorderStyle.SINGLE, size: 12, color: t.accent, space: 8 } },
        children: textRuns(block.runs, t),
      })]
    case 'codeBlock':
      return [new Paragraph({
        spacing: { after: 160 },
        shading: { type: ShadingType.CLEAR, fill: t.codeBg },
        children: block.text.split('\n').flatMap((line, i, arr) => [
          new TextRun({ text: line, font: t.codeFont, size: halfPt(t.fontSizePt * 0.9), color: t.textColor, break: i < arr.length - 1 ? 1 : 0 }),
        ]),
      })]
    case 'list': {
      const reference = `list-${block.ordered ? 'ol' : 'ul'}-${numId.current++}`
      return block.items.map((item) => new Paragraph({
        numbering: { reference, level: 0 },
        spacing: { after: 60 },
        children: textRuns(item, t),
      }))
    }
    case 'table': {
      const cols = Math.max(
        block.header.length,
        ...block.rows.map((r) => r.length),
        1,
      )
      // Letter 8.5in − 2×1in margins = 6.5in = 9360 twip of content width
      const contentWidthTwip = 9360
      const columnWidths = Array.from({ length: cols }, () => Math.floor(contentWidthTwip / cols))
      const makeCell = (runs: InlineRun[], isHeader: boolean) => new TableCell({
        borders,
        width: { size: 100 / cols, type: WidthType.PERCENTAGE },
        shading: isHeader ? { type: ShadingType.CLEAR, fill: t.codeBg } : undefined,
        children: [new Paragraph({ children: textRuns(isHeader ? runs.map((r) => ({ ...r, bold: true })) : runs, t) })],
      })
      const rows: TableRow[] = []
      if (block.header.length) {
        rows.push(new TableRow({ children: block.header.map((h) => makeCell([{ text: h }], true)), tableHeader: true }))
      }
      for (const row of block.rows) {
        rows.push(new TableRow({ children: row.map((cell) => makeCell(cell, false)) }))
      }
      return [new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        layout: TableLayoutType.FIXED,
        columnWidths,
        rows,
      })]
    }
    case 'image': {
      const img = parseImageDataUrl(block.dataUrl)
      if (!img) return []
      const { width, height } = await imageSize(block.dataUrl)
      const maxW = 550
      const scale = width > maxW ? maxW / width : 1
      return [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new ImageRun({ data: img.data, transformation: { width: Math.round(width * scale), height: Math.round(height * scale) }, type: img.ext })],
      })]
    }
    case 'hr':
      return [new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D0D7DE', space: 1 } },
        spacing: { after: 200 },
      })]
  }
}

export async function buildDocx(html: string, themeVars: ThemeVars): Promise<Blob> {
  const t = themeFromVars(themeVars)
  const blocks = htmlToBlocks(html)
  const numId = { current: 1 }
  const children: (Paragraph | Table)[] = []
  for (const b of blocks) {
    children.push(...await blockToDocx(b, t, numId))
  }

  // numbering definitions for every list instance created above
  const numbering = { config: [] as { reference: string; levels: ILevelsOptions[] }[] }
  for (let i = 1; i < numId.current; i++) {
    for (const kind of ['ul', 'ol'] as const) {
      numbering.config.push({
        reference: `list-${kind}-${i}`,
        levels: [{
          level: 0,
          format: kind === 'ol' ? LevelFormat.DECIMAL : LevelFormat.BULLET,
          text: kind === 'ol' ? '%1.' : '•',
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      })
    }
  }

  const doc = new Document({
    numbering,
    styles: {
      default: {
        document: { run: { font: t.font, size: halfPt(t.fontSizePt), color: t.textColor } },
      },
    },
    background: { color: t.bg },
    sections: [{ children }],
  })
  return Packer.toBlob(doc)
}
