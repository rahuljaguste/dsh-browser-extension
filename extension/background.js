/**
 * Service worker: owns the WebSocket to the DSH bridge and executes commands
 * against Chrome's tabs.
 *
 * MV3 service workers are suspended when idle; an open WebSocket plus the
 * app-level ping every 20s keeps this one alive while the bridge is connected
 * (Chrome 116+). A failed connection retries with capped backoff.
 */

const VERSION = chrome.runtime.getManifest().version
const PROTOCOL_VERSION = 2
const DEFAULT_PORT = 8787
const KEEPALIVE_MS = 20_000
const HANDSHAKE_TIMEOUT_MS = 8_000
const STALE_AFTER_MS = 60_000
const RECONNECT_ALARM = 'dsh-reconnect'
const MAX_ATTACHMENTS = 6
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024
const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024
const MAX_MESSAGE_CHARS = 32_000

let settings = { token: '', port: DEFAULT_PORT }
let socket = null
let connected = false
let retry = 0
let attempts = 0
let reconnectTimer = null
let keepaliveTimer = null
let welcomeTimer = null
let lastError = null
let lastClose = null
let lastConnectedAt = null
let lastCommandAt = null
let lastMessageAt = 0
let activity = []
let activityLoaded = false
let chatEntries = []
let chatStatus = 'idle'
let chatSessionId = null
let pendingApprovals = []
let lastScreenshot = null
let allowEvaluate = false

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const textEncoder = new TextEncoder()

function toBase64Url(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** HMAC-SHA-256(token, "<role>:<nonce>"); the token itself never leaves Chrome. */
async function proofFor(token, role, nonce) {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(`${role}:${nonce}`))
  return toBase64Url(new Uint8Array(signature))
}

function proofMatches(expected, given) {
  if (typeof given !== 'string' || expected.length !== given.length) return false
  let diff = 0
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ given.charCodeAt(index)
  }
  return diff === 0
}

/* ------------------------------------------------------------------ badge */

function setBadge(text, title) {
  try {
    void chrome.action.setBadgeText({ text })
    void chrome.action.setBadgeBackgroundColor({ color: text === 'ON' ? '#2f9e44' : '#868e96' })
    void chrome.action.setTitle({ title: title || 'DSH Browser Extension' })
  } catch {
    // The action API is unavailable in a few test harnesses.
  }
}

/* ---------------------------------------------------------------- socket */

/** Exact decoded length of a standard base64 string (padding included). */
function decodedBase64Bytes(data) {
  if (typeof data !== 'string' || data.length === 0) return 0
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor(data.length / 4) * 3 - padding
}

/** Reject oversized payloads here, before an oversized frame closes the socket. */
function attachmentError(attachments) {
  if (attachments.length > MAX_ATTACHMENTS) {
    return `At most ${MAX_ATTACHMENTS} attachments per message.`
  }
  let total = 0
  for (const attachment of attachments) {
    const data = typeof attachment?.data === 'string' ? attachment.data : ''
    const bytes = decodedBase64Bytes(data)
    if (bytes > MAX_ATTACHMENT_BYTES) {
      return `"${attachment?.name || 'attachment'}" is larger than 12 MB.`
    }
    total += bytes
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
      return 'Attachments are limited to 40 MB per message.'
    }
  }
  return null
}

function describeClose(event, port) {
  if (event.code === 1008) return 'The bridge rejected the connection (token or protocol mismatch). Update both halves and copy the token again from browser_status.'
  if (event.code === 1011) return 'The bridge reported an internal error.'
  if (event.code === 1006) return `Cannot reach ws://127.0.0.1:${port}. Is the DeepSeek Harness app running?`
  return `Disconnected from ws://127.0.0.1:${port} (code ${event.code}).`
}

/**
 * Drop the current socket without scheduling a retry. Every handler compares
 * `socket !== ws` before acting, so a late event from a replaced socket can
 * never clear a newer connection or spawn a duplicate one.
 */
function closeSocket() {
  const ws = socket
  socket = null
  connected = false
  allowEvaluate = false
  clearTimeout(welcomeTimer)
  welcomeTimer = null
  stopKeepalive()
  if (ws) {
    try {
      ws.close(1000, 'client reconnect')
    } catch {
      // Already gone.
    }
  }
}

