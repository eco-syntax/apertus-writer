// Shared store for extra reference context (files / URLs) attached by the
// user. The chat sidebar reads full content; autocomplete and weave include
// budgeted excerpts via budgetedRefs — so items added in one place apply to
// all three features.
import { useSyncExternalStore } from 'react'
import { getBridge } from './bridge'

export interface ExtraContext {
  kind: 'file' | 'url'
  name: string
  content: string
  // Compressed version for autocomplete prompts (filled in the background
  // after attach). undefined = summarization pending; '' = failed/unneeded.
  summary?: string
}

let items: ExtraContext[] = []
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

export function getContextItems(): ExtraContext[] {
  return items
}

// Budgeted reference excerpts for autocomplete and weave prompts: prefer the
// instruct-model summary, fall back to a raw 1000-char head excerpt while
// summarization is pending or if it failed; skip items that no longer fit.
// Returns copies with content replaced by the excerpt.
export function budgetedRefs(budget: number): ExtraContext[] {
  const out: ExtraContext[] = []
  for (const r of items) {
    const text = r.summary || r.content.slice(0, 1000)
    if (text.length > budget) continue
    budget -= text.length
    out.push({ ...r, content: text })
  }
  return out
}

export function addContextItems(added: ExtraContext[]) {
  items = [...items, ...added]
  emit()
}

// Replace the whole list (used to restore a document's saved context).
export function setContextItems(next: ExtraContext[]) {
  items = [...next]
  emit()
}

export function removeContextItem(index: number) {
  items = items.filter((_, i) => i !== index)
  emit()
}

// Patch an item by identity (safe against index shifts from removals).
export function updateContextItem(target: ExtraContext, patch: Partial<ExtraContext>) {
  items = items.map((it) => (it === target ? { ...it, ...patch } : it))
  emit()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useContextItems(): ExtraContext[] {
  return useSyncExternalStore(subscribe, getContextItems)
}

// Fetch a URL and extract readable text (shared by chat + context panel).
// In Electron the request is routed through the main process so CORS does not
// apply; in a plain browser the remote server must allow cross-origin reads.
export async function fetchUrlContext(url: string): Promise<ExtraContext> {
  let text: string
  const bridge = getBridge()
  if (bridge) {
    const res = await bridge.request({ url, method: 'GET', headers: {} })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    text = res.body
  } else {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    text = await res.text()
  }
  const clean = text
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 20000)
  return { kind: 'url', name: url, content: clean }
}

// Route by extension: binary office formats are text-extracted (see
// extract.ts); everything else is read as plain text.
export async function fileToContext(f: File): Promise<ExtraContext> {
  const ext = f.name.toLowerCase().split('.').pop()
  if (ext === 'pdf' || ext === 'docx' || ext === 'odt') {
    const buf = await f.arrayBuffer()
    const { extractPdf, extractDocx, extractOdt } = await import('./extract')
    const content =
      ext === 'pdf' ? await extractPdf(buf)
      : ext === 'docx' ? await extractDocx(buf)
      : await extractOdt(buf)
    return { kind: 'file', name: f.name, content }
  }
  return { kind: 'file', name: f.name, content: await f.text() }
}
