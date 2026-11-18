/**
 * The Host side of the browser companion: a loopback WebSocket server that one
 * Chrome extension dials, plus a request/response multiplexer over it.
 *
 * Everything here is deliberately boring. The server binds 127.0.0.1 only,
 * rejects non-extension origins, and proves possession of the shared pairing
 * token with a nonce/HMAC exchange, so a random page in the same browser cannot
 * impersonate the companion even though it can reach loopback.
 */
import { createServer } from 'node:http'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { upgradeToWebSocket } from './ws.js'

const PROTOCOL_VERSION = 2
const MIN_TOKEN_LENGTH = 16
const HELLO_TIMEOUT_MS = 10_000
const PING_INTERVAL_MS = 20_000

/**
 * Resolve `<DSH_HOME>/storages/browser-companion.json`, matching other DSH
 * plugins. `base` overrides the whole storages directory (used by tests).
 */
export function stateFile(base) {
  const directory = base ?? (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'storages') : join(homedir(), '.dsh', 'storages'))
  return join(directory, 'browser-companion.json')
}

function loadOrCreateToken(file, explicit) {
  if (explicit && explicit.length > 0) return explicit
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && typeof parsed.token === 'string' && parsed.token.length >= 16) return parsed.token
  } catch {
    // First run, or an unreadable state file: mint a fresh token below.
  }
  return randomBytes(24).toString('base64url')
}

function persistState(file, state) {
  try {
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
    chmodSync(file, 0o600)
  } catch (error) {
    console.warn('[browser-companion] cannot persist pairing state:', error?.message ?? String(error))
  }
}

/**
 * Challenge-response proof. The raw token never crosses the socket, so a
 * process that squats the configured port learns only an HMAC for a nonce it
 * chose — not the pairing secret.
 */
function proofFor(token, role, nonce) {
  return createHmac('sha256', token).update(`${role}:${nonce}`).digest('base64url')
}

