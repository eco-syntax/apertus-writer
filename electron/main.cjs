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

  // Open external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
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

// IPC: persist the current working document. → { ok, error? }
// args: { docName, filePath, content }
ipcMain.handle('session-save', async (_event, { docName, filePath, content }) => {
  try {
    const data = JSON.stringify({ docName, filePath, content })
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
    return {
      ok: true,
      session: {
        docName: typeof session.docName === 'string' ? session.docName : 'untitled.md',
        filePath: typeof session.filePath === 'string' || session.filePath === null ? session.filePath : null,
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
  return { canceled: false, filePath: filePaths[0] }
})

// IPC: read a UTF-8 text file. → { ok, content?, error? }
ipcMain.handle('read-file', async (_event, { filePath }) => {
  try {
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
  return { canceled: false, filePath }
})

// IPC: write base64-encoded bytes to a file. → { ok, error? }
ipcMain.handle('write-file', async (_event, { filePath, base64 }) => {
  try {
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
    const cssPath = filePath.replace(/\.(md|markdown|txt)$/i, '.css')
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
    const cssPath = filePath.replace(/\.(md|markdown|txt)$/i, '.css')
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
