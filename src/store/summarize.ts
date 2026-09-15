// One-shot background compression of attached reference documents via the
// configured instruct/chat model. Autocomplete prompts have a tight context
// budget, so long references are replaced by dense summaries; chat keeps
// using the full text.
import { chat, type EndpointConfig } from '../api/openai'
import {
  addContextItems, fetchUrlContext, fileToContext, updateContextItem,
  type ExtraContext,
} from './context'

// Documents at or below this size are used verbatim — summarizing them would
// only lose information.
const SUMMARIZE_THRESHOLD = 1500

const SUMMARY_TARGET_CHARS = 1200
// Cap the input so the summarization request itself fits the context window.
const SUMMARY_INPUT_CAP = 12000

export async function summarizeForAutocomplete(
  cfg: EndpointConfig,
  name: string,
  text: string,
): Promise<string> {
  const result = await chat(cfg, [
    {
      role: 'system',
      content:
        'You compress documents into dense reference summaries for a text-autocomplete model. ' +
        'Preserve key facts, terminology, names, and the tone and style of the writing. ' +
        'Output only the compressed text — no preamble, headings, or commentary.',
    },
    {
      role: 'user',
      content:
        `Compress the following document ("${name}") to at most ${SUMMARY_TARGET_CHARS} characters:\n\n` +
        text.slice(0, SUMMARY_INPUT_CAP),
    },
  ], 512)
  return result.slice(0, SUMMARY_TARGET_CHARS)
}

// Read, attach, and summarize newly-picked files (shared by chat sidebar and
// the context panel).
export async function attachFiles(files: FileList | null, cfg: EndpointConfig) {
  if (!files) return
  const results = await Promise.allSettled(Array.from(files).map(fileToContext))
  const added = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
  addContextItems(added)
  summarizeInBackground(added, cfg)
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed.length > 0) alert(`Could not read ${failed.length} file(s):\n${failed.map((f) => String(f.reason)).join('\n')}`)
}

export async function attachUrl(url: string, cfg: EndpointConfig) {
  try {
    const item = await fetchUrlContext(url)
    addContextItems([item])
    summarizeInBackground([item], cfg)
  } catch (err) {
    alert(`Could not fetch ${url}: ${err}`)
  }
}

// Fire-and-forget: summarize each long item and patch it into the context
// store when done. Small items are skipped; failures mark summary as '' so
// autocomplete falls back to a truncated raw excerpt instead of retrying.
export function summarizeInBackground(items: ExtraContext[], cfg: EndpointConfig) {
  for (const item of items) {
    if (item.content.length <= SUMMARIZE_THRESHOLD) {
      updateContextItem(item, { summary: '' })
      continue
    }
    summarizeForAutocomplete(cfg, item.name, item.content)
      .then((s) => updateContextItem(item, { summary: s }))
      .catch(() => updateContextItem(item, { summary: '' }))
  }
}
