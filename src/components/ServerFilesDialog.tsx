// Server-hosted file picker (web mode, admin-enabled). Lists the files in the
// admin-designated server folder and lets the user load one into the editor.
// Only shown when the server reports server storage enabled — otherwise Open
// keeps its default download-based behavior.
import { useEffect, useState } from 'react'
import { listServerFiles, readServerFile } from '../store/storage'

interface Props {
  folder: string | null
  onOpen: (name: string, content: string) => void
  onClose: () => void
}

export default function ServerFilesDialog({ folder, onOpen, onClose }: Props) {
  const [files, setFiles] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = () => {
    setBusy(true); setError(null)
    listServerFiles()
      .then(setFiles)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }
  useEffect(refresh, [])

  const pick = async (name: string) => {
    setBusy(true); setError(null)
    try {
      const content = await readServerFile(name)
      onOpen(name, content)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong>Open from server{folder ? ` — ${folder}` : ''}</strong>
          <button className="tb-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p>Choose a document to load from the server folder.</p>
          {error && <p className="status-bar">{error}</p>}
          <div className="file-list">
            {files.length === 0 && !busy && <span className="file-empty">No saved documents yet.</span>}
            {files.map((f) => (
              <button key={f} className="tb-btn file-row" onClick={() => pick(f)} disabled={busy}>
                📄 {f}
              </button>
            ))}
          </div>
          {busy && <span className="file-empty">Working…</span>}
        </div>
        <div className="modal-footer">
          <button className="tb-btn" onClick={refresh} disabled={busy}>Refresh</button>
          <button className="tb-btn primary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}