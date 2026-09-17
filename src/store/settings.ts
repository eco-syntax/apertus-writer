import type { EndpointConfig } from '../api/openai'
import { getBridge } from './bridge'

export interface Settings {
  autocomplete: EndpointConfig
  chat: EndpointConfig
  spellcheckEnabled: boolean
  autoSuggestEnabled: boolean
  // Web managed mode (server.mjs APERTUS_* env vars): model names are set by
  // the host and endpoints/keys are hidden from the UI; requests go through
  // the proxy with relative paths. Not persisted — re-derived at startup.
  managed?: { autocomplete: string; chat: string }
}

// Defaults point at a local LM Studio server. Any OpenAI-compatible endpoint
// works — just make sure it allows cross-origin (CORS) browser requests.
export const DEFAULT_SETTINGS: Settings = {
  autocomplete: {
    baseUrl: 'http://localhost:1234/v1',
    apiKey: '',
    model: 'apertus-v1.1-4b',
  },
  chat: {
    baseUrl: 'http://localhost:1234/v1',
    apiKey: '',
    model: 'apertus-v1.1-4b-instruct',
  },
  spellcheckEnabled: true,
  autoSuggestEnabled: false,
}

const KEY = 'apertus-writer-settings-v6'

// loadSettings is sync and returns the non-secret parts (baseUrl, model,
// toggles) from localStorage. API keys are NOT persisted here — they are
// loaded async from the main-process safeStorage store (see loadSecretKeys) so
// they are never written to the renderer's plaintext localStorage. Legacy
// plaintext keys left over from a previous version are returned here too and
// migrated to safeStorage on the first loadSecretKeys() call.
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        autocomplete: { ...DEFAULT_SETTINGS.autocomplete, ...parsed.autocomplete },
        chat: { ...DEFAULT_SETTINGS.chat, ...parsed.chat },
      }
    }
  } catch { /* ignore */ }
  return DEFAULT_SETTINGS
}

// Fetch the persisted API keys from the main-process secret store (encrypted at
// rest with the OS keychain). In a plain browser (no bridge) there is no
// safeStorage, so keys fall back to localStorage — acceptable for `npm run dev`
// only, not the packaged app.
let secretStoreAvailable = false
export async function loadSecretKeys(): Promise<{ autocomplete?: string; chat?: string }> {
  const bridge = getBridge()
  if (bridge?.secretLoad) {
    const res = await bridge.secretLoad()
    secretStoreAvailable = res.ok && res.available !== false
    return res.ok ? (res.secrets ?? {}) : {}
  }
  return {}
}

export async function saveSecretKeys(keys: { autocomplete: string; chat: string }): Promise<void> {
  const bridge = getBridge()
  if (bridge?.secretSave) {
    await bridge.secretSave({ secrets: keys })
  }
}

// Web managed mode: ask the app server who owns the AI endpoints. Returns the
// host-configured model names, or null in BYOK mode / Electron / server down.
export async function loadManagedConfig(): Promise<{ autocomplete: string; chat: string } | null> {
  if (getBridge()) return null
  try {
    const res = await fetch('/api/config')
    if (!res.ok) return null
    const cfg = await res.json() as { managed?: boolean; autocomplete?: string; chat?: string }
    return cfg.managed && cfg.autocomplete && cfg.chat
      ? { autocomplete: cfg.autocomplete, chat: cfg.chat }
      : null
  } catch {
    return null
  }
}

// Persist non-secret settings to localStorage. When the OS-keychain
// safeStorage store is available, API keys are stripped here and persisted
// encrypted via saveSecretKeys; when it is unavailable (no bridge / no
// keychain), keys stay in localStorage as a fallback so they are not lost.
export function saveSettings(s: Settings) {
  if (secretStoreAvailable) {
    const { apiKey: _ac, ...autocompleteSafe } = s.autocomplete
    const { apiKey: _ch, ...chatSafe } = s.chat
    localStorage.setItem(KEY, JSON.stringify({ ...s, autocomplete: autocompleteSafe, chat: chatSafe }))
    void saveSecretKeys({ autocomplete: s.autocomplete.apiKey, chat: s.chat.apiKey })
    return
  }
  localStorage.setItem(KEY, JSON.stringify(s))
}
