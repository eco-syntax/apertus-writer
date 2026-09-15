// Per-document chat persistence. One message thread per document, keyed by
// filePath (or 'untitled:<docName>' for never-saved docs). Electron stores a
// JSON map in userData (chats.json); a plain browser falls back to localStorage.
import type { ChatMessage } from '../api/openai'
import type { ExtraContext } from './context'
import { getBridge } from './bridge'

export function chatKey(filePath: string | null, docName: string): string {
  return filePath ?? `untitled:${docName}`
}

const PREFIX = 'apertus-writer-chat:'
const CONTEXT_PREFIX = 'apertus-writer-context:'

// One store for a JSON-array-per-key value: in Electron the value is read/
// written through a named bridge method; otherwise it falls back to
// localStorage under `prefix`. `bridgeLoad`/`bridgeSave` are bound once at
// module load (the preload bridge is present before the renderer bundle runs).
function makeStore<T>(
  prefix: string,
  bridgeLoad?: (key: string) => Promise<T[]>,
  bridgeSave?: (key: string, value: T[]) => void,
) {
  return {
    async load(key: string): Promise<T[]> {
      if (bridgeLoad) {
        try { return await bridgeLoad(key) } catch { return [] }
      }
      try {
        const raw = localStorage.getItem(prefix + key)
        return raw ? (JSON.parse(raw) as T[]) : []
      } catch {
        return []
      }
    },
    save(key: string, value: T[]): void {
      if (bridgeSave) { bridgeSave(key, value); return }
      try { localStorage.setItem(prefix + key, JSON.stringify(value)) } catch { /* quota / private mode */ }
    },
  }
}

const chatLoad = getBridge()?.chatLoad
const chatSave = getBridge()?.chatSave
const chatStore = makeStore<ChatMessage>(
  PREFIX,
  chatLoad && (async (key) => {
    const res = await chatLoad({ key })
    return res.ok ? (res.messages as ChatMessage[]) : []
  }),
  chatSave && ((key, value) => { void chatSave({ key, messages: value }) }),
)

const contextLoad = getBridge()?.contextLoad
const contextSave = getBridge()?.contextSave
const contextStore = makeStore<ExtraContext>(
  CONTEXT_PREFIX,
  contextLoad && (async (key) => {
    const res = await contextLoad({ key })
    return res.ok ? (res.items as ExtraContext[]) : []
  }),
  contextSave && ((key, value) => { void contextSave({ key, items: value }) }),
)

export const loadChat = (key: string) => chatStore.load(key)
export const saveChat = (key: string, messages: ChatMessage[]) => chatStore.save(key, messages)

export async function loadContext(key: string): Promise<ExtraContext[]> {
  const raw = await contextStore.load(key)
  // A summary of undefined means summarization was still pending when the item
  // was saved; on restore we won't re-run it, so treat as "no summary" ('')
  // rather than leaving the chip stuck on ⏳ forever.
  return raw.map((it) => ({ ...it, summary: it.summary === undefined ? '' : it.summary }))
}

export const saveContext = (key: string, items: ExtraContext[]) => contextStore.save(key, items)