function connect() {
  if (!settings.token) {
    clearReconnectAlarm()
    setBadge('', 'Set the pairing token in the popup')
    return
  }
  if (socket) return
  clearTimeout(reconnectTimer)
  reconnectTimer = null
  attempts += 1
  const { token, port } = settings

  let ws
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}/`)
  } catch (error) {
    lastError = error?.message ?? String(error)
    scheduleReconnect()
    return
  }
  socket = ws
  connected = false
  lastMessageAt = Date.now()

  clearTimeout(welcomeTimer)
  welcomeTimer = setTimeout(() => {
    if (socket !== ws || connected) return
    lastError = `The bridge on port ${port} accepted the socket but never answered the handshake.`
    try {
      ws.close()
    } catch {
      // Already gone.
    }
  }, HANDSHAKE_TIMEOUT_MS)

  let challengeNonce = null

  ws.onopen = () => {
    // The bridge speaks first with a challenge. Never send the raw token on
    // this socket: a local process that squats the port would receive it.
  }

  ws.onmessage = (event) => {
    if (socket !== ws) return
    lastMessageAt = Date.now()
    let message
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (message?.type === 'challenge' && !connected) {
      if (challengeNonce || typeof message.nonce !== 'string' || !message.nonce) return
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        lastError = `The bridge speaks protocol ${message.protocolVersion}; this extension speaks ${PROTOCOL_VERSION}. Update both halves.`
        try {
          ws.close(1008, 'protocol mismatch')
        } catch {
          // Already gone.
        }
        return
      }
      challengeNonce = message.nonce
      const nonce = message.nonce
      void (async () => {
        try {
          const proof = await proofFor(token, 'client', nonce)
          if (socket !== ws) return
          ws.send(JSON.stringify({
            type: 'hello',
            proof,
            name: 'DSH Browser Extension',
            version: VERSION,
            userAgent: navigator.userAgent
          }))
        } catch (error) {
          lastError = String(error?.message ?? error)
          try {
            ws.close(1011, 'proof failed')
          } catch {
            // Already gone.
          }
        }
      })()
      return
    }
    if (message?.type === 'welcome' && !connected) {
      if (!challengeNonce) {
        lastError = 'The bridge answered before proving the pairing token.'
        try {
          ws.close(1008, 'unexpected welcome')
        } catch {
          // Already gone.
        }
        return
      }
      const nonce = challengeNonce
      challengeNonce = null
      void (async () => {
        try {
          const expected = await proofFor(token, 'server', nonce)
          if (socket !== ws) return
          if (message.protocolVersion !== PROTOCOL_VERSION || !proofMatches(expected, message.proof)) {
            lastError = 'The bridge did not prove possession of the pairing token.'
            try {
              ws.close(1008, 'server authentication failed')
            } catch {
              // Already gone.
            }
            return
          }
          clearTimeout(welcomeTimer)
          welcomeTimer = null
          connected = true
          allowEvaluate = message.allowEvaluate === true
          retry = 0
          lastError = null
          lastConnectedAt = new Date().toISOString()
          setBadge('ON', `Connected to DSH on port ${port}`)
          void chrome.storage.local.set({ lastConnectedAt })
          startKeepalive()
          // The open socket + keepalive now holds the worker; no need to wake
          // it every minute until the connection drops again.
          clearReconnectAlarm()
          // Confirm we verified the bridge's proof. The bridge does not set us
          // as its peer (or dispatch commands) until this frame arrives.
          try {
            ws.send(JSON.stringify({ type: 'ready' }))
          } catch {
            // The socket is closing; onclose schedules a retry.
          }
          // Hydrate the chat transcript for any open side panel.
          send({ type: 'chat/open' })
        } catch (error) {
          lastError = String(error?.message ?? error)
          try {
            ws.close(1011, 'proof failed')
          } catch {
            // Already gone.
          }
        }
      })()
      return
    }
    // Nothing else is trusted until the server has proved the pairing token.
    if (!connected) return
    if (message?.type === 'ping') {
      try {
        ws.send(JSON.stringify({ type: 'pong', at: Date.now() }))
      } catch {
        // The socket is closing.
      }
      return
    }
    if (message?.type === 'pong') return
    if (message?.type === 'chat/state') {
      chatEntries = Array.isArray(message.entries) ? message.entries : []
      chatStatus = message.status || 'idle'
      chatSessionId = message.sessionId ?? null
      // The Host re-announces pending approvals in its snapshot, so a worker
      // restart no longer loses cards that are still waiting for an answer.
      if (Array.isArray(message.approvals)) pendingApprovals = message.approvals
      broadcastToPanels({
        type: 'chat/state',
        entries: chatEntries,
        status: chatStatus,
        sessionId: chatSessionId,
        approvals: pendingApprovals
      })
      return
    }
    if (message?.type === 'chat/entry') {
      chatEntries.push(message.entry)
      if (chatEntries.length > 300) chatEntries = chatEntries.slice(-300)
      broadcastToPanels({ type: 'chat/entry', entry: message.entry })
      return
    }
    if (message?.type === 'chat/status') {
      chatStatus = message.status || 'idle'
      broadcastToPanels({ type: 'chat/status', status: chatStatus })
      return
    }
    if (message?.type === 'chat/approval') {
      const approval = message.approval
      if (approval && !pendingApprovals.some((entry) => entry.id === approval.id)) {
        pendingApprovals.push(approval)
      }
      broadcastToPanels({ type: 'chat/approval', approval })
      return
    }
    if (message?.type === 'chat/approval/clear') {
      pendingApprovals = pendingApprovals.filter((entry) => entry.id !== message.id)
      broadcastToPanels({ type: 'chat/approval/clear', id: message.id })
      return
    }
    if (message?.type === 'chat/restored') {
      chatEntries = Array.isArray(message.entries) ? message.entries : []
      broadcastToPanels({
        type: 'chat/state',
        entries: chatEntries,
        status: chatStatus,
        sessionId: chatSessionId,
        approvals: pendingApprovals
      })
      return
    }
    if (message?.type === 'screenshot') {
      lastScreenshot = {
        path: message.path,
        dataUrl: message.dataUrl,
        at: message.at || new Date().toISOString()
      }
      void chrome.storage.session.set({ lastScreenshot }).catch(() => {})
      broadcastToPanels({ type: 'screenshot', ...lastScreenshot })
      return
    }
    if (message?.type === 'chat/error') {
      // Use the Host's authoritative status when it sends one: a failed cancel
      // leaves the turn running, while a rejected send leaves it idle. Older
      // Hosts omit the field, where idle is the safe default.
      chatStatus = typeof message.status === 'string' ? message.status : 'idle'
      broadcastToPanels({ type: 'chat/status', status: chatStatus })
      broadcastToPanels({ type: 'chat/error', message: message.message })
      return
    }
    if (message && (typeof message.id === 'string' || typeof message.id === 'number')) {
      void handleCommand(message)
    }
  }

  ws.onclose = (event) => {
    if (socket !== ws) return
    socket = null
    connected = false
    allowEvaluate = false
    clearTimeout(welcomeTimer)
    welcomeTimer = null
    stopKeepalive()
    lastClose = { code: event.code, reason: event.reason || '', at: Date.now() }
    if (!lastError) lastError = describeClose(event, port)
    setBadge('', 'Not connected to DSH')
    scheduleReconnect()
  }

  ws.onerror = () => {
    if (socket !== ws) return
    lastError = `Cannot reach ws://127.0.0.1:${port}`
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  // A plain setTimeout dies with the worker; the alarm is what redials after
  // Chrome suspends us, so keep one armed while we are disconnected.
  ensureReconnectAlarm()
  const delay = Math.min(1000 * 2 ** retry, 30_000)
  retry = Math.min(retry + 1, 5)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delay)
}

