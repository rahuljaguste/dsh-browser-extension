/**
 * Unit tests for the Host chat mapping and session wiring. No Harness, no model:
 * a fake Context supplies the session controller and the event bus.
 */
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChat, mapSessionEvent } from '../lib/chat.js'

// Keep the persisted chat state out of the real DSH home.
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'companion-home-'))

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  ✓ ${name}`)
  else {
    failures += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('mapSessionEvent')
const userEntry = mapSessionEvent('s1', {
  seq: 1,
  type: 'user/message',
  data: { role: 'user', content: [{ type: 'text', text: 'open news.ycombinator.com' }], source: { kind: 'user' } }
})
check('user message becomes one user entry', userEntry.entries.length === 1 && userEntry.entries[0].role === 'user' && userEntry.entries[0].text === 'open news.ycombinator.com')

const assistantEntry = mapSessionEvent('s1', {
  seq: 2,
  type: 'assistant/message',
  data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Opening it now.' }] } }
})
check('assistant message becomes one assistant entry', assistantEntry.entries[0]?.role === 'assistant' && assistantEntry.entries[0].text === 'Opening it now.')

const call = mapSessionEvent('s1', {
  seq: 3,
  type: 'tool/call',
  data: { turn: 1, step: 1, callId: 'call_1', name: 'browser_open', arguments: '{"url":"https://news.ycombinator.com"}' }
})
check('tool call becomes a running tool row', call.entries[0]?.role === 'tool' && call.entries[0].state === 'running' && call.entries[0].callId === 'call_1')
check('tool row keeps the tool name', call.entries[0]?.name === 'browser_open')

const result = mapSessionEvent('s1', {
  seq: 4,
  type: 'tool/result',
  data: {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      toolCallId: 'call_1',
      isError: false,
      content: [{ type: 'text', text: '{"id":42,"title":"Hacker News"}' }]
    }
  }
})
check('tool result carries the call id and text', result.entries[0]?.callId === 'call_1' && result.entries[0].detail.includes('Hacker News'))

const failed = mapSessionEvent('s1', {
  seq: 5,
  type: 'tool/result',
  data: { message: { role: 'tool', toolCallId: 'call_9', isError: true, content: [{ type: 'text', text: 'Not connected' }] } }
})
check('failed tool result is flagged', failed.entries[0]?.isError === true)

check('turn/start sets working', mapSessionEvent('s1', { seq: 6, type: 'turn/start', data: { turn: 1 } }).status === 'working')
check('turn/end sets idle', mapSessionEvent('s1', { seq: 7, type: 'turn/end', data: { turn: 1, reason: null } }).status === 'idle')
const injected = mapSessionEvent('s1', {
  seq: 12,
  type: 'user/message',
  data: { content: [{ type: 'text', text: 'Current runtime context…' }], source: { kind: 'runtime-context' } }
})
check('injected context is kept out of the transcript', injected.entries.length === 0)
check('injected skill catalog is kept out', mapSessionEvent('s1', { seq: 13, type: 'user/message', data: { content: [{ type: 'text', text: 'skills' }], source: { kind: 'skill-catalog' } } }).entries.length === 0)

check('unknown events are ignored', mapSessionEvent('s1', { seq: 8, type: 'sandbox/mode', data: {} }).entries.length === 0)
check('empty assistant content is dropped', mapSessionEvent('s1', { seq: 9, type: 'assistant/message', data: { message: { role: 'assistant', content: [] } } }).entries.length === 0)

console.log('\ncreateChat')
const listeners = []
const approvalListeners = []
const prompts = []
const created = []
const cancelled = []
const paged = []
const defaultRestrictedFilters = []
const defaultAgentStub = {
  id: 'session-1',
  ctx: { tools: { restrict(filter) { defaultRestrictedFilters.push(filter); return () => {} } } }
}
const ctx = {
  get(name) {
    if (name === 'agents') return { get: () => defaultAgentStub }
    if (name === 'sessionQuery') {
      return {
        async observeSession() {
          return {
            events: [
              { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'older question' }], source: { kind: 'user' } } },
              { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'older answer' }] } } }
            ],
            [Symbol.dispose]() {}
          }
        }
      }
    }
    if (name !== 'sessionController') return undefined
    return {
      async create(request) {
        created.push(request)
        return { sessionId: 'session-1' }
      },
      async prompt(request) {
        prompts.push(request)
        return { accepted: true }
      },
      async cancel(request) {
        cancelled.push(request)
        return { accepted: true }
      },
      async page(request) {
        paged.push(request)
        return {
          records: [
            { type: 'event', event: { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'older question' }], source: { kind: 'user' } } } },
            { type: 'event', event: { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'older answer' }] } } } }
          ],
          hasMore: false
        }
      }
    }
  },
  on(name, handler) {
    if (name === 'session/event') listeners.push(handler)
    if (name === 'approval/request') approvalListeners.push(handler)
    return () => {
      const index = listeners.indexOf(handler)
      if (index >= 0) listeners.splice(index, 1)
      const approvalIndex = approvalListeners.indexOf(handler)
      if (approvalIndex >= 0) approvalListeners.splice(approvalIndex, 1)
    }
  }
}

const chat = createChat({ ctx, cwd: '/tmp' })
const events = []
chat.subscribe((message) => events.push(message))

await chat.send('hello there')
check('creates one session with the configured cwd', created.length === 1 && created[0].cwd === '/tmp')
check('prompts with text content and a request id', prompts.length === 1 && prompts[0].sessionId === 'session-1' && prompts[0].content[0].text === 'hello there' && typeof prompts[0].requestId === 'string')
check('reports working status on send', chat.snapshot().status === 'working')
check('emits a status change', events.some((message) => message.type === 'chat/status' && message.status === 'working'))

const emit = (event) => listeners.forEach((handler) => handler({ id: 'session-1' }, event))
emit({ seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'hello there' }] } })
emit({ seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hi' }] } } })
emit({ seq: 3, type: 'turn/end', data: { turn: 1 } })
check('collects the transcript', chat.snapshot().entries.length === 2)
check('goes idle when the turn ends', chat.snapshot().status === 'idle')
check('ignores events from other sessions', (() => {
  listeners.forEach((handler) => handler({ id: 'other' }, { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'nope' }] } } }))
  return chat.snapshot().entries.length === 2
})())

await chat.send('second')
check('reuses the session for later messages', created.length === 1 && prompts.length === 2)

const base64 = Buffer.from('png-bytes').toString('base64')
await chat.send('', [{ name: 'shot.png', mediaType: 'image/png', data: base64 }])
const imageParts = prompts.at(-1).content
check('image attachment becomes an encoded image part', imageParts.length === 1 && imageParts[0].type === 'image' && imageParts[0].mediaType === 'image/png' && imageParts[0].data === base64)

const filesDir = await mkdtemp(join(tmpdir(), 'companion-files-'))
const chatWithFiles = createChat({ ctx, cwd: '/tmp', attachmentDir: filesDir })
chatWithFiles.subscribe(() => {})
await chatWithFiles.send('look at this', [{ name: 'notes.txt', mediaType: 'text/plain', data: base64 }])
const fileParts = prompts.at(-1).content
check('text and file arrive together', fileParts[0].type === 'text' && fileParts[1].type === 'text')
const marker = /^\[Attached file: notes\.txt — saved at (.+)\]$/.exec(fileParts[1]?.text ?? '')
check('generic file is referenced by a saved path', Boolean(marker), fileParts[1]?.text)
check('generic file bytes are written verbatim', marker ? (await readFile(marker[1], 'utf8')) === 'png-bytes' : false)
chatWithFiles.dispose()

const mapped = mapSessionEvent('s1', {
  seq: 20,
  type: 'user/message',
  data: {
    source: { kind: 'user' },
    content: [
      { type: 'text', text: 'look' },
      { type: 'image', attachment: { id: 'img-1' } },
      { type: 'file', attachment: { id: 'file-1', name: 'notes.txt' } }
    ]
  }
})
check('user entry keeps attachment metadata', mapped.entries[0]?.attachments?.length === 2 && mapped.entries[0].attachments[1].name === 'notes.txt')

// --- cancel -----------------------------------------------------------------
await chat.cancel()
check('cancel reaches the session controller', cancelled.length === 1 && cancelled[0].sessionId === 'session-1')
check('cancel returns the chat to idle', chat.snapshot().status === 'idle')

// --- approvals --------------------------------------------------------------
check('registers an approval answerer', approvalListeners.length === 1)
const approvalEvents = []
chat.subscribe((message) => approvalEvents.push(message))
let delegated = false
const foreign = await approvalListeners[0]({ agent: { id: 'other' }, toolName: 'bash' }, async () => {
  delegated = true
  return 'unavailable'
})
check('other agents are delegated', delegated === true && foreign === 'unavailable')

const pendingApproval = approvalListeners[0]({ agent: { id: 'session-1' }, toolName: 'bash', reason: 'Run a command?' }, async () => 'unavailable')
const asked = approvalEvents.find((message) => message.type === 'chat/approval')
check('approval request reaches the panel', Boolean(asked) && asked.approval.toolName === 'bash' && asked.approval.reason === 'Run a command?')
check('snapshot carries pending approvals', chat.snapshot().approvals.some((approval) => approval.id === asked.approval.id))
check('approval is answerable', chat.answerApproval(asked.approval.id, 'allow') === true)
check('allowed decision becomes allowed-once', (await pendingApproval) === 'allowed-once')
check('answered approvals leave the snapshot', chat.snapshot().approvals.length === 0)
check('unknown approval ids are ignored', chat.answerApproval('nope', 'allow') === false)

// --- history backfill -------------------------------------------------------
const restored = createChat({ ctx, cwd: '/tmp' })
await restored.prepare()
check('backfill replays the durable page', restored.snapshot().entries.length === 2 && restored.snapshot().entries[0].text === 'older question')
check('backfill names the persisted session', restored.snapshot().sessionId === 'session-1')
restored.dispose()

// --- tool policy -------------------------------------------------------------
const restrictedFilters = []
const agentStub = {
  id: 'session-1',
  ctx: { tools: { restrict(filter) { restrictedFilters.push(filter); return () => {} } } }
}
const policyCtx = {
  get(name) {
    if (name === 'agents') return { get: () => agentStub }
    if (name === 'sessionController') {
      return { async create() { return { sessionId: 'session-policy' } }, async prompt() { return { accepted: true } } }
    }
    return undefined
  },
  on() { return () => {} },
  tools: {
    schemas() {
      return [{ name: 'bash' }, { name: 'read' }, { name: 'write' }, { name: 'browser_click' }]
    }
  }
}

const noShellChat = createChat({ ctx: policyCtx, cwd: '/tmp', toolPolicy: 'no-shell', attachmentDir: filesDir })
await noShellChat.send('hi')
const noShellDenied = restrictedFilters.map((filter) => filter.deny?.[0])
check('no-shell policy denies the shell and mutations', noShellDenied.includes('bash') && noShellDenied.includes('write'), JSON.stringify(noShellDenied))
check('no-shell policy keeps reads', !noShellDenied.includes('read'), JSON.stringify(noShellDenied))
noShellChat.dispose()

restrictedFilters.length = 0
const browserOnlyChat = createChat({ ctx: policyCtx, cwd: '/tmp', toolPolicy: 'browser-only', attachmentDir: filesDir })
await browserOnlyChat.send('hi')
const browserOnlyDenied = restrictedFilters.map((filter) => filter.deny?.[0])
check('browser-only policy also denies reads', browserOnlyDenied.includes('read') && browserOnlyDenied.includes('bash'), JSON.stringify(browserOnlyDenied))
browserOnlyChat.dispose()

restrictedFilters.length = 0
const openChat = createChat({ ctx: policyCtx, cwd: '/tmp', toolPolicy: 'open', attachmentDir: filesDir })
await openChat.send('hi')
check('open policy restricts nothing', restrictedFilters.length === 0)
openChat.dispose()

// --- restored-session tool policy -------------------------------------------
const restoredFilters = []
const restoredPrompts = []
const restoredAgentStub = {
  id: 'session-1',
  ctx: { tools: { restrict(filter) { restoredFilters.push(filter); return () => {} } } }
}
const restoredPolicyCtx = {
  get(name) {
    if (name === 'agents') return { get: () => undefined }
    if (name === 'sessionController') {
      return {
        async resolveAgent() {
          return { agent: restoredAgentStub }
        },
        async prompt(request) {
          restoredPrompts.push(request)
          return { accepted: true }
        }
      }
    }
    if (name === 'sessionQuery') {
      return { async observeSession() { return { events: [], [Symbol.dispose]() {} } } }
    }
    return undefined
  },
  on() { return () => {} }
}
const restoredPolicyChat = createChat({ ctx: restoredPolicyCtx, cwd: '/tmp', toolPolicy: 'no-shell', attachmentDir: filesDir })
await restoredPolicyChat.prepare()
const persistedSessionId = restoredPolicyChat.snapshot().sessionId
await restoredPolicyChat.send('after a restart')
const restoredDenied = restoredFilters.map((filter) => filter.deny?.[0])
check(
  'restored sessions resolve the agent before applying the policy',
  Boolean(persistedSessionId) &&
    restoredDenied.includes('bash') &&
    restoredDenied.includes('write'),
  JSON.stringify(restoredDenied)
)
check('the restored session is prompted only after the policy is applied', restoredPrompts.length === 1 && restoredPrompts[0].sessionId === persistedSessionId)
restoredPolicyChat.dispose()

// --- policy fails closed -----------------------------------------------------
const failClosedPrompts = []
const failClosedCtx = {
  get(name) {
    if (name === 'agents') return { get: () => undefined }
    if (name === 'sessionController') {
      return {
        async resolveAgent() { return { error: new Error('session/not-found') } },
        async prompt(request) { failClosedPrompts.push(request); return { accepted: true } }
      }
    }
    if (name === 'sessionQuery') {
      return { async observeSession() { return { events: [], [Symbol.dispose]() {} } } }
    }
    return undefined
  },
  on() { return () => {} }
}
const failClosedChat = createChat({ ctx: failClosedCtx, cwd: '/tmp', toolPolicy: 'no-shell', attachmentDir: filesDir })
await failClosedChat.prepare()
const failClosedError = await failClosedChat.send('hi').then(() => '', (error) => error.message)
check('send fails closed when the policy cannot be applied', /Cannot apply tool policy/.test(failClosedError) && failClosedPrompts.length === 0, failClosedError)
failClosedChat.dispose()

// --- mounted tools that refuse restriction ----------------------------------
const stubbornPrompts = []
const stubbornAgent = {
  id: 'session-stubborn',
  ctx: {
    tools: {
      get(name) { return { name } },
      restrict() { throw new Error('restriction unsupported') }
    }
  }
}
const stubbornCtx = {
  get(name) {
    if (name === 'agents') return { get: () => stubbornAgent }
    if (name === 'sessionController') {
      return {
        async create() { return { sessionId: 'session-stubborn' } },
        async prompt(request) { stubbornPrompts.push(request); return { accepted: true } }
      }
    }
    return undefined
  },
  on() { return () => {} }
}
const stubbornChat = createChat({ ctx: stubbornCtx, cwd: '/tmp', toolPolicy: 'no-shell', attachmentDir: filesDir })
const stubbornError = await stubbornChat.send('hi').then(() => '', (error) => error.message)
check('mounted tools that cannot be restricted fail closed', /mounted tool\(s\)/.test(stubbornError) && stubbornPrompts.length === 0, stubbornError)
stubbornChat.dispose()

// --- attachment totals ------------------------------------------------------
const cappedFilesDir = await mkdtemp(join(tmpdir(), 'companion-capped-'))
const chunk = Buffer.alloc(6, 1).toString('base64')
const totalCappedChat = createChat({
  ctx: policyCtx,
  cwd: '/tmp',
  toolPolicy: 'open',
  attachmentDir: cappedFilesDir,
  maxTotalAttachmentBytes: 8
})
const totalError = await totalCappedChat.send('', [
  { name: 'a.bin', mediaType: 'application/octet-stream', data: chunk },
  { name: 'b.bin', mediaType: 'application/octet-stream', data: chunk }
]).then(() => '', (error) => error.message)
check('aggregate attachment bytes are capped', /Attachments are limited to/.test(totalError), totalError)
const orphaned = await readdir(cappedFilesDir).catch(() => [])
check('a rejected attachment batch writes no files', orphaned.length === 0, JSON.stringify(orphaned))
totalCappedChat.dispose()

chat.dispose()
check('dispose removes the session listener', listeners.length === 0)

console.log(failures === 0 ? '\nALL CHAT CHECKS PASSED' : `\n${failures} CHAT CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
