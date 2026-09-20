import { useState } from 'react'
import type { Settings } from '../store/settings'
import { testConnection, type EndpointConfig } from '../api/openai'
import { getBridge } from '../store/bridge'

interface Props {
  settings: Settings
  managed?: { autocomplete: string; chat: string } | null
  onSave: (s: Settings) => void
  onClose: () => void
}

function EndpointFields({
  title,
  value,
  onChange,
  testKind = 'chat',
}: {
  title: string
  value: EndpointConfig
  onChange: (v: EndpointConfig) => void
  testKind?: 'completions' | 'chat'
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
        <input type="password" value={value.apiKey}
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

export default function SettingsDialog({ settings, managed, onSave, onClose }: Props) {
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

          <fieldset className="endpoint-fields">
            <legend>General</legend>
            <label className="row">
              <input type="checkbox" checked={s.spellcheckEnabled}
                onChange={(e) => setS({ ...s, spellcheckEnabled: e.target.checked })} />
              Enable spell check
            </label>
            {!getBridge() && (
              <label>Proxy password (match server's PROXY_PASSWORD, web mode only)
                <input type="password" value={s.proxyPassword} placeholder="Leave empty if the server has none"
                  onChange={(e) => setS({ ...s, proxyPassword: e.target.value })} />
              </label>
            )}
          </fieldset>

          {managed ? (
            <p className="settings-note">
              AI endpoints for this deployment are managed by the server host —
              nothing to configure. Models: <strong>{managed.autocomplete}</strong>{' '}
              (autocomplete), <strong>{managed.chat}</strong> (chat).
            </p>
          ) : (
            <>
              <EndpointFields
                title="Autocomplete (base model, /completions)"
                value={s.autocomplete}
                onChange={(v) => setS({ ...s, autocomplete: v })}
                testKind="completions"
              />

              <EndpointFields
                title="Chat (instruct model, /chat/completions)"
                value={s.chat}
                onChange={(v) => setS({ ...s, chat: v })}
                testKind="chat"
              />
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="tb-btn primary" onClick={() => onSave(s)}>Save</button>
          <button className="tb-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
