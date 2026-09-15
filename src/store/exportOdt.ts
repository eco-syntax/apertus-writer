// ODT export: builds a .odt (zip of XML) with named styles derived from the
// active theme, so LibreOffice/OpenOffice renders it like the editor.
import JSZip from 'jszip'
import { htmlToBlocks, themeFromVars, HEADING_SCALE, parseImageDataUrl, type Block, type InlineRun, type ExportTheme } from './exportModel'
import type { ThemeVars } from '../components/StylePanel'

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const pt = (n: number) => `${n.toFixed(1)}pt`
const hex = (h: string) => `#${h}`

// Inline runs → text:span elements with automatic text styles
function spans(runs: InlineRun[], t: ExportTheme, styleNames: Map<string, string>, autoStyles: string[]): string {
  return runs.map((r) => {
    const props: string[] = []
    if (r.bold) props.push('fo:font-weight="bold"')
    if (r.italic) props.push('fo:font-style="italic"')
    if (r.strike) props.push('style:text-line-through-style="solid"')
    if (r.code) {
      props.push(`style:font-name="CodeFont"`, `fo:background-color="${hex(t.codeBg)}"`, `fo:font-size="${pt(t.fontSizePt * 0.9)}"`)
    }
    if (r.link) props.push(`fo:color="${hex(t.accent)}"`, 'style:text-underline-style="solid"')

    const text = esc(r.text).replace(/\n/g, '<text:line-break/>')
    if (r.link) {
      return `<text:a xlink:type="simple" xlink:href="${esc(r.link)}"><text:span text:style-name="${autoStyle('T', props, styleNames, autoStyles)}">${text}</text:span></text:a>`
    }
    if (props.length === 0) return text
    return `<text:span text:style-name="${autoStyle('T', props, styleNames, autoStyles)}">${text}</text:span>`
  }).join('')
}

function autoStyle(prefix: string, props: string[], cache: Map<string, string>, out: string[]): string {
  const key = props.sort().join('|')
  const existing = cache.get(key)
  if (existing) return existing
  const name = `${prefix}${cache.size + 1}`
  cache.set(key, name)
  out.push(`<style:style style:name="${name}" style:family="text"><style:text-properties ${props.join(' ')}/></style:style>`)
  return name
}

