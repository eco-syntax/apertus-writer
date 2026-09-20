import { useState } from 'react'
import type { Settings } from '../store/settings'
import { testConnection, type EndpointConfig } from '../api/openai'

interface Props {
  settings: Settings
  keychainUnavailable?: boolean
  onSave: (s: Settings) => void
  onClose: () => void
}

function EndpointFields({
  title,
  value,
  onChange,
  testKind = 'chat',
  keysLocked,
}: {
  title: string
  value: EndpointConfig
  onChange: (v: EndpointConfig) => void
  testKind?: 'completions' | 'chat'
  keysLocked: boolean
}) {
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)

  const runTest = async () => {
    setTesting(true)
    setTestResult(null)
    const err = await testConnection(value, testKind)
    setTestResult(err ?? '✅ Connected successfully')
    setTesting(false)
  }

  return (
    <fieldset className="endpoint-fields">
      <legend>{title}</legend>
      <label>Base URL
        <input value={value.baseUrl} placeholder="http://localhost:1234/v1"
          onChange={(e) => onChange({ ...value, baseUrl: e.target.value })} />
      </label>
      <label>Model
        <input value={value.model}
          onChange={(e) => onChange({ ...value, model: e.target.value })} />
      </label>
      <label>API key (leave empty for local servers)
        <input type="password" value={value.apiKey} disabled={keysLocked}
          onChange={(e) => onChange({ ...value, apiKey: e.target.value })} />
      </label>
      <div className="test-row">
        <button type="button" className="tb-btn" onClick={runTest} disabled={testing}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        {testResult && <span className="test-result">{testResult}</span>}
      </div>
    </fieldset>
  )
}

export default function SettingsDialog({ settings, keychainUnavailable = false, onSave, onClose }: Props) {
  const [s, setS] = useState(settings)

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-header">
          <strong>Settings</strong>
          <button className="tb-btn" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <p className="settings-note">
            Any OpenAI-compatible endpoint works (LM Studio, Public AI, OpenAI, Ollama…).
            Defaults point to a local LM Studio server.
          </p>

          {keychainUnavailable && (
            <div className="settings-warning">
              ⚠️ The OS keychain isn't available on this system, so API keys can't be
              safely saved at rest. They're being read from environment variables
              (APERTUS_API_KEY / APERTUS_AUTOCOMPLETE_API_KEY / APERTUS_CHAT_API_KEY).
            </div>
          )}

          <fieldset className="endpoint-fields">
            <legend>General</legend>
            <label className="row">
              <input type="checkbox" checked={s.spellcheckEnabled}
                onChange={(e) => setS({ ...s, spellcheckEnabled: e.target.checked })} />
              Enable spell check
            </label>
          </fieldset>

          <EndpointFields
            title="Autocomplete (base model, /completions)"
            value={s.autocomplete}
            onChange={(v) => setS({ ...s, autocomplete: v })}
            testKind="completions"
            keysLocked={keychainUnavailable}
          />

          <EndpointFields
            title="Chat (instruct model, /chat/completions)"
            value={s.chat}
            onChange={(v) => setS({ ...s, chat: v })}
            testKind="chat"
            keysLocked={keychainUnavailable}
          />
        </div>

        <div className="modal-footer">
          <button className="tb-btn primary" onClick={() => onSave(s)}>Save</button>
          <button className="tb-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
