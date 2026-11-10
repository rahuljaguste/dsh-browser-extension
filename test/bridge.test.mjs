/**
 * Unit tests for the bridge handshake. Real WebSocket clients, no Chrome.
 */
import { createHmac } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridge } from '../lib/bridge.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  ✓ ${name}`)
  else {
    failures += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function proof(token, role, nonce) {
  return createHmac('sha256', token).update(`${role}:${nonce}`).digest('base64url')
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

async function open(options = {}) {
  const bridge = createBridge({
    port: 0,
    home: await mkdtemp(join(tmpdir(), 'dsh-bridge-test-')),
    log: () => {},
    ...options
  })
  await bridge.start()
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/`)
  const seen = { challenge: null, welcome: null, closed: null }
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 4000)
    ws.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message?.type === 'challenge') {
        seen.challenge = message
        if (options.autoHello === false) {
          ws.send(JSON.stringify({ id: 'pre-auth', method: 'tab.read', params: {} }))
        } else {
          ws.send(JSON.stringify({
            type: 'hello',
            proof: proof(options.clientToken ?? options.token, 'client', message.nonce),
            name: 'test-client',
            version: '0'
          }))
        }
      } else if (message?.type === 'welcome') {
        seen.welcome = message
        if (options.autoReady !== false) ws.send(JSON.stringify({ type: 'ready' }))
        clearTimeout(timer)
        resolve('welcome')
      }
    }
    ws.onclose = (event) => {
      clearTimeout(timer)
      seen.closed = event.code
      resolve('closed')
    }
    ws.onerror = () => {}
  })
  return { bridge, ws, seen, done }
}

console.log('bridge handshake')
const token = 'a'.repeat(32)
const good = await open({ token, allowEvaluate: true })
const goodOutcome = await good.done
check('the server speaks first with a challenge', typeof good.seen.challenge?.nonce === 'string' && good.seen.challenge.nonce.length > 0)
check('a correct client proof is accepted', goodOutcome === 'welcome')
check(
  'the welcome proves the server knows the token',
  good.seen.welcome?.proof === proof(token, 'server', good.seen.challenge.nonce),
  good.seen.welcome?.proof
)
check('the welcome advertises the evaluate capability', good.seen.welcome?.allowEvaluate === true)
check('the bridge marks the client connected after ready', await waitUntil(() => good.bridge.status().connected === true))
good.ws.close()
good.bridge.stop()

const noEval = await open({ token })
check('evaluate is not advertised unless configured', (await noEval.done) === 'welcome' && noEval.seen.welcome?.allowEvaluate === false)
noEval.ws.close()
noEval.bridge.stop()

// The Host must not dispatch anything until the client confirms it verified
// the server proof; otherwise the async verification window drops frames.
const waiting = await open({ token, autoReady: false })
check('the bridge does not become the peer before ready', (await waiting.done) === 'welcome' && waiting.bridge.status().connected === false)
waiting.ws.send(JSON.stringify({ type: 'ready' }))
check('ready completes the connection', await waitUntil(() => waiting.bridge.status().connected === true))
waiting.ws.close()
waiting.bridge.stop()

const bad = await open({ token, clientToken: 'b'.repeat(32) })
check('a wrong client proof closes with 1008', (await bad.done) === 'closed' && bad.seen.closed === 1008, JSON.stringify(bad.seen))
check('a rejected client never becomes the peer', bad.bridge.status().connected === false)
bad.bridge.stop()

// A command sent before hello must be rejected, not queued.
const preAuth = await open({ token, autoHello: false })
check('pre-auth command is refused', (await preAuth.done) === 'closed' && preAuth.seen.closed === 1008, JSON.stringify(preAuth.seen))
preAuth.bridge.stop()

const short = createBridge({
  port: 0,
  home: await mkdtemp(join(tmpdir(), 'dsh-bridge-test-')),
  token: '1234',
  log: () => {}
})
await short.start()
check(
  'an explicit token shorter than 16 characters is refused',
  short.status().bridge === 'error' && /at least 16/.test(short.status().error ?? ''),
  JSON.stringify(short.status())
)
short.stop()

const sixteen = createBridge({
  port: 0,
  home: await mkdtemp(join(tmpdir(), 'dsh-bridge-test-')),
  token: 'a'.repeat(16),
  log: () => {}
})
await sixteen.start()
check('a 16-character explicit token is accepted', sixteen.status().bridge === 'listening', JSON.stringify(sixteen.status()))
sixteen.stop()

const silentBridge = createBridge({
  port: 0,
  home: await mkdtemp(join(tmpdir(), 'dsh-bridge-test-')),
  helloTimeoutMs: 150,
  log: () => {}
})
await silentBridge.start()
const silent = new WebSocket(`ws://127.0.0.1:${silentBridge.port}/`)
const silentResult = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve('timeout'), 3000)
  silent.onmessage = () => {}
  silent.onclose = (event) => {
    clearTimeout(timer)
    resolve(event.code)
  }
  silent.onerror = () => {}
})
check('an unauthenticated socket is closed after the handshake timeout', silentResult === 1008, String(silentResult))
silentBridge.stop()

const blocker = createServer()
await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
const busyPort = blocker.address().port
const busy = createBridge({
  port: busyPort,
  home: await mkdtemp(join(tmpdir(), 'dsh-bridge-test-')),
  log: () => {}
})
await busy.start()
check(
  'a busy port fails closed instead of shifting ports',
  busy.status().bridge === 'error' && /already in use/.test(busy.status().error ?? ''),
  JSON.stringify(busy.status())
)
busy.stop()
await new Promise((resolve) => blocker.close(resolve))

console.log(failures === 0 ? '\nALL BRIDGE CHECKS PASSED' : `\n${failures} BRIDGE CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
