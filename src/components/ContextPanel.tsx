// Dropdown panel for managing shared reference context (files + URLs) used by
// both chat and autocomplete.
import { useContextItems } from '../store/context'
import type { Settings } from '../store/settings'
import ContextAttachments from './ContextAttachments'

export default function ContextPanel({ settings, onClose }: { settings: Settings; onClose: () => void }) {
  const items = useContextItems()

  return (
    <div className="context-panel">
      <div className="context-panel-header">
        <strong>Reference context</strong>
        <button className="tb-btn" onClick={onClose}>✕</button>
      </div>
      <p className="context-panel-note">
        Attached files and URLs are included as context for <em>both</em> chat and
        autocomplete, so suggestions match their style and content.
      </p>
      {items.length === 0 && <p className="context-panel-empty">No reference documents attached.</p>}
      <ContextAttachments settings={settings} />
    </div>
  )
}
