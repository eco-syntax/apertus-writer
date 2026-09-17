// Text extraction from binary document formats (PDF / DOCX / ODT). Extraction
// is text-only: paragraph structure is preserved as newlines, but formatting,
// images, and tables are flattened. Used for reference context (chat/autocomplete)
// and for importing DOCX/ODT files as the working document.
import JSZip from 'jszip'

// The 20k cap keeps reference-context excerpts budget-friendly for prompts.
// Document imports pass Infinity so the whole file round-trips.
const MAX_CHARS = 20000

function normalize(text: string, limit: number = MAX_CHARS): string {
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, limit)
}

/** DOCX: zip of XML; the body text lives in word/document.xml as <w:t> runs. */
export async function extractDocx(buf: ArrayBuffer, limit: number = MAX_CHARS): Promise<string> {
  const zip = await JSZip.loadAsync(buf)
  const file = zip.file('word/document.xml')
  if (!file) throw new Error('Not a valid DOCX (word/document.xml missing)')
  const doc = new DOMParser().parseFromString(await file.async('text'), 'application/xml')
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
  const paragraphs = Array.from(doc.getElementsByTagNameNS(W, 'p')).map((p) =>
    Array.from(p.getElementsByTagNameNS(W, 't'))
      .map((t) => t.textContent ?? '')
      .join(''),
  )
  const text = normalize(paragraphs.join('\n'), limit)
  if (!text) throw new Error('No extractable text found in DOCX')
  return text
}

/** ODT: zip of XML; the body text lives in content.xml as text:p / text:h. */
export async function extractOdt(buf: ArrayBuffer, limit: number = MAX_CHARS): Promise<string> {
  const zip = await JSZip.loadAsync(buf)
  const file = zip.file('content.xml')
  if (!file) throw new Error('Not a valid ODT (content.xml missing)')
  const doc = new DOMParser().parseFromString(await file.async('text'), 'application/xml')
  const TEXT = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0'
  const blocks = [
    ...Array.from(doc.getElementsByTagNameNS(TEXT, 'p')),
    ...Array.from(doc.getElementsByTagNameNS(TEXT, 'h')),
  ]
  const text = normalize(blocks.map((b) => b.textContent ?? '').join('\n'), limit)
  if (!text) throw new Error('No extractable text found in ODT')
  return text
}

/**
 * Import helper: extract the full document text from a DOCX/ODT File for
 * loading as the current document. No 20k cap — the whole file round-trips.
 */
export async function extractOffice(f: File): Promise<string> {
  const ext = f.name.toLowerCase().split('.').pop()
  const buf = await f.arrayBuffer()
  if (ext === 'docx') return extractDocx(buf, Number.POSITIVE_INFINITY)
  if (ext === 'odt') return extractOdt(buf, Number.POSITIVE_INFINITY)
  throw new Error(`Unsupported import format: ${f.name}`)
}

/**
 * PDF: parsed with pdf.js, lazy-loaded so the (~400 KB) library is only
 * fetched when a PDF is actually attached. Scanned PDFs without a text layer
 * yield nothing and are reported as an error.
 */
export async function extractPdf(buf: ArrayBuffer): Promise<string> {
  const [pdfjs, workerUrl] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ])
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.default
  const pdf = await pdfjs.getDocument({ data: buf }).promise
  const pages: string[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    pages.push(
      content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' '),
    )
  }
  const text = normalize(pages.join('\n\n'))
  if (!text) {
    throw new Error('No extractable text found (scanned/image-only PDFs are not supported)')
  }
  return text
}
