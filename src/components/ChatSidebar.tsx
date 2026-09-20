import { useRef, useState, useEffect } from 'react'
import { marked } from 'marked'
import { chat, type ChatMessage } from '../api/openai'
import type { Settings } from '../store/settings'
import { useContextItems, removeContextItem } from '../store/context'
import { attachFiles, attachUrl } from '../store/summarize'
import { loadChat, saveChat } from '../store/chatStorage'

interface Props {
  settings: Settings
  getDocumentMarkdown: () => string
  // Any text currently selected in the document; empty when nothing is selected.
  selectedText: string
  sessionKey: string
  onClose: () => void
}

export default function ChatSidebar({ settings, getDocumentMarkdown, selectedText, sessionKey, onClose }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [includeDoc, setIncludeDoc] = useState(true)
  const extras = useContextItems()
  const [urlInput, setUrlInput] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Load this document's chat thread whenever the document identity changes.
  // loadedRef gates the save effect below so the initial empty state can't
  // clobber the stored history before the async load resolves.
  const loadedRef = useRef(false)
  useEffect(() => {
    loadedRef.current = false
    setMessages([])
    let cancelled = false
    void loadChat(sessionKey).then((m) => {
      if (cancelled) return
      loadedRef.current = true
      setMessages(m)
    })
    return () => { cancelled = true }
  }, [sessionKey])

  // Persist the thread on every change, but only after the first load has
  // completed for the current key (otherwise the mount-time [] overwrites the
  // stored history before loadChat resolves).
  useEffect(() => {
    if (!loadedRef.current) return
    saveChat(sessionKey, messages)
  }, [sessionKey, messages])

  const scrollDown = () => setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)

  const addFiles = (files: FileList | null) => attachFiles(files, settings.chat)

  const addUrl = async () => {
    const url = urlInput.trim()
    if (!url) return
    setUrlInput('')
    await attachUrl(url, settings.chat)
  }

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    const history: ChatMessage[] = [...messages, { role: 'user', content: text }]
    setMessages(history)
    setBusy(true)
    scrollDown()

    let system =
      'You are a helpful writing assistant embedded in a markdown document editor. ' +
      'Answer briefly and directly — at most a few short paragraphs. ' +
      'Do not repeat yourself, do not ask follow-up questions unless necessary, ' +
      'and stop when you have answered.'
    if (includeDoc) {
      system += `\n\nThe user is editing the following document:\n---\n${getDocumentMarkdown()}\n---`
    }
    // Surface the user's current document selection so they can ask for
    // re-wording or a rewrite of a specific passage.
    if (selectedText.trim()) {
      system += `\n\nThe user has selected the following passage in the document — this is what they most likely want help with (e.g. re-writing, shortening, or polishing):\n"""\n${selectedText.trim()}\
"""`
    }
    for (const ex of extras) {
      system += `\n\nAdditional context from ${ex.kind} "${ex.name}":\n---\n${ex.content}\n---`
    }

    try {
      const reply = await chat(settings.chat, [{ role: 'system', content: system }, ...history], 1024)
      setMessages([...history, { role: 'assistant', content: reply }])
    } catch (err) {
      setMessages([...history, { role: 'assistant', content: `⚠️ Error: ${err}` }])
    }
    setBusy(false)
    scrollDown()
  }

  return (
    <div className="chat-sidebar">
      <div className="panel-header">
        <strong>Chat</strong>
        <button className="tb-btn" title="Start a new chat session (clears this document's thread)"
          onClick={() => setMessages([])}>New session</button>
        <span className="chat-model-name" title={settings.chat.baseUrl}>{settings.chat.model}</span>
        <button className="tb-btn" onClick={onClose}>✕</button>
      </div>

      <div className="chat-controls">
        <label className="chat-ctx-toggle">
          <input type="checkbox" checked={includeDoc} onChange={(e) => setIncludeDoc(e.target.checked)} />
          Include document as context
        </label>
        {selectedText.trim() && (
          <div className="chat-selection">
            <span className="selection-label">📌 Selected:</span>
            <span className="selection-preview" title={selectedText}>
              {selectedText.length > 80 ? `${selectedText.slice(0, 80)}…` : selectedText}
            </span>
          </div>
        )}
      </div>

      <div className="chat-extras">
        {extras.map((ex, i) => (
          <span key={i} className="ctx-chip" title={ex.name}>
            {ex.kind === 'url' ? '🔗' : '📄'} {ex.name.slice(0, 30)}
            <button onClick={() => removeContextItem(i)}>✕</button>
          </span>
        ))}
        <div className="ctx-add">
          <button className="tb-btn" onClick={() => fileRef.current?.click()}>+ File</button>
          <input ref={fileRef} type="file" multiple accept=".md,.txt,.markdown,.pdf,.docx,.odt" hidden
            onChange={(e) => addFiles(e.target.files)} />
          <input placeholder="Add URL…" value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addUrl()} />
        </div>
      </div>

      <div className="chat-messages">
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            <div className="chat-role">{m.role === 'user' ? 'You' : 'AI'}</div>
            {m.role === 'assistant' ? (
              <div
                className="chat-text markdown"
                dangerouslySetInnerHTML={{ __html: marked.parse(m.content, { async: false }) as string }}
              />
            ) : (
              <div className="chat-text">{m.content}</div>
            )}
          </div>
        ))}
        {busy && <div className="chat-msg assistant"><div className="chat-text">…thinking…</div></div>}
        <div ref={bottomRef} />
      </div>

      <div className="chat-input">
        <textarea
          value={input}
          placeholder="Ask about your document…"
          rows={3}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
          }}
        />
        <button className="tb-btn send" onClick={send} disabled={busy}>Send</button>
      </div>
    </div>
  )
}
