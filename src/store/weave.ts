// Weave: expand AI placeholder blocks into real content. Collects the
// placeholders in the document, builds a prompt for each from its description
// plus surrounding text, and generates two candidate replacements via the
// configured chat (instruct) endpoint — fired in parallel at different
// temperatures so the two candidates genuinely differ.
import type { Editor } from '@tiptap/react'
import { chat, type ChatMessage, type EndpointConfig } from '../api/openai'
import { budgetedRefs } from './context'

export interface PlaceholderHit {
  pos: number // position of the placeholder node in the doc
  description: string
}

// Collect every aiPlaceholder node, in document order. Callers re-scan after
// each replacement rather than caching positions — replacing one placeholder
// shifts the positions of all later ones, but re-scanning keeps indices stable
// as long as inserted content contains no placeholders of its own (candidates
// are filtered for the [[ai: …]] marker in cleanCandidate).
export function collectPlaceholders(editor: Editor): PlaceholderHit[] {
  const hits: PlaceholderHit[] = []
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'aiPlaceholder') {
      hits.push({ pos, description: String(node.attrs.description || '') })
    }
    return true
  })
  return hits
}

// Reference documents share fetchSuggestion's budget so the request fits the
// same context windows: summaries (or 1000-char head excerpts), 6k total.
const REF_BUDGET = 6000

// Prompt: the description is the instruction; surrounding document text gives
// the model voice/tense context, and budgeted reference excerpts (same rule
// as autocomplete) inform the section. Budgets mirror fetchSuggestion
// (~1.5k chars before) so the request fits typical LM Studio context windows.
export function buildMessages(hit: PlaceholderHit, editor: Editor): ChatMessage[] {
  const doc = editor.state.doc
  const before = doc.textBetween(Math.max(0, hit.pos - 1500), hit.pos, '\n\n', ' ')
  const node = doc.nodeAt(hit.pos)
  const afterFrom = hit.pos + (node?.nodeSize ?? 1)
  const after = doc.textBetween(afterFrom, Math.min(doc.content.size, afterFrom + 800), '\n\n', ' ')

  const description = hit.description.trim() || 'Continue the document appropriately here.'
  const system =
    'You are writing one section of a larger markdown document. ' +
    'Write only the content for the described section: return markdown, with no commentary, ' +
    'no explanations, and no wrapping code fences. ' +
    'Match the style, tone, and tense of the surrounding document text.'

  const parts: string[] = []
  if (before.trim()) parts.push(`<document_before>\n${before}\n</document_before>`)
  parts.push(`<section_description>\n${description}\n</section_description>`)
  if (after.trim()) parts.push(`<document_after>\n${after}\n</document_after>`)
  const refs = budgetedRefs(REF_BUDGET)
  if (refs.length > 0) {
    const blocks = refs.map(
      (r) => `<reference_document name="${r.name}" kind="${r.kind}">\n${r.content}\n</reference_document>`,
    )
    parts.push(`<reference_documents>\n${blocks.join('\n')}\n</reference_documents>`)
  }
  parts.push('Write the markdown for <section_description> now. Return only the markdown.')

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') },
  ]
}

// Strip a wrapping code fence and stray placeholder markers from a candidate.
export function cleanCandidate(text: string): string {
  let t = text.trim()
  const fenced = t.match(/^```[^\n]*\n([\s\S]*?)\n?```\s*$/)
  if (fenced) t = fenced[1].trim()
  // A model that echoed the placeholder marker would otherwise be woven back
  // in as a new placeholder, silently corrupting later weave runs.
  t = t.replace(/^\[\[ai:[^\]]*\]\]\s*/i, '').replace(/\s*\[\[ai:[^\]]*\]\]\s*$/i, '')
  return t.trim()
}

// Two candidates per block at different temperatures so they genuinely differ.
// Sequential (not parallel): firing both heavy requests at once spikes load on
// slow gateways and trips their timeout — the cause of the 504s this replaced.
// Each completes within the gateway's window instead. Resolves to 1 or 2
// non-empty candidates; both empty → resolves [''] (caller treats a single
// empty string as a generation failure).
export async function generateCandidates(cfg: EndpointConfig, messages: ChatMessage[]): Promise<string[]> {
  const a = await chat(cfg, messages, { temperature: 0.7, maxTokens: 400, stop: [] })
  const b = await chat(cfg, messages, { temperature: 1.0, maxTokens: 400, stop: [] })
  return [cleanCandidate(a), cleanCandidate(b)]
}