function startKeepalive() {
  stopKeepalive()
  keepaliveTimer = setInterval(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    if (connected && Date.now() - lastMessageAt > STALE_AFTER_MS) {
      lastError = `The bridge stopped answering on port ${settings.port}.`
      try {
        socket.close()
      } catch {
        // Already gone.
      }
      return
    }
    try {
      socket.send(JSON.stringify({ type: 'ping', at: Date.now() }))
    } catch {
      // Closing.
    }
  }, KEEPALIVE_MS)
}

function stopKeepalive() {
  if (keepaliveTimer) clearInterval(keepaliveTimer)
  keepaliveTimer = null
}

function send(message) {
  if (!connected || !socket || socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify(message))
}

/** Deliver one internal message to every open extension page (the side panel). */
function broadcastToPanels(message) {
  chrome.runtime.sendMessage(message).catch(() => {})
}

/* --------------------------------------------------------------- commands */

const ACTIVITY_LIMIT = 60

/** One line describing a finished command, for the side panel. */
function summarizeCommand(method, result) {
  if (!result) return 'ok'
  switch (method) {
    case 'tabs.list':
      return `${Array.isArray(result) ? result.length : 0} tabs`
    case 'tabs.open':
    case 'tab.navigate':
      return result.url || 'navigated'
    case 'tab.snapshot':
      return `${result.nodes ?? 0} nodes`
    case 'tab.read':
      return `${result.length ?? 0} chars`
    case 'tab.click':
    case 'tab.type':
      return result.matched || 'done'
    case 'tab.screenshot':
      return 'captured'
    case 'tab.scroll':
      return `y=${result.y ?? 0}`
    case 'tab.waitFor':
      return result.found ? 'found' : 'not found'
    case 'tabs.close':
      return 'closed'
    case 'tabs.activate':
      return 'focused'
    default:
      return 'ok'
  }
}

