// Electron main process.
// The renderer delegates AI API calls here via IPC because Node.js networking
// is not subject to browser CORS restrictions — this lets the app talk to any
// endpoint (local servers, third-party hosted APIs) without proxies.
const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron')
const path = require('path')
const dns = require('dns').promises
const fs = require('fs')

const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173'
const isDev = !app.isPackaged

// Disable GPU compositing: this app is plain DOM/CSS (no WebGL/canvas/video),
// and a sleep/wake cycle resets the OS GPU device, which Chromium recovers from
// by restarting the GPU process and reloading the renderer — the "flash blank"
// on wake. Software rasterization is plenty for a text editor and avoids that.
app.disableHardwareAcceleration()

let mainWindow = null

function sendMenuAction(action) {
  mainWindow?.webContents.send('menu-action', action)
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New', accelerator: 'CmdOrCtrl+N', click: () => sendMenuAction('new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => sendMenuAction('open') },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => sendMenuAction('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenuAction('saveAs') },
        { label: 'Export…', accelerator: 'CmdOrCtrl+E', click: () => sendMenuAction('export') },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => sendMenuAction('print') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Apertus Writer',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: 'About',
              message: 'Apertus Writer',
              detail: `Version ${app.getVersion()}\nA WYSIWYG markdown editor with AI autocomplete and chat, powered by Apertus models.`,
            })
          },
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  })

  // Spell checking: use the OS dictionary (Windows Spell Checking API)
  mainWindow.webContents.session.setSpellCheckerLanguages(['en-US'])

  // Right-click menu with spelling suggestions
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const items = []
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        items.push({
          label: suggestion,
          click: () => mainWindow.webContents.replaceMisspelling(suggestion),
        })
      }
      if (items.length === 0) items.push({ label: '(no suggestions)', enabled: false })
      items.push({
        label: `Add "${params.misspelledWord}" to dictionary`,
        click: () => mainWindow.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      })
      items.push({ type: 'separator' })
    }
    if (params.editFlags.canCut) items.push({ role: 'cut' })
    if (params.editFlags.canCopy) items.push({ role: 'copy' })
    if (params.editFlags.canPaste) items.push({ role: 'paste' })
    if (items.length > 0) Menu.buildFromTemplate(items).popup()
  })

  // Open external links in the system browser, but only http(s) URLs.
  // shell.openExternal hands the URL straight to the OS, where protocols like
  // file:, ms-msdt: or search-ms: are documented RCE/launch vectors on
  // Windows — so anything outside http(s) is silently denied.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(parsed.toString())
      }
    } catch {
      // Unparseable or non-http(s) URL — deny.
    }
    return { action: 'deny' }
  })

  // Navigation guard: the privileged preload bridge is re-injected into every
  // page loaded in this window, so a link click (or prompt-injected <a>) that
  // navigates the window to a remote origin would hand window.aiBridge to an
  // attacker. Only allow navigation to the app's own origin (the dev server in
  // dev, file:// in the packaged app); everything else is denied. Links are
  // routed to the system browser via the open-external handler above.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const allowed = isDev ? DEV_URL : 'file://'
    if (!url.startsWith(allowed)) e.preventDefault()
  })

  if (isDev) {
    mainWindow.loadURL(DEV_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

// Session restore: the working document (markdown + name/path) is persisted to
// a JSON file in userData so the app can reopen it after a restart (e.g. after
// the computer sleeps/wakes or the app is relaunched) instead of falling back
// to the default welcome document.
function sessionPath() {
  return path.join(app.getPath('userData'), 'session.json')
}

// --- Dialog-approved path registry -----------------------------------------
// The renderer may only read/write files the user has explicitly picked in a
// native dialog. Provenance is tracked here in main (the renderer cannot add
// to it); the renderer keeps paths for display/keying but they are not an I/O
// authorization token. The list is persisted so a document restored from a
// previous session stays usable after a relaunch.
const APPROVED_PATHS_ERROR = 'Path not approved for this document'

function approvedPathsPath() {
  return path.join(app.getPath('userData'), 'approved-paths.json')
}

let approvedPaths = null

function loadApprovedPaths() {
  if (approvedPaths) return approvedPaths
  try {
    const raw = JSON.parse(fs.readFileSync(approvedPathsPath(), 'utf8'))
    approvedPaths = new Set(Array.isArray(raw) ? raw.filter((p) => typeof p === 'string') : [])
  } catch {
    approvedPaths = new Set()
  }
  return approvedPaths
}

function persistApprovedPaths() {
  try {
    fs.writeFileSync(approvedPathsPath(), JSON.stringify([...loadApprovedPaths()]), 'utf8')
  } catch {
    // Best-effort: if the list can't be persisted the running app still works;
    // after a relaunch the user simply has to pick the file in a dialog again.
  }
}

// Resolve a renderer-supplied path to the canonical form used for allowlist
// comparisons, or null when it is empty / not a string / contains a NUL. On
// Windows, lowercase so case-spoofing can't defeat the comparison.
function normalizePath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) return null
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isApproved(filePath) {
  const resolved = normalizePath(filePath)
  return resolved !== null && loadApprovedPaths().has(resolved)
}

function approve(filePath) {
  const resolved = normalizePath(filePath)
  if (resolved === null) return
  const set = loadApprovedPaths()
  if (set.has(resolved)) return
  set.add(resolved)
  persistApprovedPaths()
}

// Derive the sidecar .css path for a document, rejecting anything that isn't a
// .css file sitting in the same directory as the (approved) document.
function sidecarPath(filePath) {
  const cssPath = filePath.replace(/\.(md|markdown|txt)$/i, '.css')
  if (!/\.css$/i.test(cssPath)) return null
  const docDir = normalizePath(path.dirname(filePath))
  const cssDir = normalizePath(path.dirname(cssPath))
  if (!docDir || !cssDir || docDir !== cssDir) return null
  return cssPath
}

// IPC: persist the current working document. → { ok, error? }
// args: { docName, filePath, content }
ipcMain.handle('session-save', async (_event, { docName, filePath, content }) => {
  try {
    // Never persist an unapproved path: a compromised renderer must not be able
    // to plant a path that becomes "trusted" after a restart.
    let safePath = null
    if (filePath !== null && filePath !== undefined) safePath = isApproved(filePath) ? filePath : null
    const data = JSON.stringify({ docName, filePath: safePath, content })
    fs.writeFileSync(sessionPath(), data, 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

// IPC: read back the persisted session, if any. → { ok, session? }
ipcMain.handle('session-load', async () => {
  try {
    const raw = fs.readFileSync(sessionPath(), 'utf8')
    const session = JSON.parse(raw)
    if (typeof session.content !== 'string') return { ok: true, session: null }
    // Restore the path only if it is still in the approved registry; a
    // hand-edited session.json can't smuggle in a path that bypasses dialogs.
    let filePath = null
    if (typeof session.filePath === 'string' && isApproved(session.filePath)) {
      approve(session.filePath)
      filePath = session.filePath
    }
    return {
      ok: true,
      session: {
        docName: typeof session.docName === 'string' ? session.docName : 'untitled.md',
        filePath,
        content: session.content,
      },
    }
  } catch {
    return { ok: true, session: null }
  }
})

// One JSON map per file in userData: a `key → array` store (chats.json,
// context.json). `valueKey` is the property name the renderer uses over IPC
// (`messages` for chat, `items` for context), so save/load return that shape.
function jsonStore(filename, valueKey) {
  const file = () => path.join(app.getPath('userData'), filename)
  function read() {
    try {
      return JSON.parse(fs.readFileSync(file(), 'utf8')) || {}
    } catch {
      return {}
    }
  }
  return {
    save: async (_event, args) => {
      try {
        const store = read()
        const items = args[valueKey]
        if (Array.isArray(items) && items.length === 0) delete store[args.key]
        else store[args.key] = items
        fs.writeFileSync(file(), JSON.stringify(store), 'utf8')
        return { ok: true }
      } catch (err) {
        return { ok: false, error: String(err) }
      }
    },
    load: async (_event, args) => {
      try {
        const store = read()
        const items = Array.isArray(store[args.key]) ? store[args.key] : []
        return { ok: true, [valueKey]: items }
      } catch {
        return { ok: true, [valueKey]: [] }
      }
    },
  }
}

const chats = jsonStore('chats.json', 'messages')
const context = jsonStore('context.json', 'items')
ipcMain.handle('chat-save', chats.save)
ipcMain.handle('chat-load', chats.load)
ipcMain.handle('context-save', context.save)
ipcMain.handle('context-load', context.load)

// --- Secret store (API keys) ----------------------------------------------
// LLM API keys are persisted with Electron safeStorage, which encrypts with
// the OS keychain (DPAPI on Windows), so they are not left in plaintext in the
// renderer's localStorage LevelDB on disk. The renderer holds non-secret
// settings in localStorage and fetches/merges the keys through here at runtime.
const { safeStorage } = require('electron')
function secretsFile() { return path.join(app.getPath('userData'), 'secrets.enc') }

ipcMain.handle('secret-load', async () => {
  try {
    const available = safeStorage.isEncryptionAvailable()
    if (!available) return { ok: true, secrets: {}, available: false }
    const buf = fs.readFileSync(secretsFile())
    const json = safeStorage.decryptString(buf)
    return { ok: true, secrets: JSON.parse(json || '{}'), available: true }
  } catch { return { ok: true, secrets: {}, available: safeStorage.isEncryptionAvailable() } }
})

ipcMain.handle('secret-save', async (_event, { secrets }) => {
  try {
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, available: false }
    fs.writeFileSync(secretsFile(), safeStorage.encryptString(JSON.stringify(secrets || {})))
    return { ok: true, available: true }
  } catch (err) {
    return { ok: false, error: String(err), available: true }
  }
})

// IPC: open an external link in the system browser. Only http/https URLs are
// allowed — guards against javascript:/file:/custom-protocol handlers being
// handed to the OS. Used by chat link clicks so they open externally instead
// of navigating (and exposing the preload bridge to) the app window.
ipcMain.handle('open-external', async (_event, { url }) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return
  try { await shell.openExternal(url) } catch { /* best-effort */ }
})

// IPC: perform an HTTP request on behalf of the renderer.
// args: { url, method, headers, body } → { ok, status, statusText, body }
// Validate a renderer-supplied request URL to limit the SSRF surface of the
// main-process HTTP proxy. Allows http/https only, GET/POST only, and rejects
// hostnames that resolve to the link-local range 169.254.0.0/16 (the cloud
// instance-metadata service) before fetching.
// ponytail: cannot block all private/loopback ranges — the app's legitimate
// use is arbitrary OpenAI-compatible endpoints, including localhost/LAN
// servers, so only the credential-exfil vector (link-local metadata) is
// blocked. DNS rebinding / TOCTOU between resolve and fetch remains a ceiling;
// a full SSRF fix would need an endpoint allowlist, which is a product call.
const BLOCKED_HOST_RE = /^169\.254\./
async function assertSafeRequestUrl(rawUrl) {
  if (typeof rawUrl !== 'string') throw new Error('Invalid URL')
  let parsed
  try { parsed = new URL(rawUrl) } catch { throw new Error('Invalid URL') }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Blocked scheme')
  const host = parsed.hostname
  // IP-literal hosts: block the metadata range directly.
  if (BLOCKED_HOST_RE.test(host)) throw new Error('Blocked host')
  // Hostnames: resolve and reject if any address is link-local.
  try {
    const looked = await dns.lookup(host, { all: true })
    if (looked.some((a) => BLOCKED_HOST_RE.test(a.address))) throw new Error('Blocked host')
  } catch (e) {
    // lookup failures (e.g. IPv6-only / non-resolvable) are surfaced by fetch
    // below; only our explicit block should reject here.
    if (String(e) === 'Error: Blocked host') throw e
  }
}

ipcMain.handle('ai-request', async (_event, { url, method, headers, body }) => {
  try {
    await assertSafeRequestUrl(url)
    if (method !== undefined && method !== 'GET' && method !== 'POST') {
      return { ok: false, status: 0, statusText: 'Blocked method', body: '' }
    }
    const res = await fetch(url, { method, headers, body })
    const text = await res.text()
    return { ok: res.ok, status: res.status, statusText: res.statusText, body: text }
  } catch (err) {
    return { ok: false, status: 0, statusText: String(err), body: '' }
  }
})

// IPC: show an open dialog for documents. → { canceled, filePath? }
// Needed because Chromium only shows a file chooser on a user activation, so a
// menu-triggered input.click() in the renderer is silently ignored.
ipcMain.handle('choose-open-path', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Documents', extensions: ['md', 'markdown', 'txt', 'docx', 'odt'] },
    ],
  })
  if (canceled || filePaths.length === 0) return { canceled: true }
  approve(filePaths[0])
  return { canceled: false, filePath: filePaths[0] }
})

