/**
 * Host-side chat: one dedicated DSH Session that the browser side panel talks to.
 *
 * The panel is only a client. The agent, the model, the tools and the permissions
 * all stay in DSH; this module creates the Session, admits prompts, and maps the
 * Session's durable event log into transcript entries the panel can render.
 *
 * Durable events arrive as the agent commits them (`user/message`,
 * `assistant/message`, `tool/call`, `tool/result`, `turn/start`, `turn/end`), so
 * assistant text appears per step rather than per token. Token-level streaming
 * lives in the Host's transient attempt stream, which is not part of the log.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

/** Tool policies for the sidebar Session. Shell and file mutations are the risk. */
const TOOL_POLICIES = {
  open: [],
  'no-shell': ['bash', 'pwsh', 'write', 'edit', 'terminal', 'str_replace_editor'],
  'browser-only': ['bash', 'pwsh', 'write', 'edit', 'terminal', 'str_replace_editor', 'read', 'read_image', 'glob', 'grep']
}

const MAX_ENTRIES = 300
const MAX_TEXT = 12000
/** Hard limits on what the extension may push through the bridge. */
const MAX_MESSAGE_CHARS = 32_000
const MAX_ATTACHMENTS = 6
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
}

function clip(text, max = MAX_TEXT) {
  const value = String(text ?? '')
  return value.length > max ? value.slice(0, max) + '\n… (truncated)' : value
}

function preview(value, max = 140) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/**
 * Map one durable Session event into panel entries.
 * Pure so the shapes can be tested without a running Harness.
 * @returns {{ entries: object[], status?: 'working'|'idle' }}
 */
export function mapSessionEvent(sessionId, event) {
  const data = event?.data ?? {}
  switch (event?.type) {
    case 'user/message': {
      // Injected context (runtime-context, skill-catalog, time-context) is a
      // user/message too. Only real prompts belong in the transcript.
      const kind = data.source?.kind
      if (kind !== undefined && kind !== 'user' && kind !== 'user-rpc') return { entries: [] }
      const parts = data.content ?? data.message?.content ?? []
      const text = textOf(parts)
      const attachments = Array.isArray(parts)
        ? parts
            .filter((part) => part && (part.type === 'image' || part.type === 'file'))
            .map((part) => part.type === 'file'
              ? { kind: 'file', name: part.name ?? part.attachment?.name ?? 'file' }
              : { kind: 'image', name: part.name ?? 'image' })
        : []
      if (!text.trim() && attachments.length === 0) return { entries: [] }
      return { entries: [{ id: `u${event.seq}`, seq: event.seq, role: 'user', text: clip(text), attachments }] }
    }
    case 'assistant/message': {
      const message = data.message ?? {}
      const text = textOf(message.content ?? data.content)
      if (!text.trim()) return { entries: [] }
      return { entries: [{ id: `a${event.seq}`, seq: event.seq, role: 'assistant', text: clip(text) }] }
    }
    case 'tool/call': {
      return {
        entries: [{
          id: `t${event.seq}`,
          seq: event.seq,
          role: 'tool',
          callId: data.callId ?? null,
          name: String(data.name ?? 'tool'),
          detail: preview(data.arguments),
          state: 'running'
        }]
      }
    }
    case 'tool/result': {
      const message = data.message ?? {}
      const callId = message.toolCallId ?? data.callId ?? null
      const text = textOf(message.content)
      return {
        entries: [{
          id: `r${event.seq}`,
          seq: event.seq,
          role: 'tool-result',
          callId,
          isError: message.isError === true || data.isError === true,
          detail: preview(text)
        }]
      }
    }
    case 'turn/start':
      return { entries: [], status: 'working' }
    case 'turn/end':
      return { entries: [], status: 'idle' }
    case 'assistant/attempt': {
      const stream = data.stream
      const failed = stream?.error ?? data.error
      if (!failed) return { entries: [] }
      const message = failed.message ?? failed
      return {
        entries: [{
          id: `e${event.seq}`,
          seq: event.seq,
          role: 'error',
          text: clip(typeof message === 'string' ? message : (message.message ?? String(message)))
        }]
      }
    }
    default:
      return { entries: [] }
  }
}

/**
 * @param {object} options
 * @param {import('@deepseek-ai/cordis').Context} options.ctx
 * @param {string} options.cwd - working directory for the companion Session.
 * @param {number} [options.maxEntries]
 */