async function loadActivity() {
  if (activityLoaded) return
  activityLoaded = true
  try {
    const stored = await chrome.storage.session.get('activity')
    if (Array.isArray(stored.activity)) activity = stored.activity.slice(-ACTIVITY_LIMIT)
  } catch {
    // Session storage is best-effort.
  }
}

function recordActivity(entry) {
  activity.push(entry)
  if (activity.length > ACTIVITY_LIMIT) activity = activity.slice(-ACTIVITY_LIMIT)
  void chrome.storage.session.set({ activity }).catch(() => {})
  chrome.runtime.sendMessage({ type: 'activity', entry }).catch(() => {})
}

async function handleCommand(message) {
  const id = message.id
  const started = Date.now()
  try {
    const result = await dispatch(message.method, message.params || {})
    lastCommandAt = new Date().toISOString()
    recordActivity({
      at: Date.now(),
      method: message.method,
      ok: true,
      ms: Date.now() - started,
      summary: summarizeCommand(message.method, result)
    })
    send({ id, ok: true, result })
  } catch (error) {
    const text = error?.message ? String(error.message) : String(error)
    recordActivity({
      at: Date.now(),
      method: message.method,
      ok: false,
      ms: Date.now() - started,
      summary: text.slice(0, 160)
    })
    send({ id, ok: false, error: text })
  }
}

function httpUrl(url) {
  const text = String(url || '').trim()
  if (!text) throw new Error('A URL is required.')
  if (/^https?:\/\//i.test(text)) return text
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) throw new Error(`Only http(s) URLs are supported, got "${text}".`)
  return `https://${text.replace(/^\/+/, '')}`
}

function tabView(tab) {
  return {
    id: tab.id,
    title: tab.title || '',
    url: tab.url || '',
    active: !!tab.active,
    pinned: !!tab.pinned,
    windowId: tab.windowId,
    index: tab.index
  }
}

async function resolveTab(params) {
  if (Number.isInteger(params.tabId)) {
    try {
      return await chrome.tabs.get(params.tabId)
    } catch {
      throw new Error(`Tab ${params.tabId} no longer exists. Call browser_tabs for the current list.`)
    }
  }
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab) [tab] = await chrome.tabs.query({ active: true })
  if (!tab) throw new Error('No active tab in Chrome. Open a page, or pass an explicit tabId from browser_tabs.')
  return tab
}

function assertInjectable(tab) {
  // During an uncommitted navigation Chrome reports an empty `url` with
  // `pendingUrl` set; use the pending URL when present, and let an empty URL
  // fall through so executeScript can attach or fail with its own error.
  const url = tab.url || tab.pendingUrl || ''
  // Keep the boundary the docs promise: http(s) pages only. `file:` becomes
  // scriptable when the user grants the separate "Allow access to file URLs"
  // toggle, which would otherwise expose local files over the bridge.
  if (url && !/^https?:\/\//i.test(url)) {
    throw new Error(`This extension only scripts http(s) pages (${url}). Open a normal page instead.`)
  }
}

async function waitForLoad(tabId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  await sleep(250)
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId)
    if (tab.status === 'complete') return tab
    await sleep(150)
  }
  return await chrome.tabs.get(tabId)
}