// IPC: read a file. Text documents come back as UTF-8 `content`; binary office
// docs (docx/odt) as `base64` for the renderer to import. → { ok, content?,
// base64?, error? }
ipcMain.handle('read-file', async (_event, { filePath }) => {
  try {
    if (!isApproved(filePath)) return { ok: false, error: APPROVED_PATHS_ERROR }
    if (/\.(docx|odt)$/i.test(filePath)) {
      return { ok: true, base64: fs.readFileSync(filePath).toString('base64') }
    }
    if (!/\.(md|markdown|txt)$/i.test(filePath)) {
      return { ok: false, error: APPROVED_PATHS_ERROR }
    }
    return { ok: true, content: fs.readFileSync(filePath, 'utf8') }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

// IPC: show a save dialog with export format filters; the chosen filter
// determines the format. → { canceled, filePath?, format? }
ipcMain.handle('choose-export-path', async (_event, { docName }) => {
  const base = (docName || 'document').replace(/\.(md|markdown|txt)$/i, '')
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: `${base}.docx`,
    filters: [
      { name: 'Word document (.docx)', extensions: ['docx'] },
      { name: 'OpenDocument (.odt)', extensions: ['odt'] },
      { name: 'PDF (.pdf)', extensions: ['pdf'] },
    ],
  })
  if (canceled || !filePath) return { canceled: true }
  approve(filePath)
  const format = (filePath.match(/\.(docx|odt|pdf)$/i)?.[1] || 'docx').toLowerCase()
  return { canceled: false, filePath, format }
})

// IPC: show a save dialog for markdown files. → { canceled, filePath? }
ipcMain.handle('choose-save-path', async (_event, { docName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: docName || 'untitled.md',
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown'] },
      { name: 'Text', extensions: ['txt'] },
    ],
  })
  if (canceled || !filePath) return { canceled: true }
  approve(filePath)
  return { canceled: false, filePath }
})

