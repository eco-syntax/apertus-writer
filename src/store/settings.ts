import type { EndpointConfig } from '../api/openai'
import { getBridge } from './bridge'

export interface Settings {
  autocomplete: EndpointConfig
  chat: EndpointConfig
  spellcheckEnabled: boolean
  autoSuggestEnabled: boolean
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
// rest with the OS keychain). When safeStorage is unavailable (packaged
// Linux/Windows/CI without a keyring / DPAPI context), the main process falls
// back to reading keys from environment variables and flags `fromEnv` — keys
// are never written to the renderer's plaintext localStorage.
let secretKeysFromEnv = false
export async function loadSecretKeys(): Promise<{ autocomplete?: string; chat?: string }> {
  const bridge = getBridge()
  if (bridge?.secretLoad) {
    const res = await bridge.secretLoad()
    secretKeysFromEnv = !!res.fromEnv
    return res.ok ? (res.secrets ?? {}) : {}
  }
  return {}
}

// True when the OS-keychain secure store is unavailable and API keys are being
// supplied by environment variables (see main.cjs). The UI surfaces a notice so
// the user knows keys cannot be safely saved at rest for this session.
export function secretKeysFromEnvActive(): boolean {
  return secretKeysFromEnv
}

export async function saveSecretKeys(keys: { autocomplete: string; chat: string }): Promise<void> {
  const bridge = getBridge()
  if (bridge?.secretSave) {
    await bridge.secretSave({ secrets: keys })
  }
}

// Persist non-secret settings to localStorage. API keys are ALWAYS stripped
// here and never written to the renderer's plaintext localStorage. When the
// OS-keychain safeStorage store is available, keys are persisted encrypted via
// saveSecretKeys; when it is unavailable (no bridge / no keychain), secretSave
// no-ops and keys must come from environment variables instead — nothing is
// ever written in cleartext.
export function saveSettings(s: Settings) {
  const { apiKey: _ac, ...autocompleteSafe } = s.autocomplete
  const { apiKey: _ch, ...chatSafe } = s.chat
  localStorage.setItem(KEY, JSON.stringify({ ...s, autocomplete: autocompleteSafe, chat: chatSafe }))
  // Keys supplied by environment variables are read-only for this session and
  // must not be re-persisted (they cannot be written back to the keychain here).
  if (!secretKeysFromEnv) {
    void saveSecretKeys({ autocomplete: s.autocomplete.apiKey, chat: s.chat.apiKey })
  }
}