async function callContent(tab, op, args) {
  assertInjectable(tab)
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
  } catch (error) {
    throw new Error(`Cannot attach to this page: ${trimChromeError(error)}`)
  }
  let results
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      // An isolated-world function that throws can resolve with `result: null`
      // instead of rejecting, so every outcome travels in an envelope.
      func: (operation, payload) => {
        const ok = (value) => ({ __dsh: true, ok: true, value })
        const fail = (error) => ({ __dsh: true, ok: false, error: String(error?.message ?? error) })
        try {
          const agent = globalThis.__dshAgent
          if (!agent) return fail('page agent missing after injection')
          const fn = agent[operation]
          if (typeof fn !== 'function') return fail(`unsupported page operation: ${operation}`)
          const value = fn(payload)
          if (value && typeof value.then === 'function') return value.then(ok, fail)
          return ok(value)
        } catch (error) {
          return fail(error)
        }
      },
      args: [op, args || {}]
    })
  } catch (error) {
    throw new Error(trimChromeError(error))
  }
  return unwrapInjection(results?.[0])
}

function unwrapInjection(injected) {
  if (injected?.error) throw new Error(trimChromeError(injected.error))
  const envelope = injected?.result
  if (!envelope || envelope.__dsh !== true) {
    throw new Error('The page agent returned no result. Reload the page and try again.')
  }
  if (!envelope.ok) throw new Error(envelope.error)
  return envelope.value
}

function trimChromeError(error) {
  const text = String(error?.message ?? error ?? 'unknown error')
  return text.replace(/^Error:\s*/i, '').trim()
}

async function dispatch(method, params) {
  switch (method) {
    case 'tabs.list': {
      const tabs = await chrome.tabs.query({})
      return tabs.filter((tab) => Number.isInteger(tab.id)).map(tabView)
    }
    case 'tabs.open': {
      const tab = await chrome.tabs.create({ url: httpUrl(params.url), active: params.active !== false })
      const loaded = await waitForLoad(tab.id)
      return tabView(loaded)
    }
    case 'tabs.close': {
      if (!Number.isInteger(params.tabId)) throw new Error('tabs.close needs a numeric tabId.')
      await chrome.tabs.remove(params.tabId)
      return { closed: true, tabId: params.tabId }
    }
    case 'tabs.activate': {
      if (!Number.isInteger(params.tabId)) throw new Error('tabs.activate needs a numeric tabId.')
      const tab = await chrome.tabs.get(params.tabId)
      await chrome.windows.update(tab.windowId, { focused: true })
      const active = await chrome.tabs.update(tab.id, { active: true })
      return tabView(active)
    }
    case 'tab.navigate': {
      const tab = await resolveTab(params)
      const updated = await chrome.tabs.update(tab.id, { url: httpUrl(params.url) })
      const loaded = await waitForLoad(updated.id)
      return { tabId: loaded.id, url: loaded.url, title: loaded.title, status: loaded.status }
    }
    case 'tab.snapshot': {
      const tab = await resolveTab(params)
      const result = await callContent(tab, 'snapshot', params)
      return { tabId: tab.id, ...result }
    }
    case 'tab.read': {
      const tab = await resolveTab(params)
      const result = await callContent(tab, 'read', params)
      return { tabId: tab.id, ...result }
    }
    case 'tab.click': {
      const tab = await resolveTab(params)
      const result = await callContent(tab, 'click', params)
      await sleep(250)
      const after = await chrome.tabs.get(tab.id)
      return { ...result, tabId: after.id, url: after.url, title: after.title }
    }
    case 'tab.type': {
      const tab = await resolveTab(params)
      return { tabId: tab.id, ...(await callContent(tab, 'type', params)) }
    }
    case 'tab.press': {
      const tab = await resolveTab(params)
      return { tabId: tab.id, ...(await callContent(tab, 'press', params)) }
    }
    case 'tab.scroll': {
      const tab = await resolveTab(params)
      return { tabId: tab.id, ...(await callContent(tab, 'scroll', params)) }
    }
    case 'tab.waitFor': {
      const tab = await resolveTab(params)
      return { tabId: tab.id, ...(await callContent(tab, 'waitFor', params)) }
    }
    case 'tab.screenshot': {
      const tab = await resolveTab(params)
      assertInjectable(tab)
      await chrome.tabs.update(tab.id, { active: true })
      await chrome.windows.update(tab.windowId, { focused: true })
      await sleep(200)
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
      const current = await chrome.tabs.get(tab.id)
      return { dataUrl, url: current.url, title: current.title }
    }
    case 'tab.evaluate': {
      if (!allowEvaluate) {
        throw new Error('browser_evaluate is disabled. Enable `allowEvaluate: true` in the browser-companion config, then reconnect.')
      }
      const tab = await resolveTab(params)
      assertInjectable(tab)
      const expression = String(params.expression || '')
      if (!expression.trim()) throw new Error('tab.evaluate needs an expression.')
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: (source) => {
          const ok = (value) => ({ __dsh: true, ok: true, value })
          const fail = (error) => ({ __dsh: true, ok: false, error: String(error?.message ?? error) })
          const json = (input) => {
            try {
              return JSON.parse(JSON.stringify(input === undefined ? null : input))
            } catch {
              return String(input)
            }
          }
          try {
            return ok(json((0, eval)(source)))
          } catch (error) {
            return fail(error)
          }
        },
        args: [expression]
      })
      const injected = results?.[0]
      if (injected?.error) throw new Error(trimChromeError(injected.error))
      if (!injected?.result) throw new Error('Chrome returned no value for the expression.')
      const envelope = injected.result
      if (envelope.__dsh !== true) throw new Error('The page returned an unexpected value.')
      if (!envelope.ok) throw new Error(envelope.error)
      return { tabId: tab.id, value: envelope.value ?? null }
    }
    default:
      throw new Error(`Unknown command "${method}". Update the DSH browser-companion plugin or the extension so both halves match.`)
  }
}

