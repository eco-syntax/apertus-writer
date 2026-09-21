// Web-mode server: serves the built app (dist/) and proxies AI API requests
// so CORS never applies — the browser equivalent of the Electron main-process
// proxy (electron/main.cjs 'ai-request'). Same {ok,status,statusText,body}
// response shape, so the client code path is shared.
//
// Run: npm run build && npm start   (PORT env var overrides, default 8787)
// Managed mode env vars: APERTUS_BASE_URL (shared default) or per-feature
// APERTUS_AUTOCOMPLETE_BASE_URL / APERTUS_CHAT_BASE_URL, models, and optional
// per-feature API keys — see below.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import dns from 'node:dns/promises'
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.PORT) || 8787
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist')

// --- SSRF guard -------------------------------------------------------------
// The proxy is reachable by anyone who can reach the server, so targets are
// restricted to public http(s) hosts: no localhost/loopback, private or
// link-local ranges (cloud metadata service), and non-http schemes. Users'
// endpoints are cloud APIs (LM Studio/Ollama are local-only by nature and
// unreachable from a hosted browser anyway).
// ponytail: DNS rebinding / TOCTOU between resolve and fetch remains; a full
// fix needs an endpoint allowlist, which is a product call.
function isPrivateIp(ip) {
  if (ip.includes('.')) {
    const [a, b] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  const v6 = ip.replace(/^\[|\]$/g, '').toLowerCase()
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)
}

async function assertSafeTarget(rawUrl) {
  let parsed
  try { parsed = new URL(rawUrl) } catch { throw new Error('Invalid URL') }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Blocked scheme')
  if (isPrivateIp(parsed.hostname)) throw new Error('Blocked host')
  try {
    const addrs = await dns.lookup(parsed.hostname, { all: true })
    if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('Blocked host')
  } catch (e) {
    // Only our explicit block rejects here; lookup failures surface via fetch.
    if (String(e).endsWith('Blocked host')) throw e
  }
}

// --- helpers ----------------------------------------------------------------
function reply(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type })
  res.end(body)
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('Payload too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.txt': 'text/plain', '.map': 'application/json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.md': 'text/markdown',
}

// --- Server-hosted file storage (web mode, optional) ------------------------
// Admin controls the option: when APERTUS_STORAGE_DIR points at a folder, web
// users can save/load .md documents there (server-side, not forced downloads);
// when it is unset, the default download-based save/load remains. The env var
// also controls whether the client even shows the server-storage UI. Only the
// basename is used and it is resolved strictly inside STORAGE_DIR so a caller
// can never read or write outside the designated folder.
let STORAGE_DIR = null
if (process.env.APERTUS_STORAGE_DIR) {
  STORAGE_DIR = path.resolve(process.env.APERTUS_STORAGE_DIR)
  try { mkdirSync(STORAGE_DIR, { recursive: true }) } catch { STORAGE_DIR = null }
  if (STORAGE_DIR) console.log(`Server file storage enabled → ${STORAGE_DIR}`)
}

// Resolve a user-supplied file name to a path strictly inside STORAGE_DIR.
function storagePath(name) {
  const base = path.basename(String(name ?? ''))
  if (!base || base === '.' || base === '..') throw new Error('Invalid file name')
  const abs = path.join(STORAGE_DIR, base)
  if (abs !== STORAGE_DIR && !abs.startsWith(STORAGE_DIR + path.sep)) throw new Error('Invalid file path')
  return abs
}

function serveStatic(res, pathname) {
  let file = path.normalize(path.join(DIST, pathname))
  if (!file.startsWith(DIST)) return reply(res, 403, 'Forbidden', 'text/plain')
  if (pathname === '/' || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(DIST, 'index.html') // single-page app: no client routing
  }
  try {
    const data = fs.readFileSync(file)
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(data)
  } catch {
    reply(res, 404, 'Not found — run `npm run build` first', 'text/plain')
  }
}

