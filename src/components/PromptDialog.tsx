// A small in-app text-prompt modal (same rationale as ConfirmDialog: no
// synchronous window.prompt, which breaks the TipTap editor focus).
interface Props {
  title: string
  message?: string
  value: string
  onChange: (v: string) => void
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}

export default function PromptDialog({ title, message, value, onChange, confirmLabel, onConfirm, onCancel }: Props) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong>{title}</strong>
          <button className="tb-btn" onClick={onCancel}>✕</button>
        </div>
        <div className="modal-body">
          {message && <p>{message}</p>}
          <input
            value={value}
            autoFocus
            onFocus={(e) => e.target.select()}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onConfirm() }}
          />
        </div>
        <div className="modal-footer">
          <button className="tb-btn" onClick={onCancel}>Cancel</button>
          <button className="tb-btn primary" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
