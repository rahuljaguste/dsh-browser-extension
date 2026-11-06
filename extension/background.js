/**
 * Service worker: owns the WebSocket to the DSH bridge and executes commands
 * against Chrome's tabs.
 *
 * MV3 service workers are suspended when idle; an open WebSocket plus the
 * app-level ping every 20s keeps this one alive while the bridge is connected
 * (Chrome 116+). A failed connection retries with capped backoff.
 */

const VERSION = chrome.runtime.getManifest().version
const DEFAULT_PORT = 8787
const KEEPALIVE_MS = 20_000
const HANDSHAKE_TIMEOUT_MS = 8_000
const STALE_AFTER_MS = 60_000

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------------------------------------------ badge */

function setBadge(text, title) {
  try {
    void chrome.action.setBadgeText({ text })
    void chrome.action.setBadgeBackgroundColor({ color: text === 'ON' ? '#2f9e44' : '#868e96' })
    void chrome.action.setTitle({ title: title || 'DSH Browser Companion' })
  } catch {
    // The action API is unavailable in a few test harnesses.
  }
}

/* ---------------------------------------------------------------- socket */

function describeClose(event, port) {
  if (event.code === 1008) return 'The bridge rejected the pairing token. Copy it again from browser_status.'
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

  ws.onopen = () => {
    if (socket !== ws) return
    try {
      ws.send(JSON.stringify({
        type: 'hello',
        token,
        name: 'DSH Browser Companion',
        version: VERSION,
        userAgent: navigator.userAgent
      }))
    } catch (error) {
      lastError = String(error?.message ?? error)
    }
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
    if (message?.type === 'welcome') {
      clearTimeout(welcomeTimer)
      welcomeTimer = null
      connected = true
      retry = 0
      lastError = null
      lastConnectedAt = new Date().toISOString()
      setBadge('ON', `Connected to DSH on port ${port}`)
      void chrome.storage.local.set({ lastConnectedAt })
      startKeepalive()
      // Hydrate the chat transcript for any open side panel.
      send({ type: 'chat/open' })
      return
    }
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
      broadcastToPanels({
        type: 'chat/state',
        entries: chatEntries,
        status: chatStatus,
        sessionId: chatSessionId
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
      broadcastToPanels({ type: 'chat/state', entries: chatEntries, status: chatStatus, sessionId: chatSessionId })
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
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
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
  const url = tab.url || ''
  if (/^(chrome|edge|about|devtools|chrome-extension|view-source):/i.test(url)) {
    throw new Error(`Chrome does not let extensions script this page (${url}). Open a normal http(s) page instead.`)
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
      await chrome.tabs.update(tab.id, { active: true })
      await chrome.windows.update(tab.windowId, { focused: true })
      await sleep(200)
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
      const current = await chrome.tabs.get(tab.id)
      return { dataUrl, url: current.url, title: current.title }
    }
    case 'tab.evaluate': {
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
    if (!socket || socket.readyState !== WebSocket.OPEN) {
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
    send({ type: 'chat/cancel' })
    reply({ ok: true })
    return false
  }
  if (message?.type === 'chat/approval') {
    pendingApprovals = pendingApprovals.filter((entry) => entry.id !== message.id)
    send({ type: 'chat/approval', id: message.id, decision: message.decision === 'allow' ? 'allow' : 'deny' })
    reply({ ok: true })
    return false
  }
  if (message?.type === 'chat/send') {
    const text = typeof message.text === 'string' ? message.text : ''
    if (!text.trim()) {
      reply({ ok: false, error: 'Type a message first.' })
      return false
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      reply({ ok: false, error: 'Not connected to DSH.' })
      return false
    }
    chatStatus = 'working'
    broadcastToPanels({ type: 'chat/status', status: 'working' })
    send({
      type: 'chat/send',
      text,
      ...(Array.isArray(message.attachments) && message.attachments.length > 0
        ? { attachments: message.attachments }
        : {})
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
    settings = {
      token: typeof message.token === 'string' ? message.token.trim() : settings.token,
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT
    }
    // storage.onChanged is the single reconnect path; it fires right after this
    // write and compares against the values applied above, so it does the work.
    void chrome.storage.local.set({ token: settings.token, port: settings.port })
    closeSocket()
    retry = 0
    connect()
    reply({ ok: true })
    return false
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

chrome.runtime.onInstalled.addListener(() => {
  void init()
})
chrome.runtime.onStartup.addListener(() => {
  void init()
})

void init()
