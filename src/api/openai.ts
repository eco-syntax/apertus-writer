// Generic client for any OpenAI-compatible endpoint
// (LM Studio, Ollama, llama.cpp, vLLM, Public AI, OpenAI, etc.)
//
// When running inside Electron, requests are routed through the main process
// (Node.js networking) so CORS never applies. In a plain browser, requests
// go through fetch() directly and the endpoint must allow cross-origin
// requests (LM Studio: enable CORS in server settings; Ollama: OLLAMA_ORIGINS).

// Bridge exposed by electron/preload.cjs (typed in store/bridge.ts)
import { getBridge } from '../store/bridge'

export interface EndpointConfig {
  baseUrl: string // e.g. http://localhost:1234/v1 or https://api.publicai.co/v1
  apiKey: string  // may be empty for local servers
  model: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

function headers(cfg: EndpointConfig): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) h['Authorization'] = `Bearer ${cfg.apiKey}`
  return h
}

async function request(cfg: EndpointConfig, path: string, body: object): Promise<string> {
  const url = `${cfg.baseUrl.replace(/\/$/, '')}${path}`
  const bridge = getBridge()
  if (bridge) {
    // Electron: CORS-free request via the main process
    const res = await bridge.request({
      url,
      method: 'POST',
      headers: headers(cfg),
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      if (res.status === 0) throw new TypeError(res.statusText)
      throw new Error(`${res.status} ${res.statusText}${res.body ? ` — ${res.body.slice(0, 200)}` : ''}`)
    }
    return res.body
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`)
  }
  return res.text()
}

// Autocomplete uses the raw completions endpoint (not chat completions):
// the document text before the cursor is sent verbatim as the prompt, with
// no system prompt or chat template — appropriate for base models.
export async function autocomplete(
  cfg: EndpointConfig,
  context: string,
): Promise<string> {
  const data = JSON.parse(await request(cfg, '/completions', {
    model: cfg.model,
    prompt: context,
    max_tokens: 48,
    temperature: 0.3,
    stop: ['\n\n', '</s>'],
  }))
  const text: string = data.choices?.[0]?.text ?? ''
  return text.replace(/\s+$/, '')
}

export async function chat(cfg: EndpointConfig, messages: ChatMessage[], maxTokens = 1024): Promise<string> {
  const data = JSON.parse(await request(cfg, '/chat/completions', {
    model: cfg.model,
    messages,
    temperature: 0.7,
    max_tokens: maxTokens,
    stop: ['---'],
  }))
  let text: string = data.choices?.[0]?.message?.content ?? ''
  // Belt-and-suspenders: some servers ignore `stop`; cut anything from '---' on
  const cut = text.indexOf('---')
  if (cut !== -1) text = text.slice(0, cut)
  return text.trimEnd()
}

// Quick connectivity check — returns null on success, error message on failure.
// kind selects which API style to probe ('completions' for base models,
// 'chat' for instruct/chat models).
export async function testConnection(cfg: EndpointConfig, kind: 'completions' | 'chat' = 'chat'): Promise<string | null> {
  try {
    if (kind === 'completions') {
      await request(cfg, '/completions', {
        model: cfg.model,
        prompt: 'The capital of France is',
        max_tokens: 5,
      })
    } else {
      await request(cfg, '/chat/completions', {
        model: cfg.model,
        messages: [{ role: 'user', content: 'Say "ok".' }],
        max_tokens: 5,
      })
    }
    return null
  } catch (err) {
    return err instanceof TypeError
      ? 'Network error — is the server running and reachable? (In a plain browser, the endpoint must also allow CORS; the Electron app has no such restriction.)'
      : String(err)
  }
}
