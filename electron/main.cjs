// Electron main process.
// The renderer delegates AI API calls here via IPC because Node.js networking
// is not subject to browser CORS restrictions — this lets the app talk to any
// endpoint (local servers, third-party hosted APIs) without proxies.
const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron')
const path = require('path')
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

  // The renderer is a self-contained SPA that never navigates. Lock the main
  // frame to its own URL so a crafted link (or prompt-injected model output)
  // can't navigate the whole window to an attacker-controlled page running
  // with the app's preload privileges. URLs are normalized (e.g. a trailing
  // slash) so the dev server's own redirects still count as the same page.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const norm = (u) => { try { return new URL(u).toString() } catch { return null } }
    if (norm(url) !== norm(mainWindow.webContents.getURL())) event.preventDefault()
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

// Chat history: one message thread per document, keyed by filePath (or
// 'untitled:<docName>' for never-saved docs). Stored as a JSON map in userData
// so a document's chat is restored when it is reopened. Mirrors session.json.
function chatsPath() {
  return path.join(app.getPath('userData'), 'chats.json')
}

function readChats() {
  try {
    return JSON.parse(fs.readFileSync(chatsPath(), 'utf8')) || {}
  } catch {
    return {}
  }
}

// IPC: persist a document's chat thread. args: { key, messages } → { ok }
ipcMain.handle('chat-save', async (_event, { key, messages }) => {
  try {
    const store = readChats()
    if (Array.isArray(messages) && messages.length === 0) delete store[key]
    else store[key] = messages
    fs.writeFileSync(chatsPath(), JSON.stringify(store), 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

// IPC: read a document's chat thread. args: { key } → { ok, messages }
ipcMain.handle('chat-load', async (_event, { key }) => {
  try {
    const store = readChats()
    const messages = Array.isArray(store[key]) ? store[key] : []
    return { ok: true, messages }
  } catch {
    return { ok: true, messages: [] }
  }
})

// Reference context (attached files/URLs): one set per document, keyed like
// chat history. Stored as a JSON map in userData so a document's attachments
// are restored when it is reopened. Mirrors chats.json.
function contextPath() {
  return path.join(app.getPath('userData'), 'context.json')
}

function readContextStore() {
  try {
    return JSON.parse(fs.readFileSync(contextPath(), 'utf8')) || {}
  } catch {
    return {}
  }
}

// IPC: persist a document's reference context. args: { key, items } → { ok }
ipcMain.handle('context-save', async (_event, { key, items }) => {
  try {
    const store = readContextStore()
    if (Array.isArray(items) && items.length === 0) delete store[key]
    else store[key] = items
    fs.writeFileSync(contextPath(), JSON.stringify(store), 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

// IPC: read a document's reference context. args: { key } → { ok, items }
ipcMain.handle('context-load', async (_event, { key }) => {
  try {
    const store = readContextStore()
    const items = Array.isArray(store[key]) ? store[key] : []
    return { ok: true, items }
  } catch {
    return { ok: true, items: [] }
  }
})

// IPC: perform an HTTP request on behalf of the renderer.
// args: { url, method, headers, body } → { ok, status, statusText, body }
ipcMain.handle('ai-request', async (_event, { url, method, headers, body }) => {
  try {
    const res = await fetch(url, { method, headers, body })
    const text = await res.text()
    return { ok: res.ok, status: res.status, statusText: res.statusText, body: text }
  } catch (err) {
    return { ok: false, status: 0, statusText: String(err), body: '' }
  }
})

// IPC: show an open dialog for markdown/text files. → { canceled, filePath? }
// Needed because Chromium only shows a file chooser on a user activation, so a
// menu-triggered input.click() in the renderer is silently ignored.
ipcMain.handle('choose-open-path', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Markdown/Text', extensions: ['md', 'markdown', 'txt'] }],
  })
  if (canceled || filePaths.length === 0) return { canceled: true }
  approve(filePaths[0])
  return { canceled: false, filePath: filePaths[0] }
})

// IPC: read a UTF-8 text file. → { ok, content?, error? }
ipcMain.handle('read-file', async (_event, { filePath }) => {
  try {
    // Reads are limited to dialog-approved markdown/text documents.
    if (!isApproved(filePath) || !/\.(md|markdown|txt)$/i.test(filePath)) {
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

// IPC: write base64-encoded bytes to a file. → { ok, error? }
ipcMain.handle('write-file', async (_event, { filePath, base64 }) => {
  try {
    if (!isApproved(filePath)) return { ok: false, error: APPROVED_PATHS_ERROR }
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'))
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
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${css}
    body { font-family: var(--doc-font); font-size: var(--doc-font-size);
           color: var(--doc-text-color); background: var(--doc-bg);
           max-width: var(--doc-max-width); margin: 0 auto; padding: 24px; line-height: 1.65; }
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
    const pdf = await win.webContents.printToPDF({ printBackground: true })
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
