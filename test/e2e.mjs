/**
 * End-to-end check: real Chrome, the real unpacked extension, the real bridge,
 * and the real tool definitions. No DSH process is required.
 *
 * Run: node test/e2e.mjs [--headed]
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBridge } from '../lib/bridge.js'
import { registerBrowserTools } from '../lib/tools.js'
import { startFixture } from './fixture.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const extensionPath = join(root, 'extension')

// Playwright's own Chromium keeps --load-extension; Google Chrome 137+ ignores
// it, so the test never uses the installed Chrome. Browsers download into the
// workspace so no sandboxed cache directory is needed.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(root, '..', '.pw-browsers')
const { chromium } = await import('playwright-core')

const headed = process.argv.includes('--headed')

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

const bridge = createBridge({ port: 0, home: await mkdtemp(join(tmpdir(), 'dsh-companion-home-')), log: () => {} })
await bridge.start()
console.log(`bridge on port ${bridge.port}`)

// --- auth: a bogus token must be refused ------------------------------------
console.log('\nauth')
const bogus = new WebSocket(`ws://127.0.0.1:${bridge.port}/`)
const bogusResult = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve('timeout'), 4000)
  bogus.onopen = () => bogus.send(JSON.stringify({ type: 'hello', token: 'not-the-token', name: 'rogue', version: '0' }))
  bogus.onclose = (event) => {
    clearTimeout(timer)
    resolve(`closed:${event.code}`)
  }
  bogus.onerror = () => {}
})
bogus.close()
check('wrong pairing token is rejected', /closed:1008/.test(bogusResult), bogusResult)
check('bridge does not consider the rogue client connected', bridge.status().connected === false)

// --- Chrome + extension ------------------------------------------------------
const fixture = await startFixture()
const userDataDir = await mkdtemp(join(tmpdir(), 'dsh-companion-profile-'))
const shotsDir = await mkdtemp(join(tmpdir(), 'dsh-companion-shots-'))
console.log(`\nlaunching Chrome (${headed ? 'headed' : 'headless'}) with ${extensionPath}`)

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: !headed,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check'
  ]
})

try {
  let [worker] = context.serviceWorkers()
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 })
  check('extension service worker started', Boolean(worker))

  await worker.evaluate(async ({ token, port }) => {
    await chrome.storage.local.set({ token, port })
  }, { token: bridge.token, port: bridge.port })

  await waitUntil(() => bridge.status().connected, 10000, 'extension handshake')
  check('extension paired with the bridge', bridge.status().connected)
  check('bridge reports the client name', bridge.status().client?.name === 'DSH Browser Companion')

  // --- tools -----------------------------------------------------------------
  const definitions = new Map()
  const fakeCtx = {
    tools: {
      register(definition) {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      }
    }
  }
  registerBrowserTools(fakeCtx, bridge, { allowEvaluate: true, screenshotDir: shotsDir })
  const call = async (name, args = {}) => {
    const definition = definitions.get(name)
    if (!definition) throw new Error(`missing tool ${name}`)
    return await definition.execute(args, { signal: undefined })
  }

  console.log('\ntools')
  check('registers browser tools', definitions.size >= 10, `${definitions.size} registered`)

  const status = await call('browser_status')
  check('browser_status reports connected', status.connected === true && status.bridge === 'listening')

  const tabs = await call('browser_tabs')
  check('browser_tabs lists at least one tab', Array.isArray(tabs.tabs) && tabs.tabs.length >= 1)

  const opened = await call('browser_open', { url: fixture.url })
  check('browser_open loads the fixture', opened.title === 'Companion Fixture', JSON.stringify(opened).slice(0, 200))
  check('browser_open returns a numeric tab id', Number.isInteger(opened.id))

  const snapshot = await call('browser_snapshot', {})
  check('snapshot shows the heading', /heading "Companion Fixture"/.test(snapshot.text), snapshot.text.slice(0, 300))
  const greetRef = /button "Greet" \[ref=(e\d+)\]/.exec(snapshot.text)?.[1]
  check('snapshot assigns a ref to the button', Boolean(greetRef), snapshot.text.slice(0, 400))
  const nameRef = /textbox "Name" \[ref=(e\d+)\]/.exec(snapshot.text)?.[1]
  check('snapshot assigns a ref to the input', Boolean(nameRef), snapshot.text.slice(0, 400))

  await call('browser_type', { ref: nameRef, text: 'Ada' })
  const typed = await call('browser_evaluate', { expression: 'document.getElementById("name").value' })
  check('browser_type writes the value', typed.value === 'Ada', JSON.stringify(typed))

  await call('browser_click', { ref: greetRef })
  const read = await call('browser_read')
  check('clicking runs the page handler', read.text.includes('Hello, Ada'), read.text.slice(0, 300))

  const scrolled = await call('browser_scroll', { direction: 'bottom' })
  check('browser_scroll reports a position', typeof scrolled.y === 'number' && scrolled.y >= 0)

  const shot = await call('browser_screenshot')
  const shotInfo = await stat(shot.path)
  const signature = await readFile(shot.path)
  check('screenshot file exists and is a PNG', shotInfo.size > 1000 && signature.subarray(1, 4).toString() === 'PNG', shot.path)

  const navigated = await call('browser_navigate', { url: `${fixture.url}second` })
  check('browser_navigate reaches the second page', navigated.title === 'Second page', JSON.stringify(navigated))
  const waited = await call('browser_wait_for', { text: 'Arrived' })
  check('browser_wait_for finds text', waited.found === true, JSON.stringify(waited))

  const stale = await call('browser_click', { ref: 'e999' }).then(() => '').catch((error) => error.message)
  check('stale refs produce a useful error', /Take a new browser_snapshot/.test(stale), stale)

  await call('browser_click', { selector: 'a' })
  await call('browser_wait_for', { text: 'Companion Fixture' })
  const backHome = await call('browser_evaluate', { expression: 'document.title' })
  check('selector clicks navigate back to the fixture', backHome.value === 'Companion Fixture', JSON.stringify(backHome))

  // --- side panel chat -------------------------------------------------------
  // The panel is a client: the bridge answers chat frames with a snapshot, which
  // is exactly what the Host plugin does with a real Session.
  const sentAttachments = []
  const sentApprovals = []
  const sentCancels = []
  bridge.setChatHandler(async (message) => {
    if (message.type === 'chat/open') {
      return { sessionId: 'session-test', status: 'idle', entries: [], approvals: [] }
    }
    if (message.type === 'chat/cancel') {
      sentCancels.push(message)
      return { sessionId: 'session-test', status: 'idle', entries: [] }
    }
    if (message.type === 'chat/approval') {
      sentApprovals.push(message)
      return { sessionId: 'session-test', status: 'working', entries: [] }
    }
    if (Array.isArray(message.attachments)) sentAttachments.push(...message.attachments)
    return {
      sessionId: 'session-test',
      status: 'idle',
      entries: [
        { id: 'u1', role: 'user', text: message.text },
        { id: 'a1', role: 'assistant', text: `echo: ${message.text}` }
      ]
    }
  })

  const extensionId = new URL(worker.url()).host
  const panel = await context.newPage()
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`)
  const panelConnected = await panel.waitForFunction(
    () => document.getElementById('status')?.textContent?.includes('Connected'),
    null,
    { timeout: 6000 }
  ).then(() => true).catch(() => false)
  check('side panel reports the connection', panelConnected)

  await panel.fill('#input', 'open hacker news')
  await panel.press('#input', 'Enter')
  const rendered = await panel.waitForFunction(
    () => document.querySelectorAll('.msg.assistant').length > 0,
    null,
    { timeout: 6000 }
  ).then(() => panel.evaluate(() => ({
    user: document.querySelector('.msg.user')?.textContent ?? '',
    assistant: document.querySelector('.msg.assistant')?.textContent ?? ''
  }))).catch(() => ({ user: '', assistant: '' }))
  check('side panel sends a prompt through the bridge', rendered.user === 'open hacker news', JSON.stringify(rendered))
  check('side panel renders the reply', rendered.assistant === 'echo: open hacker news', JSON.stringify(rendered))

  await panel.setInputFiles('#file', {
    name: 'note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello attachment')
  })
  await panel.waitForSelector('.pending .chip', { timeout: 5000 })
  await panel.fill('#input', 'with a file')
  await panel.press('#input', 'Enter')
  const attachmentArrived = await (async () => {
    for (let i = 0; i < 40; i += 1) {
      if (sentAttachments.length > 0) return sentAttachments[0]
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return null
  })()
  check('side panel sends attachment bytes', attachmentArrived?.name === 'note.txt' && Buffer.from(attachmentArrived.data, 'base64').toString() === 'hello attachment', JSON.stringify(attachmentArrived))

  // Approval card: the Host forwards an approval/request for this Session.
  bridge.broadcast({
    type: 'chat/approval',
    approval: { id: 'ap-1', toolName: 'bash', reason: 'Run npm test in the workspace?' }
  })
  const approvalCard = await panel.waitForSelector('.approval', { timeout: 5000 }).then(() => true).catch(() => false)
  check('approval card renders in the panel', approvalCard)
  await panel.click('.approval-actions button:not(.ghost)')
  const approvalAnswer = await (async () => {
    for (let i = 0; i < 40; i += 1) {
      if (sentApprovals.length > 0) return sentApprovals[0]
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return null
  })()
  check('approval answer reaches the Host', approvalAnswer?.id === 'ap-1' && approvalAnswer?.decision === 'allow', JSON.stringify(approvalAnswer))

  // Stop button while the agent is working.
  bridge.broadcast({ type: 'chat/status', status: 'working' })
  const stopVisible = await panel.waitForSelector('#stop:not([hidden])', { timeout: 5000 }).then(() => true).catch(() => false)
  check('stop button appears while working', stopVisible)
  await panel.click('#stop')
  const cancelArrived = await (async () => {
    for (let i = 0; i < 40; i += 1) {
      if (sentCancels.length > 0) return sentCancels[0]
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return null
  })()
  check('stop sends a cancel to the Host', Boolean(cancelArrived))
  bridge.broadcast({ type: 'chat/status', status: 'idle' })

  // A screenshot frame from the Host (what browser_screenshot broadcasts).
  const onePixelPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  bridge.broadcast({ type: 'screenshot', path: '/tmp/shot-test.png', dataUrl: onePixelPng, at: new Date().toISOString() })
  const shotRendered = await panel.waitForFunction(
    () => document.querySelectorAll('.shot img').length > 0,
    null,
    { timeout: 5000 }
  ).then(() => panel.evaluate(() => ({
    src: document.querySelector('.shot img')?.getAttribute('src')?.slice(0, 30) ?? '',
    captions: [...document.querySelectorAll('.shot figcaption')].map((node) => node.textContent),
    count: document.querySelectorAll('.shot img').length
  }))).catch(() => ({ src: '', captions: [], count: 0 }))
  check('side panel shows the screenshot inline', shotRendered.src.startsWith('data:image/png'), JSON.stringify(shotRendered))
  check('screenshot caption keeps the saved path', shotRendered.captions.includes('/tmp/shot-test.png'), JSON.stringify(shotRendered))
  check('replays the last screenshot when the panel opens', shotRendered.count >= 2, JSON.stringify(shotRendered))

  // Fallback path: the panel can ask the worker to capture the visible tab.
  const fixturePage = context.pages().find((candidate) => candidate.url().includes('127.0.0.1'))
  if (fixturePage) await fixturePage.bringToFront()
  const captured = await panel.evaluate(async () => await chrome.runtime.sendMessage({ type: 'capture' }))
  check('panel-initiated capture returns a PNG', captured?.ok === true && String(captured.dataUrl).startsWith('data:image/png'), JSON.stringify(captured).slice(0, 120))
  await panel.close()

  const closed = await call('browser_close', { tabId: opened.id })
  check('browser_close closes the tab', closed.closed === true)
} finally {
  await context.close().catch(() => {})
  await fixture.close()
  await bridge.stop()
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  await rm(shotsDir, { recursive: true, force: true }).catch(() => {})
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
