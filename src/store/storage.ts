// Web-mode server-hosted file storage. When the admin starts the server with
// APERTUS_STORAGE_DIR set, the save/load buttons operate on a folder on the
// server instead of forcing browser downloads. All of these are no-ops / inert
// when the server has storage disabled (they just return no files / throw) —
// the App only calls them when /api/config reports storage.enabled.

export interface StorageConfig {
  enabled: boolean
  folder: string | null
}

// Ask the app server whether server-hosted storage is enabled (and for a
// presentational folder label to show the user). Returns disabled in Electron,
// in BYOK web mode with no storage, or if the server is down.
export async function loadStorageConfig(): Promise<StorageConfig> {
  try {
    const res = await fetch('/api/config')
    if (!res.ok) return { enabled: false, folder: null }
    const cfg = await res.json() as { storage?: { enabled?: boolean; folder?: string | null } }
    return { enabled: !!cfg.storage?.enabled, folder: cfg.storage?.folder ?? null }
  } catch {
    return { enabled: false, folder: null }
  }
}

export async function listServerFiles(): Promise<string[]> {
  const res = await fetch('/api/storage/list')
  const data = await res.json() as { ok: boolean; files?: string[]; error?: string }
  if (!data.ok) throw new Error(data.error || 'Failed to list server files')
  return data.files ?? []
}

export async function readServerFile(name: string): Promise<string> {
  const res = await fetch('/api/storage/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  const data = await res.json() as { ok: boolean; content?: string; error?: string }
  if (!data.ok || data.content === undefined) throw new Error(data.error || 'Failed to read server file')
  return data.content
}

export async function writeServerFile(name: string, content: string): Promise<void> {
  const res = await fetch('/api/storage/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, content }),
  })
  const data = await res.json() as { ok: boolean; error?: string }
  if (!data.ok) throw new Error(data.error || 'Failed to save to server')
}