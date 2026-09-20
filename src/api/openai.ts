// Generic client for any OpenAI-compatible endpoint
// (LM Studio, Ollama, llama.cpp, vLLM, Public AI, OpenAI, etc.)
//
// CORS never applies in either mode: in Electron, requests are routed through
// the main process (Node.js networking); in a plain browser they go through
// the app server's proxy endpoint (server.mjs, POST /api/proxy). Both return
// the same {ok,status,statusText,body} shape.

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

type ProxyResult = { ok: boolean; status: number; statusText: string; body: string }

async function request(cfg: EndpointConfig, path: string, body: object): Promise<string> {
  const args = {
    url: `${cfg.baseUrl.replace(/\/$/, '')}${path}`,
    method: 'POST' as const,
    headers: headers(cfg),
    body: JSON.stringify(body),
  }
  let res: ProxyResult
  const bridge = getBridge()
  if (bridge) {
    // Electron: CORS-free request via the main process
    res = await bridge.request(args)
  } else {
    // Browser: CORS-free request via the app server's proxy
    let resp: Response
    try {
      resp = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      })
    } catch {
      throw new TypeError('Cannot reach the app server — web mode needs `npm start` (serves the app and the /api/proxy endpoint).')
    }
    res = await resp.json() as ProxyResult
  }
  if (!res.ok) {
    if (res.status === 0) throw new TypeError(res.statusText)
    throw new Error(`${res.status} ${res.statusText}${res.body ? ` — ${res.body.slice(0, 200)}` : ''}`)
  }
  return res.body
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

export interface ChatOptions {
  temperature?: number
  maxTokens?: number
  // Stop sequences. When provided (even as an empty list), the built-in '---'
  // hard cut below is disabled — weave needs legitimate '---' horizontal rules
  // to survive generation.
  stop?: string[]
}

export async function chat(cfg: EndpointConfig, messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
  const data = JSON.parse(await request(cfg, '/chat/completions', {
    model: cfg.model,
    messages,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens ?? 1024,
    stop: options.stop ?? ['---'],
  }))
  let text: string = data.choices?.[0]?.message?.content ?? ''
  // Belt-and-suspenders: some servers ignore `stop`; cut anything from '---' on
  // (skipped when the caller supplies explicit stop sequences).
  if (options.stop === undefined) {
    const cut = text.indexOf('---')
    if (cut !== -1) text = text.slice(0, cut)
  }
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
      ? `Network error — ${err.message}`
      : String(err)
  }
}