export async function buildOdt(html: string, themeVars: ThemeVars): Promise<Blob> {
  const t = themeFromVars(themeVars)
  const autoStyles: string[] = []
  const textStyleCache = new Map<string, string>()
  const images: { name: string; dataUrl: string }[] = []

  const bodyParts: string[] = []
  const tableColStyles: string[] = []
  let tableCount = 0

  const para = (style: string, runs: InlineRun[]) =>
    `<text:p text:style-name="${style}">${spans(runs, t, textStyleCache, autoStyles)}</text:p>`

  for (const b of htmlToBlocks(html) as Block[]) {
    switch (b.kind) {
      case 'heading':
        bodyParts.push(`<text:h text:style-name="Heading_20_${b.level}" text:outline-level="${b.level}">${spans(b.runs, t, textStyleCache, autoStyles)}</text:h>`)
        break
      case 'paragraph':
        bodyParts.push(para('Text_20_body', b.runs))
        break
      case 'quote':
        bodyParts.push(para('Quotations', b.runs))
        break
      case 'codeBlock':
        bodyParts.push(`<text:p text:style-name="Preformatted_20_Text">${esc(b.text).replace(/\n/g, '<text:line-break/>')}</text:p>`)
        break
      case 'list': {
        const listStyle = b.ordered ? 'Numbering_20_1' : 'List_20_1'
        const items = b.items.map((runs) =>
          `<text:list-item>${para('Text_20_body', runs)}</text:list-item>`,
        ).join('')
        bodyParts.push(`<text:list text:style-name="${listStyle}">${items}</text:list>`)
        break
      }
      case 'table': {
        const cellP = (runs: InlineRun[], bold: boolean) =>
          `<text:p text:style-name="Table_20_Contents">${spans(bold ? runs.map((r) => ({ ...r, bold: true })) : runs, t, textStyleCache, autoStyles)}</text:p>`
        const cols = Math.max(b.header.length, ...b.rows.map((r) => r.length), 1)
        const tableIndex = tableCount++
        // Fixed proportional column widths so the table spans exactly the text width
        const colStyleName = `TabCol${tableIndex}`
        tableColStyles.push(`<style:style style:name="${colStyleName}" style:family="table-column"><style:table-column-properties style:column-width="${100 / cols}%"/></style:style>`)
        let xml = `<table:table table:name="Table${tableIndex}" table:style-name="Table1">`
        xml += `<table:table-column table:style-name="${colStyleName}" table:number-columns-repeated="${cols}"/>`
        if (b.header.length) {
          xml += `<table:table-header-rows><table:table-row>${b.header.map((h) =>
            `<table:table-cell table:style-name="Table1.A1" office:value-type="string">${cellP([{ text: h }], true)}</table:table-cell>`,
          ).join('')}</table:table-row></table:table-header-rows>`
        }
        for (const row of b.rows) {
          xml += `<table:table-row>${row.map((cell) =>
            `<table:table-cell table:style-name="Table1.B1" office:value-type="string">${cellP(cell, false)}</table:table-cell>`,
          ).join('')}</table:table-row>`
        }
        xml += '</table:table>'
        bodyParts.push(xml)
        break
      }
      case 'image': {
        const img = parseImageDataUrl(b.dataUrl)
        if (!img) break
        const name = `Pictures/img${images.length + 1}.${img.ext}`
        images.push({ name, dataUrl: b.dataUrl })
        bodyParts.push(
          `<text:p text:style-name="Text_20_body"><draw:frame draw:name="${esc(b.alt || 'image')}" text:anchor-type="paragraph" svg:width="14cm" draw:z-index="0"><draw:image xlink:href="${name}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame></text:p>`,
        )
        break
      }
      case 'hr':
        bodyParts.push('<text:p text:style-name="Horizontal_20_Line"/>')
        break
    }
  }

  const h = (lvl: number) => `
    <style:style style:name="Heading_20_${lvl}" style:family="paragraph" style:parent-style-name="Heading" style:next-style-name="Text_20_body" style:class="text">
      <style:paragraph-properties fo:margin-top="0.1665in" fo:margin-bottom="0.0835in" loext:contextual-spacing="false"/>
      <style:text-properties fo:font-size="${pt(t.fontSizePt * HEADING_SCALE[lvl - 1])}" fo:font-weight="bold" fo:color="${hex(t.headingColor)}" style:font-name="BodyFont"/>
    </style:style>`

  const contentXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
  xmlns:loext="urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0"
  office:version="1.2">
  <office:font-face-decls>
    <style:font-face style:name="BodyFont" svg:font-family="'${esc(t.font)}'"/>
    <style:font-face style:name="CodeFont" svg:font-family="'${esc(t.codeFont)}'"/>
  </office:font-face-decls>
  <office:automatic-styles>
    <style:style style:name="Text_20_body" style:family="paragraph" style:parent-style-name="Standard">
      <style:paragraph-properties fo:margin-bottom="0.1in"/>
      <style:text-properties fo:font-size="${pt(t.fontSizePt)}" fo:color="${hex(t.textColor)}" style:font-name="BodyFont"/>
    </style:style>
    <style:style style:name="Quotations" style:family="paragraph" style:parent-style-name="Standard">
      <style:paragraph-properties fo:margin-left="0.2in" fo:margin-bottom="0.1in" fo:border-left="2.25pt solid ${hex(t.accent)}"/>
      <style:text-properties fo:font-size="${pt(t.fontSizePt)}" fo:color="${hex(t.textColor)}" style:font-name="BodyFont"/>
    </style:style>
    <style:style style:name="Preformatted_20_Text" style:family="paragraph" style:parent-style-name="Standard">
      <style:paragraph-properties fo:background-color="${hex(t.codeBg)}" fo:padding="0.08in" fo:margin-bottom="0.1in"/>
      <style:text-properties style:font-name="CodeFont" fo:font-size="${pt(t.fontSizePt * 0.9)}" fo:color="${hex(t.textColor)}"/>
    </style:style>
    ${[1, 2, 3, 4].map(h).join('')}
    <style:style style:name="Table_20_Contents" style:family="paragraph">
      <style:text-properties fo:font-size="${pt(t.fontSizePt)}" fo:color="${hex(t.textColor)}" style:font-name="BodyFont"/>
    </style:style>
    <style:style style:name="Table1" style:family="table">
      <style:table-properties style:width="100%" table:align="margins"/>
    </style:style>
    <style:style style:name="Table1.A1" style:family="table-cell">
      <style:table-cell-properties fo:border="0.5pt solid #d0d7de" fo:background-color="${hex(t.codeBg)}" fo:padding="0.05in"/>
    </style:style>
    <style:style style:name="Table1.B1" style:family="table-cell">
      <style:table-cell-properties fo:border="0.5pt solid #d0d7de" fo:padding="0.05in"/>
    </style:style>
    <style:style style:name="Horizontal_20_Line" style:family="paragraph" style:parent-style-name="Standard">
      <style:paragraph-properties fo:border-bottom="1pt solid #d0d7de" fo:margin-bottom="0.15in"/>
    </style:style>
    ${tableColStyles.join('\n    ')}
    <text:list-style style:name="List_20_1">
      <text:list-level-style-bullet text:level="1" text:bullet-char="•">
        <style:list-level-properties text:min-label-width="0.25in"/>
      </text:list-level-style-bullet>
    </text:list-style>
    <text:list-style style:name="Numbering_20_1">
      <text:list-level-style-number text:level="1" style:num-format="1">
        <style:list-level-properties text:min-label-width="0.25in"/>
      </text:list-level-style-number>
    </text:list-style>
    ${autoStyles.join('\n    ')}
  </office:automatic-styles>
  <office:body>
    <office:text>${bodyParts.join('\n    ')}</office:text>
  </office:body>
</office:document-content>`

  const stylesXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
  xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
  office:version="1.2">
  <office:font-face-decls>
    <style:font-face style:name="BodyFont" svg:font-family="'${esc(t.font)}'"/>
    <style:font-face style:name="CodeFont" svg:font-family="'${esc(t.codeFont)}'"/>
  </office:font-face-decls>
  <office:styles>
    <style:default-style style:family="paragraph">
      <style:text-properties style:font-name="BodyFont" fo:font-size="${pt(t.fontSizePt)}" fo:color="${hex(t.textColor)}"/>
    </style:default-style>
    <style:style style:name="Standard" style:family="paragraph" style:class="text"/>
    <style:style style:name="Heading" style:family="paragraph" style:next-style-name="Text_20_body" style:class="text"/>
  </office:styles>
  <office:master-styles>
    <style:master-page style:name="Standard">
      <style:page-layout-properties fo:background-color="${hex(t.bg)}"/>
    </style:master-page>
  </office:master-styles>
</office:document-styles>`

  const metaXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.2">
  <office:meta><meta:generator>Apertus Writer</meta:generator><dc:title>Document</dc:title></office:meta>
</office:document-meta>`

  const manifestXml = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`

  const zip = new JSZip()
  // mimetype must be first and uncompressed per ODF spec
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' })
  zip.file('content.xml', contentXml)
  zip.file('styles.xml', stylesXml)
  zip.file('meta.xml', metaXml)
  zip.file('META-INF/manifest.xml', manifestXml)
  for (const img of images) {
    const base64 = img.dataUrl.split(',')[1]
    zip.file(img.name, base64, { base64: true })
  }
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.oasis.opendocument.text' })
}