export function createChat({ ctx, cwd, attachmentDir, toolPolicy = 'no-shell', maxEntries = MAX_ENTRIES }) {
  const filesDir = attachmentDir
    ?? join(process.env.DSH_HOME ? process.env.DSH_HOME : join(homedir(), '.dsh'), 'browser-companion', 'attachments')
  const state = {
    sessionId: null,
    status: 'idle',
    entries: [],
    error: null
  }
  const stateFile = join(process.env.DSH_HOME ? process.env.DSH_HOME : join(homedir(), '.dsh'), 'browser-companion', 'chat.json')
  const approvals = new Map()
  const restricted = new WeakSet()
  const denyPattern = TOOL_POLICIES[toolPolicy] ?? TOOL_POLICIES['no-shell']
  const listeners = new Set()
  let creating = null
  let disposed = false

  function emit(message) {
    for (const listener of listeners) {
      try {
        listener(message)
      } catch {
        // A panel listener must never break the session.
      }
    }
  }

  function pushEntries(entries) {
    if (entries.length === 0) return
    state.entries.push(...entries)
    if (state.entries.length > maxEntries) state.entries = state.entries.slice(-maxEntries)
    for (const entry of entries) emit({ type: 'chat/entry', entry })
  }

  function setStatus(status) {
    if (status === state.status) return
    state.status = status
    emit({ type: 'chat/status', status })
  }

  /** Resolve the controller lazily: it is mounted by the API stack, not by us. */
  function controller() {
    const service = ctx.get('sessionController')
    if (!service) throw new Error('The Harness session controller is not available in this profile.')
    return service
  }

  async function persistSession(sessionId) {
    try {
      await mkdir(join(stateFile, '..'), { recursive: true, mode: 0o700 })
      await writeFile(stateFile, JSON.stringify({ sessionId, updatedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 })
    } catch (error) {
      console.warn('[browser-companion] cannot persist the chat session:', error?.message ?? String(error))
    }
  }

  async function loadPersistedSession() {
    try {
      const parsed = JSON.parse(await readFile(stateFile, 'utf8'))
      if (parsed && typeof parsed.sessionId === 'string' && parsed.sessionId.length > 0) {
        state.sessionId = parsed.sessionId
        return parsed.sessionId
      }
    } catch {
      // First run.
    }
    return null
  }

  async function ensureSession() {
    if (state.sessionId) return state.sessionId
    if (!creating) {
      creating = (async () => {
        const created = await controller().create({ cwd })
        state.sessionId = created.sessionId
        await persistSession(created.sessionId)
        try {
          await applyToolPolicy()
        } catch {
          // A policy that cannot be applied must not block the first message.
        }
        emit({ type: 'chat/session', sessionId: created.sessionId })
        return created.sessionId
      })().finally(() => {
        creating = null
      })
    }
    return await creating
  }

  /**
   * Apply the sidebar tool policy to the chat agent's own scope.
   *
   * `restrict()` rejects names the profile does not mount, so each tool is
   * denied individually and unknown ones are skipped. Runs before the prompt so
   * the turn's request is assembled without the denied schemas.
   */
  async function applyToolPolicy() {
    if (!denyPattern || denyPattern.length === 0) return
    const agents = ctx.get('agents')
    if (!agents || typeof agents.get !== 'function') return
    let agent = agents.get(state.sessionId)
    if (!agent && typeof agents.resolveAgent === 'function') {
      try {
        const resolved = await agents.resolveAgent(state.sessionId)
        agent = resolved?.agent
      } catch {
        return
      }
    }
    if (!agent || restricted.has(agent)) return

    const scope = agent.ctx
    if (!scope?.tools?.restrict) return

    // Restrict one tool at a time: restrict() rejects names this profile does not
    // mount, and a single unknown name must not drop the whole policy.
    const applied = []
    for (const name of denyPattern) {
      try {
        scope.tools.restrict({ deny: [name] })
        applied.push(name)
      } catch {
        // Not mounted here; nothing to deny.
      }
    }
    restricted.add(agent)
    if (applied.length > 0) {
      console.warn(`[browser-companion] chat tool policy "${toolPolicy}" denies: ${applied.join(', ')}`)
    }
  }

  /**
   * Rebuild the transcript from the durable log. This is what makes the panel
   * survive an app restart: the Session outlives the process, the in-memory
   * entries do not.
   */
  async function backfill() {
    if (state.entries.length > 0) return
    const sessionId = state.sessionId ?? (await loadPersistedSession())
    if (!sessionId) return
    try {
      // Read the durable log directly: a page cursor of -1 means "no events"
      // to the paginator, so the query observation is the honest source here.
      const query = ctx.get('sessionQuery')
      if (!query?.observeSession) throw new Error('The Harness session query service is not available.')
      const observation = await query.observeSession(sessionId, { projectionMode: 'none' })
      try {
        const events = Array.isArray(observation.events) ? observation.events : []
        const restored = []
        for (const event of events) {
          const mapped = mapSessionEvent(sessionId, event)
          restored.push(...mapped.entries)
        }
        if (restored.length > 0) {
          state.entries = restored.slice(-maxEntries)
          emit({ type: 'chat/restored', entries: state.entries })
        }
      } finally {
        observation?.[Symbol.dispose]?.()
      }
    } catch (error) {
      // A deleted or unreadable session starts over instead of failing the panel.
      const message = String(error?.message ?? error)
      if (/not-found|not found/i.test(message)) {
        state.sessionId = null
        state.entries = []
      } else {
        console.warn('[browser-companion] cannot replay the chat history:', message)
      }
    }
  }

  /** Load persisted identity and replay history once per process. */
  let prepared = null
  function prepare() {
    if (!prepared) prepared = backfill().catch(() => {})
    return prepared
  }

  async function cancel() {
    if (!state.sessionId) return
    await controller().cancel({ sessionId: state.sessionId })
    setStatus('idle')
    settleApprovals('rejected')
  }

  function onSessionEvent(session, event) {
    if (disposed) return
    if (!state.sessionId || session?.id !== state.sessionId) return
    const mapped = mapSessionEvent(state.sessionId, event)
    pushEntries(mapped.entries)
    if (mapped.status) setStatus(mapped.status)
    // A closed turn leaves no decision to collect: retire stale approval cards
    // instead of waiting for the five-minute timeout.
    if (event?.type === 'turn/end') settleApprovals('rejected')
  }

  const offSessionEvent = ctx.on('session/event', onSessionEvent, { global: true })

  /**
   * Approvals: when the app window is elsewhere, the panel is the only human
   * surface for this Session. Requests are forwarded there and fail closed if
   * nobody answers.
   */
  const offApproval = ctx.on('approval/request', async (request, next) => {
    if (!request?.agent || request.agent.id !== state.sessionId) return await next()
    const id = randomUUID()
    const approval = {
      id,
      toolName: String(request.toolName ?? 'tool'),
      reason: typeof request.reason === 'string' ? request.reason : ''
    }
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        approvals.delete(id)
        emit({ type: 'chat/approval/clear', id })
        resolve('rejected')
      }, 5 * 60 * 1000)
      timer.unref?.()
      approvals.set(id, {
        resolve: (decision) => {
          clearTimeout(timer)
          approvals.delete(id)
          emit({ type: 'chat/approval/clear', id })
          resolve(decision === 'allow' ? 'allowed-once' : 'rejected')
        }
      })
      emit({ type: 'chat/approval', approval })
    })
  })

  /** Resolve one pending approval from the panel. */
  function answerApproval(id, decision) {
    const waiting = approvals.get(id)
    if (!waiting) return false
    waiting.resolve(decision)
    return true
  }

  /** Resolve every pending approval, e.g. on cancel or disposal. */
  function settleApprovals(decision) {
    for (const [id, waiting] of approvals) {
      approvals.delete(id)
      waiting.resolve(decision)
    }
  }

  /**
   * Build prompt parts: text first, then encoded images (admitted by the
   * attachment store) and generic files (saved verbatim, surfaced to the model
   * as a readable path).
   */
  async function buildContent(text, attachments) {
    const parts = []
    const trimmed = String(text ?? '').trim()
    if (trimmed.length > MAX_MESSAGE_CHARS) {
      throw new Error(`Messages are limited to ${MAX_MESSAGE_CHARS} characters.`)
    }
    if (trimmed) parts.push({ type: 'text', text: trimmed })
    if (attachments.length > MAX_ATTACHMENTS) {
      throw new Error(`At most ${MAX_ATTACHMENTS} attachments per message.`)
    }

    for (const attachment of attachments) {
      const name = typeof attachment?.name === 'string' && attachment.name ? attachment.name : 'attachment'
      const data = typeof attachment?.data === 'string' ? attachment.data : ''
      if (!data) continue
      if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
        throw new Error(`"${name}" is not valid base64.`)
      }
      const bytes = Buffer.from(data, 'base64')
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        throw new Error(`"${name}" is larger than 12 MB.`)
      }
      const mediaType = typeof attachment?.mediaType === 'string' ? attachment.mediaType : 'application/octet-stream'
      if (mediaType.startsWith('image/')) {
        parts.push({ type: 'image', data, mediaType, name })
        continue
      }
      // The prompt path accepts only upload receipts for generic files, and a
      // receipt belongs to the client upload RPC. Save the bytes ourselves and
      // hand the model the same thing it would get anyway: a readable path.
      await mkdir(filesDir, { recursive: true, mode: 0o700 })
      const safe = basename(name).replace(/[^\w.\-() ]+/g, '_').slice(0, 80) || 'attachment'
      const path = join(filesDir, `${Date.now()}-${randomBytes(3).toString('hex')}-${safe}`)
      await writeFile(path, bytes, { mode: 0o600 })
      parts.push({ type: 'text', text: `[Attached file: ${name} — saved at ${path}]` })
    }
    return parts
  }

  async function send(text, attachments = []) {
    state.error = null
    const parts = await buildContent(text, Array.isArray(attachments) ? attachments : [])
    if (parts.length === 0) throw new Error('Type a message or attach a file.')
    const sessionId = await ensureSession()
    await applyToolPolicy()
    setStatus('working')
    const requestId = `companion-${randomUUID()}`
    try {
      await controller().prompt(
        { sessionId, content: parts, requestId },
        new AbortController().signal
      )
    } catch (error) {
      setStatus('idle')
      state.error = String(error?.message ?? error)
      throw error
    }
    return snapshot()
  }

  function snapshot() {
    return {
      sessionId: state.sessionId,
      status: state.status,
      entries: [...state.entries],
      error: state.error
    }
  }

  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function dispose() {
    disposed = true
    listeners.clear()
    settleApprovals('cancelled')
    try {
      offSessionEvent?.()
      offApproval?.()
    } catch {
      // The scope may already be gone.
    }
  }

  return { send, cancel, answerApproval, snapshot, subscribe, dispose, ensureSession, prepare, backfill }
}
