// Shared reference-context attachment UI (file picker + URL input + chips),
// used by both the chat sidebar and the context dropdown panel.
import { useRef, useState } from 'react'
import { useContextItems, removeContextItem } from '../store/context'
import { attachFiles, attachUrl } from '../store/summarize'
import type { Settings } from '../store/settings'

export default function ContextAttachments({ settings }: { settings: Settings }) {
  const items = useContextItems()
  const [urlInput, setUrlInput] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const addUrl = async () => {
    const url = urlInput.trim()
    if (!url || busy) return
    setUrlInput('')
    setBusy(true)
    await attachUrl(url, settings.chat)
    setBusy(false)
  }

  return (
    <>
      <div className="ctx-chips">
        {items.map((ex, i) => (
          <span key={i} className="ctx-chip"
            title={ex.summary === undefined ? `${ex.name} (summarizing…)` : ex.name}>
            {ex.summary === undefined ? '⏳' : ex.kind === 'url' ? '🔗' : '📄'} {ex.name.slice(0, 30)}
            <button onClick={() => removeContextItem(i)}>✕</button>
          </span>
        ))}
      </div>
      <div className="ctx-add">
        <button className="tb-btn" onClick={() => fileRef.current?.click()}>+ File</button>
        <input ref={fileRef} type="file" multiple accept=".md,.txt,.markdown,.pdf,.docx,.odt" hidden
          onChange={(e) => attachFiles(e.target.files, settings.chat)} />
        <input placeholder="Add URL…" value={urlInput} disabled={busy}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addUrl()} />
      </div>
    </>
  )
}