function proofMatches(expected, given) {
  if (typeof given !== 'string') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(given)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function originAllowed(origin) {
  // Chrome sends this for extension pages. A missing origin is allowed for
  // local tooling; an http(s) origin is a web page and is refused.
  if (!origin) return true
  return origin.startsWith('chrome-extension://')
}

const PANEL_PRESENCE_TTL_MS = 30_000
const DEFAULT_MIME_TYPE = 'application/octet-stream'

/**
 * Keep model-supplied MIME types header-safe. `response.writeHead` throws on
 * CR/LF and non-Latin-1 bytes; a prompt-injected save must not crash the Host.
 */
function safeMimeType(value) {
  if (typeof value !== 'string') return DEFAULT_MIME_TYPE
  const text = value.trim()
  if (!text || text.length > 200 || /[^\x20-\x7e]/.test(text)) return DEFAULT_MIME_TYPE
  if (!/^[A-Za-z0-9!#$&'*+.^_`|~-]+\/[A-Za-z0-9!#$&'*+.^_`|~-]+(?:\s*;\s*[A-Za-z0-9!#$&'*+.^_`|~-]+=(?:[A-Za-z0-9!#$&'*+.^_`|~-]+|"[^"\\]{0,100}"))*$/.test(text)) {
    return DEFAULT_MIME_TYPE
  }
  return text
}

/**
 * @param {object} options
 * @param {number} [options.port]
 * @param {string} [options.host]
 * @param {string} [options.token]
 * @param {number} [options.commandTimeoutMs]
 * @param {number} [options.helloTimeoutMs] - Test override for the handshake timeout.
 * @param {boolean} [options.allowEvaluate] - Advertised to the extension so it
 *   can enforce the opt-in at its own boundary, not only in the Host tool.
 * @param {string} [options.pluginVersion] - Advertised so a stale Host process is
 *   detectable from the extension and from `/state`.
 * @param {string} [options.home] - Override for the state directory (tests).
 * @param {(line: string) => void} [options.log]
 */
export function createBridge(options = {}) {
  const host = options.host ?? '127.0.0.1'
  const preferredPort = Number.isFinite(options.port) ? Number(options.port) : 8787
  const commandTimeoutMs = Number.isFinite(options.commandTimeoutMs) ? Number(options.commandTimeoutMs) : 45_000
  const helloTimeoutMs = Number.isFinite(options.helloTimeoutMs) ? Number(options.helloTimeoutMs) : HELLO_TIMEOUT_MS
  const allowEvaluate = options.allowEvaluate === true
  const pluginVersion = typeof options.pluginVersion === 'string' ? options.pluginVersion : 'unknown'
  const log = options.log ?? ((line) => console.info(line))
  const file = stateFile(options.home)

  const token = loadOrCreateToken(file, options.token)
  const state = {
    state: 'stopped',
    error: null,
    port: preferredPort,
    connected: false,
    client: null,
    connectedAt: null,
    lastCommandAt: null,
    lastHelloAt: null,
    lastPongAt: null,
    panelOpen: false,
    lastPanelAt: 0,
    lastError: null
  }

  let server = null
  let peer = null
  let chatHandler = null
  let chatStatusGetter = null
  /** Files offered for download: id -> { data, filename, mimeType, expiresAt }. */
  const offeredFiles = new Map()
  const FILE_TTL_MS = 10 * 60 * 1000
  const MAX_OFFERED_FILES = 20
  const MAX_OFFERED_BYTES = 10 * 1024 * 1024
  let nextId = 0
  let pingTimer = null
  let offerSweepTimer = null
  const pending = new Map()

  function helloTimeout(candidate) {
    const timer = setTimeout(() => {
      // The timer is cleared on success, so this only fires while the peer is
      // still unauthenticated. (`peer !== candidate` was always true then, and
      // let silent sockets linger forever.)
      if (peer === candidate) return
      log('[browser-companion] extension handshake timed out')
      candidate.close(1008, 'handshake timeout')
    }, helloTimeoutMs)
    timer.unref?.()
    return timer
  }

  function handlePeer(candidate, request) {
    const timer = helloTimeout(candidate)
    const nonce = randomBytes(18).toString('base64url')
    let authenticated = false
    let ready = false
    let helloInfo = null

    // The server speaks first so the extension never reveals the token to an
    // impostor listening on the configured port.
    candidate.send({ type: 'challenge', nonce, protocolVersion: PROTOCOL_VERSION })

    candidate.onMessage = (text) => {
      let message
      try {
        message = JSON.parse(text)
      } catch {
        candidate.close(1002, 'invalid json')
        return
      }

      if (!authenticated) {
        const expected = proofFor(token, 'client', nonce)
        if (message?.type !== 'hello' || !proofMatches(expected, message.proof)) {
          log('[browser-companion] refused a connection that could not prove the pairing token')
          candidate.close(1008, 'unauthorized')
          return
        }
        authenticated = true
        helloInfo = {
          name: typeof message.name === 'string' ? message.name : 'unknown',
          version: typeof message.version === 'string' ? message.version : 'unknown',
          userAgent: typeof message.userAgent === 'string' ? message.userAgent : null
        }
        candidate.send({
          type: 'welcome',
          protocolVersion: PROTOCOL_VERSION,
          allowEvaluate,
          hostVersion: pluginVersion,
          proof: proofFor(token, 'server', nonce)
        })
        // Do not dispatch commands yet: the client still has to verify our
        // proof. It confirms with `ready`, and only then do we set `peer`.
        return
      }

      if (!ready) {
        if (message?.type !== 'ready') return
        ready = true
        clearTimeout(timer)
        if (peer && peer !== candidate) {
          failPending('The browser companion was replaced by a newer connection before answering.')
          peer.close(1000, 'replaced by a newer connection')
        }
        peer = candidate
        state.connected = true
        state.connectedAt = new Date().toISOString()
        state.client = helloInfo
        // A new connection must announce a live panel; do not carry the old
        // connection's presence across a reconnect.
        state.panelOpen = false
        state.lastPanelAt = 0
        state.state = 'listening'
        state.error = null
        state.lastHelloAt = new Date().toISOString()
        state.lastPongAt = Date.now()
        log(`[browser-companion] ${state.client.name} connected on port ${state.port}`)
        return
      }

      if (message?.type === 'panel/presence') {
        state.panelOpen = message.open === true
        state.lastPanelAt = Date.now()
        return
      }

      if (message?.type === 'ping') {
        candidate.send({ type: 'pong', at: Date.now() })
        return
      }
      if (typeof message?.type === 'string' && message.type.startsWith('chat/') && !message.type.startsWith('chat/approval/')) {
        if (!chatHandler) {
          candidate.send({ type: 'chat/error', message: 'Chat is not mounted in this profile.' })
          return
        }
        Promise.resolve(chatHandler(message))
          .then((snapshot) => candidate.send({ type: 'chat/state', ...snapshot }))
          .catch((error) => {
            let status
            try {
              status = chatStatusGetter?.()
            } catch {
              status = undefined
            }
            candidate.send({
              type: 'chat/error',
              message: String(error?.message ?? error),
              ...(typeof status === 'string' ? { status } : {})
            })
          })
        return
      }

      if (message?.type === 'pong') {
        state.lastPongAt = Date.now()
        return
      }

      if (typeof message?.id === 'string' || typeof message?.id === 'number') {
        const entry = pending.get(String(message.id))
        if (!entry) return
        pending.delete(String(message.id))
        clearTimeout(entry.timer)
        if (message.ok) entry.resolve(message.result)
        else entry.reject(new Error(describeRemoteError(message)))
        state.lastCommandAt = new Date().toISOString()
      }
    }

    candidate.onClose = () => {
      clearTimeout(timer)
      if (peer === candidate) {
        peer = null
        state.connected = false
        state.client = null
        state.connectedAt = null
        state.panelOpen = false
        state.lastPanelAt = 0
        failPending('The browser companion disconnected before answering.')
        log('[browser-companion] extension disconnected')
      }
    }

    candidate.onError = (error) => {
      if (!authenticated) log('[browser-companion] socket error before handshake:', error?.message ?? String(error))
    }
  }

  function describeRemoteError(message) {
    const error = message?.error
    const text = typeof error === 'string' ? error : error?.message
    return text && text.length > 0 ? text : 'The browser companion reported an error.'
  }

  function failPending(reason) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    pending.clear()
  }

  function listen(port) {
    return new Promise((resolve, reject) => {
      const candidate = createServer((request, response) => {
        response.on('error', () => {})
        try {
        if (request.method === 'GET' && request.url === '/health') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: true, connected: state.connected }))
          return
        }
        if (request.method === 'GET' && request.url === '/state') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ...status(), token: undefined }))
          return
        }
        const download = /^\/download\/([A-Za-z0-9_-]{16,})$/.exec(request.url ?? '')
        if (request.method === 'GET' && download) {
          const file = offeredFiles.get(download[1])
          if (!file || file.expiresAt < Date.now()) {
            offeredFiles.delete(download[1])
            response.writeHead(404, { 'content-type': 'text/plain' })
            response.end('file expired or unknown')
            return
          }
          const name = file.filename.replace(/["\\\r\n]/g, '_')
          response.writeHead(200, {
            'content-type': file.mimeType,
            'content-length': file.data.length,
            'content-disposition': `attachment; filename="${name}"`,
            'cache-control': 'no-store'
          })
          response.end(file.data)
          return
        }
        response.writeHead(404, { 'content-type': 'text/plain' })
        response.end('browser companion bridge')
        } catch (error) {
          log('[browser-companion] HTTP request failed:', error?.message ?? String(error))
          try {
            if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' })
            response.end('browser companion internal error')
          } catch {
            // The socket may already be gone.
          }
        }
      })

      candidate.on('upgrade', (request, socket, head) => {
        if (!originAllowed(request.headers.origin)) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        upgradeToWebSocket(request, socket, head, (newPeer) => handlePeer(newPeer, request))
      })

      // Deliberately no port fallback: silently shifting ports would leave a
      // squatter on the configured port able to relay the handshake to the real
      // bridge. A busy port is an actionable configuration error instead.
      candidate.once('error', reject)

      candidate.listen(port, host, () => {
        server = candidate
        state.port = candidate.address().port
        state.state = 'listening'
        state.error = null
        state.lastHelloAt = new Date().toISOString()
        state.lastPongAt = Date.now()
        resolve(state.port)
      })
    })
  }

  async function start() {
    if (typeof options.token === 'string' && options.token.length > 0 && options.token.length < MIN_TOKEN_LENGTH) {
      state.state = 'error'
      state.error = `The configured pairing token must be at least ${MIN_TOKEN_LENGTH} characters.`
      console.warn(`[browser-companion] ${state.error}`)
      return
    }
    try {
      const actualPort = await listen(preferredPort)
      persistState(file, { token, port: actualPort, updatedAt: new Date().toISOString() })
      log(`[browser-companion] bridge listening on ws://${host}:${actualPort}`)
      pingTimer = setInterval(() => {
        if (!peer || peer.closed) return
        // A socket can stay ESTABLISHED after the other side stops executing
        // (a suspended service worker keeps the TCP connection). Silence is the
        // only reliable death signal, so a missing pong retires the peer.
        if (state.lastPongAt && Date.now() - state.lastPongAt > PING_INTERVAL_MS * 2 + 15_000) {
          log('[browser-companion] extension stopped answering; dropping the stale socket')
          state.lastError = 'The extension stopped answering; the bridge dropped a stale connection.'
          try {
            peer.close(1001, 'stale connection')
          } catch {
            // Already gone.
          }
          return
        }
        peer.send({ type: 'ping', at: Date.now() })
      }, PING_INTERVAL_MS)
      pingTimer.unref?.()
      offerSweepTimer = setInterval(() => {
        const now = Date.now()
        for (const [id, file] of offeredFiles) {
          if (file.expiresAt < now) offeredFiles.delete(id)
        }
      }, 60_000)
      offerSweepTimer.unref?.()
    } catch (error) {
      state.state = 'error'
      state.error = error?.code === 'EADDRINUSE'
        ? `Port ${preferredPort} is already in use. Change \`port\` in the browser-companion config and in the extension popup.`
        : String(error?.message ?? error)
      console.warn('[browser-companion] bridge failed to start:', state.error)
    }
  }

  function stop() {
    if (pingTimer) clearInterval(pingTimer)
    pingTimer = null
    if (offerSweepTimer) clearInterval(offerSweepTimer)
    offerSweepTimer = null
    offeredFiles.clear()
    failPending('The browser companion bridge stopped.')
    if (peer) {
      try {
        peer.close(1001, 'bridge stopping')
      } catch {
        // Ignore teardown races.
      }
      peer = null
    }
    state.connected = false
    state.client = null
    state.panelOpen = false
    state.lastPanelAt = 0
    if (server) {
      try {
        server.close()
      } catch {
        // Ignore teardown races.
      }
      server = null
    }
    state.state = 'stopped'
  }

  /**
   * Send one command to the extension and await its result.
   * @param {string} method
   * @param {object} [params]
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
   */
  async function call(method, params = {}, options = {}) {
    if (!peer || peer.closed) {
      throw new Error(
        'The Chrome companion is not connected. Open Chrome, click the "DSH Browser Extension" extension icon, ' +
        `and pair it with port ${state.port} and the token from browser_status.`
      )
    }
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : commandTimeoutMs
    const id = String(++nextId)
    const payload = JSON.stringify({ id, method, params })

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`The browser did not answer "${method}" within ${Math.round(timeoutMs / 1000)}s.`))
      }, timeoutMs)
      timer.unref?.()

      const onAbort = () => {
        pending.delete(id)
        clearTimeout(timer)
        reject(new Error('The call was cancelled.'))
      }
      if (options.signal) {
        if (options.signal.aborted) {
          clearTimeout(timer)
          reject(new Error('The call was cancelled.'))
          return
        }
        options.signal.addEventListener('abort', onAbort, { once: true })
      }

      pending.set(id, {
        resolve: (value) => {
          options.signal?.removeEventListener('abort', onAbort)
          state.lastCommandAt = new Date().toISOString()
          resolve(value)
        },
        reject: (error) => {
          options.signal?.removeEventListener('abort', onAbort)
          state.lastError = error.message
          reject(error)
        },
        timer
      })
      try {
        peer.sendText(payload)
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(new Error(`Cannot reach the browser: ${error?.message ?? String(error)}`))
      }
    })
  }

  function status() {
    return {
      bridge: state.state,
      error: state.error,
      connected: state.connected,
      port: state.port,
      protocolVersion: PROTOCOL_VERSION,
      pluginVersion,
      token,
      client: state.client,
      connectedAt: state.connectedAt,
      lastCommandAt: state.lastCommandAt,
      lastHelloAt: state.lastHelloAt,
      lastPongAt: state.lastPongAt ? new Date(state.lastPongAt).toISOString() : null,
      panelOpen: state.connected && state.panelOpen && Date.now() - state.lastPanelAt < PANEL_PRESENCE_TTL_MS,
      lastError: state.lastError
    }
  }

  /**
   * Hold bytes for a short-lived download and return a loopback URL the
   * extension can hand to Chrome. The id is unguessable and expires after ten
   * minutes, so the URL is not an open file server.
   */
  function offerFile({ filename, mimeType, data }) {
    if (!Buffer.isBuffer(data) || data.length === 0) throw new Error('A file needs content.')
    if (data.length > MAX_OFFERED_BYTES) throw new Error('Files are limited to 10 MB.')
    const now = Date.now()
    for (const [id, file] of offeredFiles) if (file.expiresAt < now) offeredFiles.delete(id)
    while (offeredFiles.size >= MAX_OFFERED_FILES) offeredFiles.delete(offeredFiles.keys().next().value)
    const id = randomBytes(18).toString('base64url')
    const safe = String(filename || 'file').replace(/[^\w.\-() ]+/g, '_').slice(0, 120) || 'file'
    offeredFiles.set(id, {
      data,
      filename: safe,
      mimeType: safeMimeType(mimeType),
      expiresAt: now + FILE_TTL_MS
    })
    return { id, filename: safe, url: `http://${host}:${state.port}/download/${id}`, bytes: data.length }
  }

  /** Push one message to the connected extension, if any. */
  function broadcast(message) {
    if (peer && !peer.closed) peer.send(message)
  }

  /**
   * Install the chat request handler; it resolves to a chat snapshot. The
   * optional status getter lets error frames carry the authoritative status.
   */
  function setChatHandler(handler, getStatus) {
    chatHandler = handler
    chatStatusGetter = typeof getStatus === 'function' ? getStatus : null
  }

  return {
    start,
    stop,
    call,
    status,
    broadcast,
    setChatHandler,
    offerFile,
    token,
    get port() {
      return state.port
    }
  }
}