// --- Managed mode (optional) ------------------------------------------------
// Set endpoints here and the server injects them (and the API keys) for all
// web users — visitors get a working app with zero setup, keys stay
// server-side. Autocomplete: APERTUS_AUTOCOMPLETE_BASE_URL/_API_KEY/_MODEL,
// falling back to APERTUS_BASE_URL/_API_KEY. Chat: APERTUS_CHAT_BASE_URL/
// _API_KEY/_MODEL, falling back to the PUBLICAI_BASE/_MODEL/_API_KEY vars,
// then the shared APERTUS ones. Unset = BYOK mode: users configure their own
// endpoint in Settings and it is forwarded as-is (https-only, public hosts).
// ponytail: no auth on the proxy — anyone with the URL spends the host's key.
// Add a shared-password env check here if that ever matters.
// --- server file-storage API ------------------------------------------------
function handleStorage(req, res, url) {
  if (!STORAGE_DIR) return reply(res, 404, JSON.stringify({ ok: false, error: 'Server storage not enabled' }))
  const origin = req.headers.origin
  if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
    return reply(res, 403, JSON.stringify({ ok: false, error: 'Blocked origin' }))
  }
  if (req.method === 'GET' && url.pathname === '/api/storage/list') {
    const files = readdirSync(STORAGE_DIR).filter((f) => {
      try { return statSync(path.join(STORAGE_DIR, f)).isFile() } catch { return false }
    })
    return reply(res, 200, JSON.stringify({ ok: true, files }))
  }
  if (req.method !== 'POST') return reply(res, 405, JSON.stringify({ ok: false, error: 'Method not allowed' }))
  return readBody(req).then((raw) => {
    let body
    try { body = JSON.parse(raw) } catch { return reply(res, 400, JSON.stringify({ ok: false, error: 'Bad JSON' })) }
    if (url.pathname === '/api/storage/read') {
      const abs = storagePath(body.name)
      if (!existsSync(abs)) return reply(res, 404, JSON.stringify({ ok: false, error: 'Not found' }))
      return reply(res, 200, JSON.stringify({ ok: true, content: readFileSync(abs, 'utf8') }))
    }
    if (url.pathname === '/api/storage/write') {
      const abs = storagePath(body.name)
      writeFileSync(abs, String(body.content ?? ''))
      return reply(res, 200, JSON.stringify({ ok: true }))
    }
    return reply(res, 404, JSON.stringify({ ok: false, error: 'Not found' }))
  }).catch((e) => reply(res, 400, JSON.stringify({ ok: false, error: String(e?.message ?? e) })))
}

const stripSlash = (u) => (u || '').replace(/\/$/, '')
const env = (name, fallback = '') => process.env[name] ?? fallback
const MANAGED = (env('APERTUS_BASE_URL') || env('APERTUS_AUTOCOMPLETE_BASE_URL') || env('APERTUS_CHAT_BASE_URL') || env('PUBLICAI_BASE'))
  ? {
      autocomplete: {
        baseUrl: stripSlash(env('APERTUS_AUTOCOMPLETE_BASE_URL') || env('APERTUS_BASE_URL')),
        key: env('APERTUS_AUTOCOMPLETE_API_KEY', env('APERTUS_API_KEY')),
        model: env('APERTUS_AUTOCOMPLETE_MODEL'),
      },
      chat: {
        baseUrl: stripSlash(env('APERTUS_CHAT_BASE_URL') || env('PUBLICAI_BASE') || env('APERTUS_BASE_URL')),
        key: env('APERTUS_CHAT_API_KEY', env('PUBLICAI_API_KEY', env('APERTUS_API_KEY'))),
        model: env('APERTUS_CHAT_MODEL') || env('PUBLICAI_MODEL') || env('APERTUS_AUTOCOMPLETE_MODEL'),
      },
    }
  : null