// IPC: write bytes/text to a file. Text saves pass `text` (UTF-8, no base64
// round-trip); binary exports pass `base64`. → { ok, error? }
ipcMain.handle('write-file', async (_event, { filePath, base64, text }) => {
  try {
    if (!isApproved(filePath)) return { ok: false, error: APPROVED_PATHS_ERROR }
    if (typeof text === 'string') fs.writeFileSync(filePath, text, 'utf8')
    else fs.writeFileSync(filePath, Buffer.from(base64, 'base64'))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

// IPC: write a sidecar .css style file next to a saved .md/.markdown/.txt
// document so the theme travels with the file. Replaces the markdown
// extension with .css. → { ok, error? }
ipcMain.handle('write-sidecar', async (_event, { filePath, css }) => {
  try {
    if (!isApproved(filePath)) return { ok: false, error: APPROVED_PATHS_ERROR }
    const cssPath = sidecarPath(filePath)
    if (!cssPath) return { ok: false, error: APPROVED_PATHS_ERROR }
    fs.writeFileSync(cssPath, css, 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

// IPC: read a sidecar .css style file for a .md/.markdown/.txt document.
// Returns css=null when no sidecar exists (a document without a saved style
// opens with the default theme). → { ok, css? }
ipcMain.handle('read-sidecar', async (_event, { filePath }) => {
  try {
    if (!isApproved(filePath)) return { ok: false, css: null }
    const cssPath = sidecarPath(filePath)
    if (!cssPath) return { ok: false, css: null }
    if (!fs.existsSync(cssPath)) return { ok: true, css: null }
    return { ok: true, css: fs.readFileSync(cssPath, 'utf8') }
  } catch (err) {
    return { ok: false, css: null }
  }
})

// IPC: print the themed document via the native print dialog.
// args: { html, css } → { ok, error? }
ipcMain.handle('print-document', async (_event, { html, css }) => {
  const fullHtml = buildPrintableHtml(html, css)
  let win = null
  try {
    win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fullHtml))
    await new Promise((resolve) => {
      win.webContents.print({ printBackground: true }, (success, failureReason) => {
        resolve({ success, failureReason })
      })
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  } finally {
    win?.destroy()
  }
})

function buildPrintableHtml(html, css) {
  // Defense in depth: theme CSS comes from a (possibly untrusted) sidecar .css
  // and is already angle-bracket-rejected on load (cssToTheme); strip any stray
  // `<` here too so it can never close the <style> block. CSS has no legitimate
  // use for `<`.
  const safeCss = css.replace(/</g, '')
  // CSP blocks any script in the offscreen data-URL document (theme values,
  // document HTML) — print/PDF only needs styles + the body markup.
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">` +
    `<style>
    ${safeCss}
    @page { size: letter; margin: 20mm; }
    body { font-family: var(--doc-font); font-size: var(--doc-font-size);
           color: var(--doc-text-color); background: var(--doc-bg);
           max-width: var(--doc-max-width); margin: 0 auto; padding: 24px; line-height: 1.65; }
    @media print {
      body { max-width: 100% !important; padding: 0; }
      table { table-layout: fixed; word-break: break-word; }
      pre { white-space: pre-wrap; overflow-wrap: anywhere; }
      td, p { overflow-wrap: break-word; }
    }
    h1,h2,h3,h4 { color: var(--doc-heading-color); }
    a { color: var(--doc-accent); }
    code { font-family: var(--doc-code-font); background: var(--doc-code-bg); padding: 0.15em 0.35em; border-radius: 4px; }
    pre { background: var(--doc-code-bg); padding: 12px 16px; border-radius: 8px; }
    pre code { background: none; padding: 0; }
    blockquote { border-left: 3px solid var(--doc-accent); margin-left: 0; padding-left: 16px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #d0d7de; padding: 6px 10px; }
    th { background: var(--doc-code-bg); }
    img { max-width: 100%; }
  </style></head><body>${html}</body></html>`
}

// IPC: render themed HTML to a PDF file via printToPDF (preserves CSS exactly).
// args: { filePath, html, css } → { ok, error? }
ipcMain.handle('export-pdf-to', async (_event, { filePath, html, css }) => {
  if (!isApproved(filePath)) return { ok: false, error: APPROVED_PATHS_ERROR }
  const fullHtml = buildPrintableHtml(html, css)
  let win = null
  try {
    win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fullHtml))
    const pdf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true })
    fs.writeFileSync(filePath, pdf)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  } finally {
    win?.destroy()
  }
})

app.whenReady().then(() => {
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
