import { useCallback, useEffect, useRef, useState } from 'react'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import Table from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import Toolbar from './components/Toolbar'
import ConfirmDialog from './components/ConfirmDialog'
import StylePanel, { DEFAULT_THEME, themeToCss, cssToTheme, type ThemeVars } from './components/StylePanel'
import ChatSidebar from './components/ChatSidebar'
import SettingsDialog from './components/SettingsDialog'
import { Autocomplete } from './components/Autocomplete'
import { markdownToHtml, htmlToMarkdown } from './store/markdown'
import { loadSettings, saveSettings, type Settings } from './store/settings'
import { getBridge, blobToBase64 } from './store/bridge'
import { getContextItems, useContextItems, setContextItems } from './store/context'
import ContextPanel from './components/ContextPanel'
import * as ai from './api/openai'
import { chatKey, loadContext, saveContext } from './store/chatStorage'

const WELCOME_MD = `# Welcome to Apertus Writer

This is a **WYSIWYG markdown editor** — you edit the rendered document directly, and it saves as markdown.

## AI autocomplete (Ctrl-Space)

Press **Ctrl-Space** and a ghost-text suggestion appears; press **Tab** to accept it, or keep typing to dismiss. Turn on the toolbar's **✨ Auto** toggle to get suggestions automatically whenever you pause typing.

To use it, you need a running **OpenAI-compatible server** with the base model *apertus-v1.1-4b* loaded — e.g. LM Studio on http://localhost:1234/v1, Ollama, or any provider.

Set the base URL and model in ⚙️ **Settings** → *Autocomplete*, then press **Test connection**. The default points at a local LM Studio server.

## Chat sidebar

Open the **💬 Chat sidebar** to talk with your document. It uses the instruct model *apertus-v1.1-4b-instruct* and can point at any endpoint (local or cloud).

Configure it in ⚙️ **Settings** → *Chat*, with its own base URL, model, and API key.

## Any endpoint works

Both features accept any OpenAI-compatible endpoint. If you use a cloud provider, set the API key in Settings too. If the server is on a different machine, use its URL here.

> In the installed app, whatever you type here autosaves and returns on relaunch — so treat this page as a scratch pad, or open a file with the **Open** button.
`

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [docName, setDocName] = useState('untitled.md')
  // On-disk path of the current document (Electron); null = never saved to disk.
  const [filePath, setFilePath] = useState<string | null>(null)
  const [theme, setTheme] = useState<ThemeVars>(DEFAULT_THEME)
  const [themeName, setThemeName] = useState('Default')
  const [zoom, setZoom] = useState(1)
  const [showStyles, setShowStyles] = useState(false)
  const [showChat, setShowChat] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showContext, setShowContext] = useState(false)
  const contextItems = useContextItems()
  const contextCount = contextItems.length
  const sessionKey = chatKey(filePath, docName)
  const [dirty, setDirty] = useState(false)
  const [codeView, setCodeView] = useState(false)
  const [codeText, setCodeText] = useState('')
  const openFileRef = useRef<HTMLInputElement>(null)
  const imageFileRef = useRef<HTMLInputElement>(null)
  const styleTagRef = useRef<HTMLStyleElement | null>(null)

  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const [aiError, setAiError] = useState<string | null>(null)

  // --- Session persistence ---------------------------------------------------
  // The working document (markdown + name + on-disk path) is autosaved to a
  // session file ~1s after the last edit and restored on startup, so the app
  // reopens whatever you were working on instead of the welcome page. Lives in
  // the Electron main process (plain-browser sessions are unaffected).
  // Refs mirror the state values the debounced save needs at fire time —
  // closure-captured values would go stale. One object keeps them in sync.
  const sessionRef = useRef({ docName, filePath, codeView, codeText })
  sessionRef.current = { docName, filePath, codeView, codeText }
  const editorRef = useRef<Editor | null>(null)
  const sessionTimerRef = useRef<number | null>(null)

  const saveSessionNow = useCallback(() => {
    const bridge = getBridge()
    const ed = editorRef.current
    if (!bridge?.sessionSave || !ed) return
    const s = sessionRef.current
    const content = s.codeView ? s.codeText : htmlToMarkdown(ed.getHTML())
    void bridge.sessionSave({ docName: s.docName, filePath: s.filePath, content })
  }, [])

  const scheduleSessionSave = useCallback(() => {
    if (sessionTimerRef.current != null) window.clearTimeout(sessionTimerRef.current)
    sessionTimerRef.current = window.setTimeout(() => {
      sessionTimerRef.current = null
      saveSessionNow()
    }, 1000)
  }, [saveSessionNow])

  // Build the completions prompt. Reference documents are wrapped in <s>…</s>
  // — the document boundary token used in Apertus pretraining — so the base
  // model treats them as separate prior documents and continues the current
  // one (the final, unclosed <s>). No instruction text is added, so nothing
  // can leak into suggestions.
  const fetchSuggestion = useCallback(async (context: string) => {
    // Guard: don't attempt a network call when the endpoint isn't configured.
    const cfg = settingsRef.current.autocomplete
    if (!cfg.baseUrl?.trim() || !cfg.model?.trim()) {
      setAiError('Autocomplete not configured — set a base URL and model in Settings.')
      return ''
    }
    // Total budget for reference docs, sized to fit typical LM Studio context
    // lengths (4096 tokens ≈ 16k chars) alongside the 1.5k-char document
    // context and generation headroom.
    const REF_BUDGET = 6000
    const refs = getContextItems()
    let wrapped = ''
    if (refs.length > 0) {
      let budget = REF_BUDGET
      for (const r of refs) {
        // Prefer the instruct-model summary; fall back to a raw head excerpt
        // while summarization is pending or if it failed.
        const text = r.summary || r.content.slice(0, 1000)
        if (text.length > budget) continue
        budget -= text.length
        wrapped += `<s>${text}</s>`
      }
    }
    const buildPrompt = (withRefs: boolean) =>
      withRefs && wrapped ? `${wrapped}<s>${context}` : context
    try {
      let text: string
      try {
        text = await ai.autocomplete(settingsRef.current.autocomplete, buildPrompt(true))
      } catch (err) {
        // Context window exceeded despite budgeting: retry without references.
        if (!wrapped || !/400|context/i.test(String(err))) throw err
        text = await ai.autocomplete(settingsRef.current.autocomplete, buildPrompt(false))
      }
      setAiError(null)
      return text
    } catch (err) {
      setAiError(`Autocomplete: ${err}`)
      return ''
    }
  }, [])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4] } }),
      Image,
      Link.configure({ openOnClick: false }),
      Placeholder.configure({ placeholder: 'Start writing… (Ctrl-Space for an AI suggestion)' }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Autocomplete.configure({
        fetchSuggestion,
        shouldAutoSuggest: () => settingsRef.current.autoSuggestEnabled,
      }),
    ],
    content: markdownToHtml(WELCOME_MD),
    onUpdate: () => { setDirty(true); scheduleSessionSave() },
    editorProps: {
      attributes: { spellcheck: settings.spellcheckEnabled ? 'true' : 'false' },
    },
  })

  editorRef.current = editor

  // Restore the previous working document on startup. Runs once, after the
  // editor exists; the Electron bridge is absent in a plain browser, which
  // then keeps the welcome document.
  const restoredRef = useRef(false)
  useEffect(() => {
    if (!editor || restoredRef.current) return
    restoredRef.current = true
    const bridge = getBridge()
    if (!bridge?.sessionLoad) return
    bridge.sessionLoad().then(async (res) => {
      if (!res.ok || !res.session) return
      // Use the live editor instance rather than the closure capture: in dev
      // StrictMode the initial editor is destroyed and recreated before this
      // async callback runs.
      const ed = editorRef.current
      if (!ed) return
      ed.commands.setContent(markdownToHtml(res.session.content))
      setDocName(res.session.docName)
      setFilePath(res.session.filePath)
      setDirty(false)
      // Session restore bypasses openViaDialog, so read the sidecar here too —
      // otherwise a relaunch shows the doc with the default theme, and a later
      // save would overwrite its sidecar with that default.
      if (bridge.readSidecar && res.session.filePath) {
        const sc = await bridge.readSidecar({ filePath: res.session.filePath })
        if (sc.ok && sc.css) {
          setTheme(cssToTheme(sc.css))
          setThemeName(res.session.docName.replace(/\.(md|markdown|txt)$/i, ''))
        } else {
          setTheme(DEFAULT_THEME)
          setThemeName('Default')
        }
      }
    }).catch(() => { /* no saved session or sidecar */ })
  }, [editor])

  // Per-document reference context: load a document's saved attachments when
  // it is opened, and persist changes. loadedRef gates the save effect so the
  // pre-load state can't overwrite the stored set before loadContext resolves
  // (same race that chat history had).
  const contextLoadedRef = useRef(false)
  useEffect(() => {
    contextLoadedRef.current = false
    let cancelled = false
    void loadContext(sessionKey).then((loaded) => {
      if (cancelled) return
      setContextItems(loaded)
      contextLoadedRef.current = true
    })
    return () => { cancelled = true }
  }, [sessionKey])

  useEffect(() => {
    if (!contextLoadedRef.current) return
    saveContext(sessionKey, contextItems)
  }, [sessionKey, contextItems])

  // Live-toggle spellcheck when the setting changes
  useEffect(() => {
    editor?.setOptions({
      editorProps: { attributes: { spellcheck: settings.spellcheckEnabled ? 'true' : 'false' } },
    })
  }, [editor, settings.spellcheckEnabled])

  // Apply theme CSS variables to a live <style> tag
  useEffect(() => {
    if (!styleTagRef.current) {
      styleTagRef.current = document.createElement('style')
      styleTagRef.current.id = 'doc-theme'
      document.head.appendChild(styleTagRef.current)
    }
    styleTagRef.current.textContent = themeToCss(theme)
  }, [theme])

  const getMarkdown = useCallback(() => {
    if (codeView) return codeText
    if (!editor) return ''
    return htmlToMarkdown(editor.getHTML())
  }, [editor, codeView, codeText])

  // Toggle between WYSIWYG editing and raw markdown code view
  const toggleCodeView = useCallback(() => {
    if (!codeView) {
      if (!editor) return
      setCodeText(htmlToMarkdown(editor.getHTML()))
      setCodeView(true)
    } else {
      editor?.commands.setContent(markdownToHtml(codeText))
      setCodeView(false)
    }
  }, [codeView, codeText, editor])

  // File operations
  const [confirmNew, setConfirmNew] = useState(false)

  // Replacing the current document with an empty one; when there are unsaved
  // changes this is gated behind an in-app confirm instead of window.confirm —
  // the synchronous native modal steals focus and leaves the editor unable to
  // receive input afterwards.
  const newDocument = () => {
    if (dirty) { setConfirmNew(true); return }
    startNewDocument()
  }

  const startNewDocument = () => {
    setConfirmNew(false)
    editor?.chain().setContent('').focus('start').run()
    setDocName('untitled.md')
    setFilePath(null)
    setDirty(false)
    // A new doc has no sidecar; reset to the default theme so it doesn't
    // inherit the previously-opened document's styling.
    setTheme(DEFAULT_THEME)
    setThemeName('Default')
    scheduleSessionSave()
  }

  const loadMarkdown = (text: string, name: string, path: string | null = null) => {
    editor?.commands.setContent(markdownToHtml(text))
    setDocName(name)
    setFilePath(path)
    setDirty(false)
    scheduleSessionSave()
  }

  const openDocument = async (file: File) => {
    loadMarkdown(await file.text(), file.name)
  }

  // Open: in Electron, use the native open dialog via the bridge — a menu
  // action can't trigger the hidden <input type="file"> click because
  // Chromium only shows a file chooser on a user activation. In a plain
  // browser, fall back to the input (real clicks provide activation).
  const openViaDialog = async () => {
    const bridge = getBridge()
    if (!bridge?.chooseOpenPath) {
      openFileRef.current?.click()
      return
    }
    const choice = await bridge.chooseOpenPath()
    if (choice.canceled || !choice.filePath) return
    const res = await bridge.readFile({ filePath: choice.filePath })
    if (!res.ok || res.content === undefined) { flash(`Open failed: ${res.error}`); return }
    loadMarkdown(res.content, choice.filePath.split(/[\\/]/).pop() || choice.filePath, choice.filePath)
    // Restore the document's sidecar theme if one was saved alongside it;
    // otherwise fall back to the default theme so an unstyled doc doesn't
    // inherit the previously-opened document's look.
    if (bridge.readSidecar) {
      const sc = await bridge.readSidecar({ filePath: choice.filePath })
      if (sc.ok && sc.css) {
        setTheme(cssToTheme(sc.css))
        setThemeName((choice.filePath.split(/[\\/]/).pop() || 'theme').replace(/\.(md|markdown|txt)$/i, ''))
      } else {
        setTheme(DEFAULT_THEME)
        setThemeName('Default')
      }
    }
  }

  // Save: in Electron, overwrite the current file directly; the save dialog
  // only appears on the first save of a new document ("Save As"). In a plain
  // browser, fall back to a blob download.
  const saveDocument = async (forceDialog = false) => {
    const md = getMarkdown()
    const bridge = getBridge()
    if (bridge?.chooseSavePath && bridge?.writeFile) {
      let path = filePath
      if (!path || forceDialog) {
        const choice = await bridge.chooseSavePath({ docName })
        if (choice.canceled || !choice.filePath) return
        path = choice.filePath
      }
      const res = await bridge.writeFile({ filePath: path, text: md })
      if (!res.ok) { flash(`Save failed: ${res.error}`); return }
      setFilePath(path)
      setDocName(path.split(/[\\/]/).pop() || path)
      setDirty(false)
      // Persist the (possibly new) name/path even though the content didn't
      // change in this save, so a restart restores the right file reference.
      scheduleSessionSave()
      // Write the document's theme to a sidecar .css next to the .md so the
      // style travels with the file (survives refresh, restart, and reopening).
      if (bridge.writeSidecar) {
        const sc = await bridge.writeSidecar({ filePath: path, css: themeToCss(theme) })
        if (!sc.ok) flash(`Style save failed: ${sc.error}`)
      }
      return
    }
    downloadBlob(new Blob([md], { type: 'text/markdown' }), docName)
    setDirty(false)
  }

  const saveTheme = () => {
    downloadBlob(new Blob([themeToCss(theme)], { type: 'text/css' }),
      `${themeName.toLowerCase().replace(/\s+/g, '-')}.css`)
  }

  const loadThemeFile = async (file: File) => {
    const css = await file.text()
    setTheme(cssToTheme(css))
    setThemeName(file.name.replace(/\.css$/, ''))
  }

  const insertImage = async (file: File) => {
    const dataUrl = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.readAsDataURL(file)
    })
    editor?.chain().focus().setImage({ src: dataUrl, alt: file.name }).run()
  }

  // Export: docx/odt are generated in-app with the active theme applied
  // (no external tools); pdf uses Electron printToPDF (or browser print).
  const [exportMsg, setExportMsg] = useState<string | null>(null)
  const [showExportMenu, setShowExportMenu] = useState(false)
  const flash = (msg: string, ms = 6000) => { setExportMsg(msg); setTimeout(() => setExportMsg(null), ms) }

  const downloadBlob = (blob: Blob, filename: string) => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = filename
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const buildExportBlob = async (format: 'docx' | 'odt'): Promise<Blob> => {
    if (!editor) throw new Error('No document')
    if (format === 'docx') {
      const { buildDocx } = await import('./store/exportDocx')
      return buildDocx(editor.getHTML(), theme)
    }
    const { buildOdt } = await import('./store/exportOdt')
    return buildOdt(editor.getHTML(), theme)
  }

  // Browser fallback path (no native dialogs): download for the chosen format
  const exportAs = async (format: 'docx' | 'odt' | 'pdf') => {
    if (!editor) return
    setShowExportMenu(false)
    const base = docName.replace(/\.(md|markdown|txt)$/i, '')
    try {
      if (format === 'pdf') {
        window.print()
        return
      }
      downloadBlob(await buildExportBlob(format), `${base}.${format}`)
      flash(`Exported ${base}.${format}`)
    } catch (err) {
      flash(`Export failed: ${err}`)
    }
  }

  // Main export entry point. In Electron: one save dialog with format filters
  // — the chosen extension selects the format; message only after the file is
  // actually written. In a browser: dropdown of formats → blob download.
  const exportDocument = async () => {
    if (!editor) return
    const bridge = getBridge()
    if (!bridge?.chooseExportPath) {
      setShowExportMenu((v) => !v)
      return
    }
    try {
      const choice = await bridge.chooseExportPath({ docName })
      if (choice.canceled || !choice.filePath || !choice.format) return
      const { filePath, format } = choice
      if (format === 'pdf') {
        const res = await bridge.exportPdfTo({ filePath, html: editor.getHTML(), css: themeToCss(theme) })
        if (!res.ok) { flash(`Export failed: ${res.error}`); return }
      } else {
        const blob = await buildExportBlob(format)
        const base64 = await blobToBase64(blob)
        const res = await bridge.writeFile({ filePath, base64 })
        if (!res.ok) { flash(`Export failed: ${res.error}`); return }
      }
      flash(`Exported to ${filePath}`)
    } catch (err) {
      flash(`Export failed: ${err}`)
    }
  }

  // Print: Electron opens the native print dialog on themed HTML; the browser
  // falls back to window.print() with the @media print stylesheet hiding UI.
  const printDocument = async () => {
    if (!editor) return
    const bridge = getBridge()
    if (bridge?.printDocument) {
      const res = await bridge.printDocument({ html: editor.getHTML(), css: themeToCss(theme) })
      if (!res.ok) flash(`Print failed: ${res.error}`)
    } else {
      window.print()
    }
  }

  // Application-menu actions (Electron): File → Open / Save / Export
  useEffect(() => {
    const bridge = getBridge()
    if (!bridge?.onMenuAction) return
    return bridge.onMenuAction((action) => {
      if (action === 'new') newDocument()
      else if (action === 'open') openViaDialog()
      else if (action === 'save') saveDocument()
      else if (action === 'saveAs') saveDocument(true)
      else if (action === 'export') exportDocument()
      else if (action === 'print') printDocument()
    })
  })

  // Flush any pending debounced autosave on exit so the session file is fully
  // up to date. No beforeunload prevention: dirty only means "not yet written
  // to the .md file", and the working copy is already autosaved to session, so
  // the window is allowed to close unconditionally. (A native
  // will-prevent-unload dialog here is unreliable in Electron and can leave
  // the window unable to close.)
  useEffect(() => {
    const handler = () => {
      if (sessionTimerRef.current != null) {
        window.clearTimeout(sessionTimerRef.current)
        sessionTimerRef.current = null
        saveSessionNow()
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [saveSessionNow])

  // Ctrl-S to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        saveDocument()
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        toggleCodeView()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-title">Apertus Writer</span>
        <button className="tb-btn" onClick={newDocument}>New</button>
        <button className="tb-btn" onClick={openViaDialog}>Open</button>
        <input ref={openFileRef} type="file" accept=".md,.markdown,.txt" hidden
          onChange={(e) => e.target.files?.[0] && openDocument(e.target.files[0])} />
        <button className="tb-btn" onClick={() => saveDocument()}>Save{dirty ? ' •' : ''}</button>
        <span className="export-wrap">
          <button className="tb-btn" onClick={exportDocument}>Export…</button>
          {showExportMenu && (
            <div className="export-dropdown">
              <button className="tb-btn" onClick={() => exportAs('docx')}>Word (.docx)</button>
              <button className="tb-btn" onClick={() => exportAs('odt')}>OpenDocument (.odt)</button>
              <button className="tb-btn" onClick={() => exportAs('pdf')}>PDF (.pdf)</button>
            </div>
          )}
        </span>
        <span className="spacer" />
        <span className="doc-name">{docName}</span>
        <button className="tb-btn" title="Reference context for chat & autocomplete"
          onClick={() => setShowContext((v) => !v)}>
          📎 Context{contextCount > 0 ? ` (${contextCount})` : ''}
        </button>
        <button className="tb-btn" title="Style themes" onClick={() => setShowStyles((v) => !v)}>🎨 Styles</button>
        <button className="tb-btn" title="Chat with AI" onClick={() => setShowChat((v) => !v)}>💬 Chat</button>
        <button className="tb-btn" title="Settings" onClick={() => setShowSettings(true)}>⚙️</button>
      </header>

      <Toolbar editor={editor} onInsertImage={() => imageFileRef.current?.click()}
        codeView={codeView} onToggleCodeView={toggleCodeView}
        autoSuggest={settings.autoSuggestEnabled}
        onToggleAutoSuggest={() => {
          const next = { ...settingsRef.current, autoSuggestEnabled: !settingsRef.current.autoSuggestEnabled }
          setSettings(next)
          saveSettings(next)
        }}
        zoom={zoom} onZoomChange={setZoom} />
      <input ref={imageFileRef} type="file" accept="image/*" hidden
        onChange={(e) => e.target.files?.[0] && insertImage(e.target.files[0])} />

      {(exportMsg || aiError) && (
        <div className="status-bar">{exportMsg ?? aiError}</div>
      )}

      {showContext && <ContextPanel settings={settings} onClose={() => setShowContext(false)} />}

      <div className="app-body">
        <main className="doc-scroll">
          {codeView ? (
            <textarea
              className="doc-codeview"
              value={codeText}
              onChange={(e) => { setCodeText(e.target.value); setDirty(true); scheduleSessionSave() }}
              spellCheck={settings.spellcheckEnabled}
              placeholder="# Raw markdown…"
            />
          ) : (
            <div className="doc-page" style={{ zoom }}>
              <EditorContent editor={editor} />
            </div>
          )}
        </main>

        {showStyles && (
          <aside className="side">
            <StylePanel
              theme={theme}
              themeName={themeName}
              onChange={(v, n) => { setTheme(v); setThemeName(n); setDirty(true) }}
              onClose={() => setShowStyles(false)}
            />
            <div className="style-actions">
              <button className="tb-btn" onClick={saveTheme}>Save theme .css</button>
              <label className="tb-btn file-label">
                Load theme…
                <input type="file" accept=".css" hidden
                  onChange={(e) => e.target.files?.[0] && loadThemeFile(e.target.files[0])} />
              </label>
            </div>
          </aside>
        )}

        {showChat && (
          <aside className="side wide">
            <ChatSidebar
              settings={settings}
              getDocumentMarkdown={getMarkdown}
              sessionKey={sessionKey}
              onClose={() => setShowChat(false)}
            />
          </aside>
        )}
      </div>

      {confirmNew && (
        <ConfirmDialog
          title="New document"
          message="Discard unsaved changes and start a new document?"
          confirmLabel="Discard & New"
          onCancel={() => setConfirmNew(false)}
          onConfirm={startNewDocument}
        />
      )}

      {showSettings && (
        <SettingsDialog
          settings={settings}
          onSave={(s) => { setSettings(s); saveSettings(s); setShowSettings(false) }}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}
