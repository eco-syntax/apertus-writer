// Weave dialog: walks the document's AI placeholder blocks one at a time,
// generates two candidates per block, and lets the user pick one — or dismiss
// both and write their own replacement. The editor is set read-only while the
// dialog is open, so recorded positions stay valid within each step; after
// each choice the document is re-scanned for the next placeholder.
import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { markdownToHtml } from '../store/markdown'
import { buildMessages, collectPlaceholders, generateCandidates } from '../store/weave'
import type { EndpointConfig } from '../api/openai'

interface Props {
  editor: Editor
  cfg: EndpointConfig // chat (instruct) endpoint config
  onApply: (pos: number, markdown: string) => void
  onClose: () => void
}

type Phase = 'generating' | 'choosing' | 'error' | 'done'

export default function WeaveDialog({ editor, cfg, onApply, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>('generating')
  const [index, setIndex] = useState(0)
  const [description, setDescription] = useState('')
  const [pos, setPos] = useState(0)
  const [candidates, setCandidates] = useState<string[]>([])
  const [error, setError] = useState('')
  const [showOwn, setShowOwn] = useState(false)
  const [ownText, setOwnText] = useState('')
  const [woven, setWoven] = useState(0)
  // Blocks explicitly skipped ("leave as placeholder"). These stay in the doc,
  // while woven blocks disappear, so the re-scanned hit list keeps the skipped
  // ones at its head. Process hits[skipped] — the first not-yet-handled block —
  // instead of hits[index]: using the growing index against the shrinking array
  // skips/blocks out of order once an earlier block is woven.
  const [skipped, setSkipped] = useState(0)
  // Total placeholders when the run started (frozen; the live count shrinks
  // as blocks are woven).
  const totalRef = useRef(0)
  // Incremented on "Try again" so the generation effect re-runs for the same
  // block index.
  const [attempt, setAttempt] = useState(0)

  // One generation pass per (block, attempt). The effect owns the whole step:
  // find the current placeholder, describe it, generate, then present.
  useEffect(() => {
    const hits = collectPlaceholders(editor)
    if (totalRef.current === 0) totalRef.current = hits.length
    if (skipped >= hits.length) {
      setPhase('done')
      return
    }
    const hit = hits[skipped]
    setDescription(hit.description)
    setPos(hit.pos)
    setPhase('generating')
    let cancelled = false
    generateCandidates(cfg, buildMessages(hit, editor))
      .then(([a, b]) => {
        if (cancelled) return
        const ok = [a, b].filter((t) => t)
        if (ok.length === 0) {
          setError('The model returned nothing usable for this block.')
          setPhase('error')
          return
        }
        // Randomize which candidate is shown first to avoid position bias.
        const ordered = ok.length === 2 && Math.random() < 0.5 ? [ok[1], ok[0]] : ok
        setCandidates(ordered)
        setShowOwn(false)
        setOwnText('')
        setPhase('choosing')
      })
      .catch((err) => {
        if (cancelled) return
        setError(String(err))
        setPhase('error')
      })
    return () => { cancelled = true }
  }, [editor, cfg, index, skipped, attempt])

  const advance = (markdown: string | null) => {
    if (markdown !== null) {
      onApply(pos, markdown)
      setWoven((w) => w + 1)
    } else {
      setSkipped((s) => s + 1)
    }
    setIndex((i) => i + 1)
  }

  const empty = totalRef.current === 0

  return (
    <div className="modal-backdrop">
      <div className="modal weave-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong>🪄 Weave placeholder blocks</strong>
          <button className="tb-btn" title={phase === 'choosing' ? 'Cancel — woven blocks are kept' : 'Close'}
            onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {empty && (
            <p className="weave-note">
              No placeholder blocks in this document. Insert one with the 🧩 Placeholder button,
              then run Weave again.
            </p>
          )}

          {phase === 'generating' && (
            <p className="weave-note">
              Generating 2 candidates for block {index + 1} of {totalRef.current}…
              <br /><em>{description.trim() || '(no description)'}</em>
            </p>
          )}

          {phase === 'error' && (
            <>
              <p className="weave-error">Weave failed for block {index + 1}: {error}</p>
              <div className="weave-actions">
                <button className="tb-btn primary" onClick={() => setAttempt((a) => a + 1)}>Try again</button>
                <button className="tb-btn" onClick={() => advance(null)}>Skip block</button>
              </div>
            </>
          )}

          {phase === 'choosing' && (
            <>
              <p className="weave-note">
                Block {index + 1} of {totalRef.current}: <em>{description.trim() || '(no description)'}</em>
              </p>
              <div className="weave-candidates">
                {candidates.map((c, i) => (
                  <div className="weave-candidate" key={i}>
                    <div className="weave-candidate-head">
                      <span className="weave-candidate-label">Candidate {String.fromCharCode(65 + i)}</span>
                      <button className="tb-btn primary" onClick={() => advance(c)}>Use this one</button>
                    </div>
                    <div className="weave-candidate-body" dangerouslySetInnerHTML={{ __html: markdownToHtml(c) }} />
                  </div>
                ))}
              </div>
              {showOwn ? (
                <div className="weave-own">
                  <textarea
                    className="weave-own-input"
                    value={ownText}
                    onChange={(e) => setOwnText(e.target.value)}
                    placeholder="Write your own replacement (markdown)…"
                    autoFocus
                  />
                  <div className="weave-actions">
                    <button className="tb-btn primary" disabled={!ownText.trim()}
                      onClick={() => advance(ownText)}>Use mine</button>
                    <button className="tb-btn" onClick={() => setShowOwn(false)}>Back to candidates</button>
                  </div>
                </div>
              ) : (
                <div className="weave-actions">
                  <button className="tb-btn" onClick={() => setShowOwn(true)}>Neither — write my own</button>
                  <button className="tb-btn" onClick={() => advance(null)}>Skip block</button>
                </div>
              )}
            </>
          )}

          {phase === 'done' && !empty && (
            <p className="weave-note">
              Wove {woven} of {totalRef.current} placeholder
              {totalRef.current === 1 ? '' : 's'}. Skipped blocks were left as placeholders.
            </p>
          )}
        </div>
        <div className="modal-footer">
          <button className="tb-btn primary" onClick={onClose}>
            {phase === 'done' || empty ? 'Close' : 'Cancel weave'}
          </button>
        </div>
      </div>
    </div>
  )
}
