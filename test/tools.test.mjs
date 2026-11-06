/**
 * Tool-level tests with a fake bridge: no Chrome, no Harness.
 * Covers the screenshot write path and its file permissions.
 */
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerBrowserTools } from '../lib/tools.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  ✓ ${name}`)
  else {
    failures += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const dir = await mkdtemp(join(tmpdir(), 'companion-tools-'))
const shots = join(dir, 'shots')
const calls = []
const broadcasts = []
const onePixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const bridge = {
  async call(method, params) {
    calls.push({ method, params })
    if (method === 'tab.screenshot') return { dataUrl: onePixel, url: 'https://example.com/', title: 'Example' }
    if (method === 'tabs.list') return [{ id: 1, title: 'Example', url: 'https://example.com/', active: true }]
    return { ok: true }
  },
  broadcast(message) {
    broadcasts.push(message)
  },
  status() {
    return { bridge: 'listening', connected: true, port: 8787, token: 'test-token', client: { name: 'probe', version: '0.5.0' } }
  }
}

const definitions = new Map()
const registerBrowserTools_ctx = {
  tools: {
    register(definition) {
      definitions.set(definition.name, definition)
      return () => definitions.delete(definition.name)
    }
  }
}

registerBrowserTools(registerBrowserTools_ctx, bridge, { screenshotDir: shots })
const call = async (name, args = {}) => await definitions.get(name).execute(args, {})

console.log('tools')
check('registers the browser tools', definitions.size >= 14, `${definitions.size}`)

const shot = await call('browser_screenshot')
const fileInfo = await stat(shot.path)
check('screenshot lands in the configured directory', shot.path.startsWith(shots))
check('screenshot file is owner-only (0600)', (fileInfo.mode & 0o777) === 0o600, (fileInfo.mode & 0o777).toString(8))
const dirInfo = await stat(shots)
check('screenshot directory is owner-only (0700)', (dirInfo.mode & 0o777) === 0o700, (dirInfo.mode & 0o777).toString(8))
check('screenshot content is a PNG', (await readFile(shot.path)).subarray(1, 4).toString() === 'PNG')
check('capture is mirrored to the panel', broadcasts.some((message) => message.type === 'screenshot'))

const status = await call('browser_status')
check('status reports the connection', status.connected === true && status.port === 8787)
check('status carries the pairing token only', typeof status.token === 'string' && !('credentials' in status))

await call('browser_tabs')
check('tabs call reaches the bridge', calls.some((entry) => entry.method === 'tabs.list'))

const refused = await call('browser_click', {}).then(() => '').catch((error) => error.message)
check('click without a target explains itself', /ref|selector/.test(refused), refused)

console.log(failures === 0 ? '\nALL TOOL CHECKS PASSED' : `\n${failures} TOOL CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
