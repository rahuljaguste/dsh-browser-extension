/**
 * The Host side of the browser companion: a loopback WebSocket server that one
 * Chrome extension dials, plus a request/response multiplexer over it.
 *
 * Everything here is deliberately boring. The server binds 127.0.0.1 only,
 * rejects non-extension origins, and requires a shared token as the first
 * message, so a random page in the same browser cannot impersonate the
 * companion even though it can reach loopback.
 */
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { upgradeToWebSocket } from './ws.js'

const PROTOCOL_VERSION = 1
const HELLO_TIMEOUT_MS = 10_000
const PING_INTERVAL_MS = 20_000
const MAX_PORT_ATTEMPTS = 10

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

function tokenMatches(expected, given) {
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

/**
 * @param {object} options
 * @param {number} [options.port]
 * @param {string} [options.host]
 * @param {string} [options.token]
 * @param {number} [options.commandTimeoutMs]
 * @param {string} [options.home] - Override for the state directory (tests).
 * @param {(line: string) => void} [options.log]
 */
export function createBridge(options = {}) {
  const host = options.host ?? '127.0.0.1'
  const preferredPort = Number.isFinite(options.port) ? Number(options.port) : 8787
  const commandTimeoutMs = Number.isFinite(options.commandTimeoutMs) ? Number(options.commandTimeoutMs) : 45_000
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
    lastError: null
  }

  let server = null
  let peer = null
  let chatHandler = null
  let nextId = 0
  let pingTimer = null
  const pending = new Map()

  function helloTimeout(candidate) {
    const timer = setTimeout(() => {
      if (peer !== candidate) return
      log('[browser-companion] extension handshake timed out')
      candidate.close(1008, 'handshake timeout')
    }, HELLO_TIMEOUT_MS)
    timer.unref?.()
    return timer
  }

  function handlePeer(candidate, request) {
    const timer = helloTimeout(candidate)
    let authenticated = false

    candidate.onMessage = (text) => {
      let message
      try {
        message = JSON.parse(text)
      } catch {
        candidate.close(1002, 'invalid json')
        return
      }

      if (!authenticated) {
        if (message?.type !== 'hello' || !tokenMatches(token, message.token)) {
          log('[browser-companion] refused a connection with a bad pairing token')
          candidate.close(1008, 'unauthorized')
          return
        }
        authenticated = true
        clearTimeout(timer)
        if (peer && peer !== candidate) peer.close(1000, 'replaced by a newer connection')
        peer = candidate
        state.connected = true
        state.connectedAt = new Date().toISOString()
        state.client = {
          name: typeof message.name === 'string' ? message.name : 'unknown',
          version: typeof message.version === 'string' ? message.version : 'unknown',
          userAgent: typeof message.userAgent === 'string' ? message.userAgent : null
        }
        state.state = 'listening'
        state.error = null
        state.lastHelloAt = new Date().toISOString()
        state.lastPongAt = Date.now()
        candidate.send({ type: 'welcome', protocolVersion: PROTOCOL_VERSION })
        log(`[browser-companion] ${state.client.name} connected on port ${state.port}`)
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
          .catch((error) => candidate.send({ type: 'chat/error', message: String(error?.message ?? error) }))
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

  function listen(port, attempt = 0) {
    return new Promise((resolve, reject) => {
      const candidate = createServer((request, response) => {
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
        response.writeHead(404, { 'content-type': 'text/plain' })
        response.end('browser companion bridge')
      })

      candidate.on('upgrade', (request, socket, head) => {
        if (!originAllowed(request.headers.origin)) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        upgradeToWebSocket(request, socket, head, (newPeer) => handlePeer(newPeer, request))
      })

      candidate.once('error', (error) => {
        if (error?.code === 'EADDRINUSE' && attempt < MAX_PORT_ATTEMPTS) {
          listen(port + 1, attempt + 1).then(resolve, reject)
          return
        }
        reject(error)
      })

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
    try {
      const actualPort = await listen(preferredPort)
      persistState(file, { token, port: actualPort, updatedAt: new Date().toISOString() })
      log(`[browser-companion] bridge listening on ws://${host}:${actualPort}`)
      if (actualPort !== preferredPort) {
        log(`[browser-companion] port ${preferredPort} was busy; using ${actualPort}. Set the same port in the extension popup.`)
      }
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
        'The Chrome companion is not connected. Open Chrome, click the "DSH Browser Companion" extension icon, ' +
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
      token,
      client: state.client,
      connectedAt: state.connectedAt,
      lastCommandAt: state.lastCommandAt,
      lastHelloAt: state.lastHelloAt,
      lastPongAt: state.lastPongAt ? new Date(state.lastPongAt).toISOString() : null,
      lastError: state.lastError
    }
  }

  /** Push one message to the connected extension, if any. */
  function broadcast(message) {
    if (peer && !peer.closed) peer.send(message)
  }

  /** Install the chat request handler; it resolves to a chat snapshot. */
  function setChatHandler(handler) {
    chatHandler = handler
  }

  return { start, stop, call, status, broadcast, setChatHandler, token, get port() { return state.port } }
}