if (MANAGED && (!MANAGED.autocomplete.model || !MANAGED.autocomplete.baseUrl || !MANAGED.chat.model || !MANAGED.chat.baseUrl)) {
  console.warn('Managed mode incomplete — set APERTUS_AUTOCOMPLETE_MODEL + APERTUS_BASE_URL (autocomplete) and PUBLICAI_BASE/PUBLICAI_MODEL (chat) so both features are usable.')
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    if (req.method === 'GET' && url.pathname === '/api/config') {
      const storageEnabled = !!STORAGE_DIR
      // Model names only — the base URL and key stay server-side. Storage info
      // leaf reveals whether server-hosted save/load is on (admin-controlled
      // via APERTUS_STORAGE_DIR); folder name is presentational only.
      return reply(res, 200, JSON.stringify({
        managed: !!MANAGED,
        autocomplete: MANAGED?.autocomplete.model ?? null,
        chat: MANAGED?.chat.model ?? null,
        storage: { enabled: storageEnabled, folder: storageEnabled ? path.basename(STORAGE_DIR) : null },
      }))
    }
    if (url.pathname.startsWith('/api/storage')) {
      return handleStorage(req, res, url)
    }
    if (req.method === 'POST' && url.pathname === '/api/proxy') {
      // Only the app's own pages may use the proxy (blocks other sites from
      // relaying requests through it; same-origin fetches omit Origin).
      const origin = req.headers.origin
      if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
        return reply(res, 403, JSON.stringify({ ok: false, status: 0, statusText: 'Blocked origin', body: '' }))
      }
      const args = JSON.parse(await readBody(req))
      let url = args.url
      let upstreamHeaders = args.headers
      // Managed relative path: target is host-configured (may legitimately be
      // a local LM Studio), so the SSRF guard applies only to user-supplied
      // absolute URLs (BYOK mode).
      const userSuppliedUrl = !(MANAGED && typeof url === 'string' && url.startsWith('/'))
      if (!userSuppliedUrl) {
        // /completions is the base-model (autocomplete) endpoint; everything
        // else (/chat/completions, incl. weave and chat) uses the chat upstream.
        const feature = url === '/completions' ? MANAGED.autocomplete : MANAGED.chat
        url = feature.baseUrl + url
        upstreamHeaders = { ...upstreamHeaders }
        delete upstreamHeaders.Authorization
        if (feature.key) upstreamHeaders.Authorization = `Bearer ${feature.key}`
      }
      try {
        if (userSuppliedUrl) await assertSafeTarget(url)
        const upstream = await fetch(url, {
          method: 'POST',
          headers: upstreamHeaders,
          body: args.body,
        })
        return reply(res, 200, JSON.stringify({
          ok: upstream.ok,
          status: upstream.status,
          statusText: upstream.statusText,
          body: await upstream.text(),
        }))
      } catch (err) {
        return reply(res, 200, JSON.stringify({ ok: false, status: 0, statusText: String(err?.message ?? err), body: '' }))
      }
    }
    serveStatic(res, url.pathname)
  } catch (err) {
    reply(res, 500, JSON.stringify({ ok: false, status: 0, statusText: String(err), body: '' }))
  }
})

server.listen(PORT, () => console.log(`Apertus Writer web mode → http://localhost:${PORT}`))

// Self-check for the SSRF guard logic: node server.mjs --check
if (process.argv[2] === '--check') {
  const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1) } }
  assert(isPrivateIp('127.0.0.1'), 'loopback blocked')
  assert(isPrivateIp('10.0.0.1'), '10/8 blocked')
  assert(isPrivateIp('172.16.0.1'), '172.16/12 blocked')
  assert(isPrivateIp('172.31.255.255'), '172.31 blocked')
  assert(isPrivateIp('192.168.1.1'), '192.168 blocked')
  assert(isPrivateIp('169.254.169.254'), 'metadata blocked')
  assert(isPrivateIp('::1'), 'v6 loopback blocked')
  assert(isPrivateIp('fe80::1'), 'v6 link-local blocked')
  assert(isPrivateIp('fd00::1'), 'v6 unique-local blocked')
  assert(!isPrivateIp('8.8.8.8'), 'public v4 allowed')
  assert(!isPrivateIp('172.32.0.1'), '172.32 is public')
  assert(!isPrivateIp('2606:4700::1'), 'public v6 allowed')
  console.log('SSRF guard self-check passed')
  process.exit(0)
}