/* ------------------------------------------------------------ popup + init */

async function panelState() {
  let tab = null
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (active) tab = { id: active.id, title: active.title || '', url: active.url || '' }
  } catch {
    // No window in some test harnesses.
  }
  return {
    connected,
    port: settings.port,
    hasToken: Boolean(settings.token),
    version: VERSION,
    lastError,
    lastClose,
    attempts,
    lastConnectedAt,
    lastCommandAt,
    activity,
    tab
  }
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type === 'panel/state') {
    void loadActivity().then(panelState).then(reply)
    return true
  }
  if (message?.type === 'panel/reconnect') {
    closeSocket()
    lastError = null
    retry = 0
    connect()
    reply({ ok: true })
    return false
  }
  if (message?.type === 'chat/open') {
    if (!socket || socket.readyState !== WebSocket.OPEN || !connected) {
      reply({ ok: false, error: 'Not connected to DSH.' })
      return false
    }
    send({ type: 'chat/open' })
    reply({
      ok: true,
      entries: chatEntries,
      status: chatStatus,
      sessionId: chatSessionId,
      screenshot: lastScreenshot,
      approvals: pendingApprovals
    })
    return false
  }
  if (message?.type === 'capture') {
    // The panel can capture on its own, so inline screenshots do not depend on a
    // Host that predates the broadcast path.
    void (async () => {
      try {
        const win = await chrome.windows.getLastFocused()
        const dataUrl = await chrome.tabs.captureVisibleTab(win?.id, { format: 'png' })
        reply({ ok: true, dataUrl })
      } catch (error) {
        reply({ ok: false, error: trimChromeError(error) })
      }
    })()
    return true
  }
  if (message?.type === 'chat/cancel') {
    if (!connected) {
      reply({ ok: false, error: 'Not connected to DSH.' })
      return false
    }
    send({ type: 'chat/cancel' })
    reply({ ok: true })
    return false
  }
  if (message?.type === 'chat/approval') {
    if (!connected) {
      reply({ ok: false, error: 'Not connected to DSH.' })
      return false
    }
    pendingApprovals = pendingApprovals.filter((entry) => entry.id !== message.id)
    send({ type: 'chat/approval', id: message.id, decision: message.decision === 'allow' ? 'allow' : 'deny' })
    reply({ ok: true })
    return false
  }
  if (message?.type === 'chat/send') {
    const text = typeof message.text === 'string' ? message.text : ''
    const attachments = Array.isArray(message.attachments) ? message.attachments : []
    if (!text.trim() && attachments.length === 0) {
      reply({ ok: false, error: 'Type a message first.' })
      return false
    }
    // Bound the `chat/send` frame: the Host's limit is checked only after the
    // frame arrives, so an unbounded draft plus near-cap attachments could
    // exceed ws.js's 64 MiB cap and kill the socket before the Host replies.
    if (text.trim().length > MAX_MESSAGE_CHARS) {
      reply({ ok: false, error: `Messages are limited to ${MAX_MESSAGE_CHARS} characters.` })
      return false
    }
    if (!socket || socket.readyState !== WebSocket.OPEN || !connected) {
      reply({ ok: false, error: 'Not connected to DSH.' })
      return false
    }
    const oversize = attachmentError(attachments)
    if (oversize) {
      reply({ ok: false, error: oversize })
      return false
    }
    chatStatus = 'working'
    broadcastToPanels({ type: 'chat/status', status: 'working' })
    send({
      type: 'chat/send',
      text,
      ...(attachments.length > 0 ? { attachments } : {})
    })
    reply({ ok: true })
    return false
  }
  if (message?.type === 'status') {
    reply({
      connected,
      port: settings.port,
      hasToken: Boolean(settings.token),
      version: VERSION,
      lastError,
      lastClose,
      attempts,
      socketState: socket ? socket.readyState : null,
      lastConnectedAt,
      lastCommandAt
    })
    return false
  }
  if (message?.type === 'reconnect') {
    closeSocket()
    lastError = null
    retry = 0
    connect()
    reply({ ok: true })
    return false
  }
  if (message?.type === 'config') {
    const port = Number(message.port)
    const provided = typeof message.token === 'string' ? message.token.trim() : ''
    void (async () => {
      // On a freshly woken worker, init() may not have loaded settings yet.
      // Read the stored token rather than treating an empty `settings.token`
      // as "clear the pairing".
      const stored = provided || settings.token ? null : await chrome.storage.local.get(['token']).catch(() => ({}))
      const token = provided || settings.token || String(stored?.token ?? '')
      settings = {
        // An empty token means "keep the saved one", which is what the popup
        // placeholder promises and what makes a port-only change possible.
        token,
        port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT
      }
      // Never overwrite a token we could not read; only persist one we have.
      await chrome.storage.local.set({ port: settings.port, ...(token ? { token } : {}) }).catch(() => {})
      closeSocket()
      retry = 0
      connect()
      if (!settings.token) clearReconnectAlarm()
      reply({ ok: true })
    })()
    return true
  }
  return false
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  let changed = false
  if ('token' in changes) {
    const token = String(changes.token.newValue ?? '')
    if (token !== settings.token) {
      settings.token = token
      changed = true
    }
  }
  if ('port' in changes) {
    const port = Number(changes.port.newValue)
    if (Number.isInteger(port) && port > 0 && port !== settings.port) {
      settings.port = port
      changed = true
    }
  }
  if (changed) {
    closeSocket()
    lastError = null
    retry = 0
    connect()
  }
})

