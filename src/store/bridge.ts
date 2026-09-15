// Typed accessor for the Electron preload bridge (window.aiBridge).
// All methods are undefined in a plain browser.

export interface Bridge {
  request(args: {
    url: string; method: string; headers: Record<string, string>; body?: string
  }): Promise<{ ok: boolean; status: number; statusText: string; body: string }>
  chooseOpenPath(): Promise<{ canceled: boolean; filePath?: string }>
  readFile(args: { filePath: string }): Promise<{ ok: boolean; content?: string; error?: string }>
  chooseSavePath(args: { docName: string }): Promise<{ canceled: boolean; filePath?: string }>
  chooseExportPath(args: { docName: string }): Promise<{ canceled: boolean; filePath?: string; format?: 'docx' | 'odt' | 'pdf' }>
  writeFile(args: { filePath: string; base64?: string; text?: string }): Promise<{ ok: boolean; error?: string }>
  exportPdfTo(args: { filePath: string; html: string; css: string }): Promise<{ ok: boolean; error?: string }>
  printDocument(args: { html: string; css: string }): Promise<{ ok: boolean; error?: string }>
  sessionSave(args: { docName: string; filePath: string | null; content: string }): Promise<{ ok: boolean; error?: string }>
  sessionLoad(): Promise<{ ok: boolean; session?: { docName: string; filePath: string | null; content: string } | null }>
  // Sidecar style file: writes/reads a .css file alongside a saved .md file so
  // the document's theme travels with it. Inert in a plain browser (filePath
  // is null there), and undefined when the bridge is absent.
  writeSidecar(args: { filePath: string; css: string }): Promise<{ ok: boolean; error?: string }>
  readSidecar(args: { filePath: string }): Promise<{ ok: boolean; css: string | null }>
  chatSave(args: { key: string; messages: unknown[] }): Promise<{ ok: boolean; error?: string }>
  chatLoad(args: { key: string }): Promise<{ ok: boolean; messages: unknown[] }>
  contextSave(args: { key: string; items: unknown[] }): Promise<{ ok: boolean; error?: string }>
  contextLoad(args: { key: string }): Promise<{ ok: boolean; items: unknown[] }>
  secretLoad(): Promise<{ ok: boolean; secrets?: Record<string, string>; available?: boolean }>
  secretSave(args: { secrets: Record<string, string> }): Promise<{ ok: boolean; error?: string; available?: boolean }>
  openExternal(args: { url: string }): Promise<void>
  onMenuAction(callback: (action: 'new' | 'open' | 'save' | 'saveAs' | 'export' | 'print') => void): () => void
}

export function getBridge(): Bridge | undefined {
  return (window as unknown as { aiBridge?: Bridge }).aiBridge
}

export async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    // readAsDataURL yields `data:<type>;base64,<payload>` — strip the prefix.
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}