/**
 * MV3 timers die with the worker, so a plain setTimeout backoff cannot redial
 * after Chrome suspends us. A one-minute alarm is the durable wake-up path.
 */
function ensureReconnectAlarm() {
  try {
    void chrome.alarms?.create(RECONNECT_ALARM, { periodInMinutes: 1 })
  } catch {
    // Alarms are unavailable in a few test harnesses.
  }
}

function clearReconnectAlarm() {
  try {
    void chrome.alarms?.clear(RECONNECT_ALARM)
  } catch {
    // Alarms are unavailable in a few test harnesses.
  }
}

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECONNECT_ALARM) return
  // Connected or unpaired: retire the wake-up instead of waking forever.
  if (!settings.token || socket) {
    clearReconnectAlarm()
    return
  }
  retry = 0
  connect()
})

async function init() {
  const stored = await chrome.storage.local.get(['token', 'port', 'lastConnectedAt'])
  settings.token = typeof stored.token === 'string' ? stored.token : ''
  const port = Number(stored.port)
  settings.port = Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT
  lastConnectedAt = typeof stored.lastConnectedAt === 'string' ? stored.lastConnectedAt : null
  await loadActivity()
  try {
    const storedShot = await chrome.storage.session.get('lastScreenshot')
    lastScreenshot = storedShot.lastScreenshot ?? null
  } catch {
    // Session storage is best-effort.
  }
  closeSocket()
  retry = 0
  setBadge('', settings.token ? 'Connecting to DSH…' : 'Set the pairing token in the popup')
  connect()
}

// MV3 workers are suspended aggressively. Settings live in storage, so reload
// them and dial on every worker start; the alarms wake-up above is what
// guarantees a start happens after Chrome suspends the worker while DSH is
// still down.
void init()
