/**
 * Model-facing `browser_*` tools over the companion bridge.
 *
 * Definitions are plain registry objects rather than `defineTool(...)` values so
 * this plugin imports nothing from the DSH runtime: a locally linked plugin has
 * no node_modules of its own, and the tools registry accepts a raw definition
 * whose `parameters` are already JSON Schema.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Executable, script, and installer types must not be written by the agent. */
const BLOCKED_SAVE_EXTENSIONS = new Set([
  'app', 'command', 'sh', 'zsh', 'bash', 'bat', 'cmd', 'com', 'exe', 'msi',
  'scr', 'ps1', 'vbs', 'vbe', 'js', 'jse', 'mjs', 'cjs', 'jar', 'dmg', 'pkg',
  'deb', 'rpm', 'desktop', 'lnk', 'url', 'reg', 'hta', 'wsf', 'wsh', 'apk',
  'ipa', 'iso', 'img'
])

const SECRET_QUERY_KEY = '(?:token|access_?token|id_?token|refresh_?token|key|api[_-]?key|auth|authorization|password|passwd|secret|session|session[_-]?id|sid|code|otp|sig|signature|jwt|credential|ticket)'
const SECRET_QUERY_RE = new RegExp(`^${SECRET_QUERY_KEY}$`, 'i')
const SECRET_HASH_RE = new RegExp(`(?:^#|[&?])${SECRET_QUERY_KEY}=`, 'i')

/**
 * Redact bearer-like URL values in free-form bridge status text. The extension
 * redacts command errors at the source; this is defense in depth for an older
 * extension or an error produced on the bridge itself.
 */
function redactStatusText(value) {
  return String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
    try {
      const url = new URL(raw)
      let changed = false
      for (const key of [...url.searchParams.keys()]) {
        if (SECRET_QUERY_RE.test(key)) {
          url.searchParams.set(key, 'REDACTED')
          changed = true
        }
      }
      if (url.username || url.password) {
        url.username = 'REDACTED'
        url.password = ''
        changed = true
      }
      if (url.hash && SECRET_HASH_RE.test(url.hash)) {
        url.hash = '#REDACTED'
        changed = true
      }
      return changed ? url.toString() : raw
    } catch {
      return raw
    }
  })
}

function assertSafeSaveName(name) {
  // Windows ignores trailing dots and spaces in file names, so `evil.command.`
  // would otherwise run as `evil.command` after passing this check.
  const base = String(name || '').trim().toLowerCase().replace(/[.\s]+$/, '')
  const ext = base.includes('.') ? base.split('.').pop() : ''
  if (BLOCKED_SAVE_EXTENSIONS.has(ext)) {
    throw new Error(
      `Refusing to save a .${ext} file: executable, script, and installer file types are blocked. ` +
      'Save it yourself or use a plain data format.'
    )
  }
}

/** Every bridge method the extension implements; kept in one place for the README. */
export const METHODS = [
  'tabs.list',
  'tabs.open',
  'tabs.close',
  'tabs.activate',
  'tab.navigate',
  'tab.snapshot',
  'tab.read',
  'tab.click',
  'tab.type',
  'tab.press',
  'tab.scroll',
  'tab.waitFor',
  'tab.screenshot',
  'tab.evaluate'
]

const asJson = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

function jsonSchema(properties = {}, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

function text({ description, parameters = jsonSchema(), run, render = asJson, timeoutMs }) {
  return {
    description,
    parameters,
    output: { schema: { type: 'object' }, render },
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    execute: run
  }
}

function screenshotDir(config) {
  if (typeof config.screenshotDir === 'string' && config.screenshotDir.length > 0) return config.screenshotDir
  const home = process.env.DSH_HOME ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'browser-companion', 'screenshots')
}

function tabTarget(args) {
  return Number.isInteger(args.tabId) ? { tabId: args.tabId } : {}
}

function targetOrThrow(args, toolName) {
  if (!args.ref && !args.selector) throw new Error(`${toolName} needs either "ref" (from browser_snapshot) or "selector" (CSS).`)
  const target = {}
  if (args.ref) target.ref = args.ref
  if (args.selector) target.selector = args.selector
  return target
}

/**
 * Register every tool into the calling scope and return their disposers.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<import('./bridge.js').createBridge>} bridge
 * @param {{ allowEvaluate?: boolean }} [config]
 */
export function registerBrowserTools(ctx, bridge, config = {}) {
  const allowEvaluate = config.allowEvaluate === true
  const disposers = []

  const register = (name, definition) => {
    const tool = { name, ...definition }
    disposers.push(ctx.tools.register(tool))
  }

  register('browser_status', text({
    description:
      'Check whether the Chrome browser companion is connected, which browser it is, and where the owner-only ' +
      'pairing token file lives. The token itself is never returned; read it locally to pair. ' +
      'Call this first when any other browser tool reports that the companion is not connected.',
    run: async () => {
      const status = bridge.status()
      // Do not put the absolute home path (and therefore the username) into a
      // model-visible result; the install docs show how to expand this.
      const tokenFile = '<DSH_HOME>/storages/browser-companion.json'
      const paired = status.connected
        ? `Connected to ${status.client?.name ?? 'Chrome'} ${status.client?.version ?? ''} on port ${status.port}.`
        : `Not connected. Open Chrome, click the DSH Browser Extension extension icon, and pair it with port ${status.port}. The token is in the owner-only file below.`
      const lastError = typeof status.lastError === 'string' ? redactStatusText(status.lastError) : status.lastError
      return {
        ...status,
        lastError,
        token: status.token ? '••••••••' : null,
        tokenFile,
        summary: paired
      }
    },
    render: (args, value) => [
      {
        type: 'text',
        text: [
          value.summary,
          '',
          `bridge: ${value.bridge}${value.error ? ` (${value.error})` : ''}`,
          `port: ${value.port}`,
          `token: ${value.token ? '[redacted — read it from the token file]' : '(not set)'}`,
          `token file: ${value.tokenFile}`,
          value.client?.userAgent ? `browser: ${value.client.userAgent}` : '',
          value.lastError ? `last error: ${value.lastError}` : ''
        ].filter((line) => line !== '').join('\n')
      }
    ]
  }))

  register('browser_tabs', text({
    description:
      'List the open Chrome tabs with their ids, titles and URLs. The active tab is where browser_* tools act by default.',
    run: async (_args, exec) => ({ tabs: await bridge.call('tabs.list', {}, { signal: exec?.signal }) }),
    render: (args, value) => {
      const tabs = Array.isArray(value?.tabs) ? value.tabs : []
      return [{
        type: 'text',
        text: tabs
          .map((tab) => `${tab.active ? '*' : ' '} [${tab.id}] ${tab.title || '(untitled)'}\n    ${tab.url}`)
          .join('\n') || 'No tabs.'
      }]
    }
  }))

  register('browser_open', text({
    description:
      'Open a URL in a new Chrome tab, wait for it to load, and return the tab. ' +
      'This is the tool to use when the user wants a page opened in their browser.',
    parameters: jsonSchema(
      {
        url: { type: 'string', description: 'Absolute http(s) URL to open.' },
        active: { type: 'boolean', description: 'Focus the new tab (default true).' }
      },
      ['url']
    ),
    run: async (args, exec) => await bridge.call(
      'tabs.open',
      { url: args.url, active: args.active !== false },
      { signal: exec?.signal }
    )
  }))

  register('browser_close', text({
    description: 'Close an open Chrome tab by its id (see browser_tabs).',
    parameters: jsonSchema({ tabId: { type: 'integer', description: 'Tab id from browser_tabs.' } }, ['tabId']),
    run: async (args, exec) => await bridge.call('tabs.close', { tabId: args.tabId }, { signal: exec?.signal })
  }))

  register('browser_activate', text({
    description: 'Bring an existing Chrome tab to the foreground so the user can see it.',
    parameters: jsonSchema({ tabId: { type: 'integer', description: 'Tab id from browser_tabs.' } }, ['tabId']),
    run: async (args, exec) => await bridge.call('tabs.activate', { tabId: args.tabId }, { signal: exec?.signal })
  }))

  register('browser_navigate', text({
    description:
      'Navigate the active tab (or a tab you name) to a URL and wait for the page load to finish. ' +
      'Reuses the current tab instead of opening a new one.',
    parameters: jsonSchema(
      {
        url: { type: 'string', description: 'Absolute http(s) URL, or a hostname that defaults to https.' },
        tabId: { type: 'integer', description: 'Optional tab id; defaults to the active tab.' }
      },
      ['url']
    ),
    run: async (args, exec) => await bridge.call(
      'tab.navigate',
      { ...tabTarget(args), url: args.url },
      { signal: exec?.signal }
    )
  }))

  register('browser_snapshot', text({
    description:
      'Get a compact accessibility-style outline of the page: interactive elements, headings and their accessible ' +
      'names, each with a ref like "e12". This is how you see a page before clicking or typing. ' +
      'Refs are valid only until the next snapshot or navigation.',
    parameters: jsonSchema(
      {
        tabId: { type: 'integer', description: 'Optional tab id; defaults to the active tab.' },
        maxChars: { type: 'integer', description: 'Character budget for the outline (default 20000).' }
      },
      []
    ),
    run: async (args, exec) => await bridge.call(
      'tab.snapshot',
      { ...tabTarget(args), ...(Number.isInteger(args.maxChars) ? { maxChars: args.maxChars } : {}) },
      { signal: exec?.signal }
    ),
    render: (args, value) => [
      { type: 'text', text: `${value.url}\n${value.title}\n\n${value.text}` }
    ]
  }))

  register('browser_click', text({
    description:
      'Click an element identified by a snapshot ref or a CSS selector. Prefer refs: they survive class-name churn. ' +
      'Returns the page URL and title after the click.',
    parameters: jsonSchema(
      {
        ref: { type: 'string', description: 'Ref from the latest browser_snapshot, e.g. "e12".' },
        selector: { type: 'string', description: 'CSS selector instead of a ref.' },
        tabId: { type: 'integer', description: 'Optional tab id; defaults to the active tab.' }
      },
      []
    ),
    run: async (args, exec) => await bridge.call(
      'tab.click',
      { ...tabTarget(args), ...targetOrThrow(args, 'browser_click') },
      { signal: exec?.signal }
    )
  }))

  register('browser_type', text({
    description:
      'Type text into an input, textarea or contenteditable element, replacing its current value unless clear is false. ' +
      'Set submit to press Enter afterwards. Use browser_snapshot to find the field ref first.',
    parameters: jsonSchema(
      {
        text: { type: 'string', description: 'Text to enter.' },
        ref: { type: 'string', description: 'Ref from the latest browser_snapshot.' },
        selector: { type: 'string', description: 'CSS selector instead of a ref.' },
        clear: { type: 'boolean', description: 'Replace the existing value (default true).' },
        submit: { type: 'boolean', description: 'Submit afterwards by pressing Enter (default false).' },
        tabId: { type: 'integer', description: 'Optional tab id; defaults to the active tab.' }
      },
      ['text']
    ),
    run: async (args, exec) => await bridge.call(
      'tab.type',
      {
        ...tabTarget(args),
        ...targetOrThrow(args, 'browser_type'),
        text: args.text,
        clear: args.clear !== false,
        submit: args.submit === true
      },
      { signal: exec?.signal }
    )
  }))

  register('browser_press', text({
    description: 'Press a single key in the page, such as Enter, Escape, Tab, ArrowDown or a letter.',
    parameters: jsonSchema(
      {
        key: { type: 'string', description: 'Key name (KeyboardEvent.key) or code such as "KeyA".' },
        tabId: { type: 'integer', description: 'Optional tab id; defaults to the active tab.' }
      },
      ['key']
    ),
    run: async (args, exec) => await bridge.call(
      'tab.press',
      { ...tabTarget(args), key: args.key },
      { signal: exec?.signal }
    )
  }))

  register('browser_scroll', text({
    description: 'Scroll the page up, down, to the top, or to the bottom. Returns the resulting scroll position.',
    parameters: jsonSchema(
      {
        direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'Scroll direction.' },
        amount: { type: 'integer', description: 'Pixels for up/down (default 600).' },
        tabId: { type: 'integer', description: 'Optional tab id; defaults to the active tab.' }
      },
      ['direction']
    ),
    run: async (args, exec) => await bridge.call(
      'tab.scroll',
      { ...tabTarget(args), direction: args.direction, amount: Number.isInteger(args.amount) ? args.amount : 600 },
      { signal: exec?.signal }
    )
  }))

  register('browser_read', text({
    description:
      'Read the visible text of the page as plain text. Cheaper than a snapshot when you only need the content.',
    parameters: jsonSchema(
      {
        tabId: { type: 'integer', description: 'Optional tab id; defaults to the active tab.' },
        maxChars: { type: 'integer', description: 'Character budget (default 20000).' }
      },
      []
    ),
    run: async (args, exec) => await bridge.call(
      'tab.read',
      { ...tabTarget(args), ...(Number.isInteger(args.maxChars) ? { maxChars: args.maxChars } : {}) },
      { signal: exec?.signal }
    ),
    render: (args, value) => [
      { type: 'text', text: `${value.url}\n${value.title}\n\n${value.text}` }
    ]
  }))

  register('browser_wait_for', text({
    description: 'Wait until text appears in the page or a selector matches. Useful after actions that load content.',
    parameters: jsonSchema(
      {
        text: { type: 'string', description: 'Literal text to wait for.' },
        selector: { type: 'string', description: 'CSS selector to wait for.' },
        timeoutMs: { type: 'integer', description: 'Maximum wait (default 10000).' },
        tabId: { type: 'integer', description: 'Optional tab id; defaults to the active tab.' }
      },
      []
    ),
    run: async (args, exec) => {
      if (!args.text && !args.selector) throw new Error('browser_wait_for needs "text" or "selector".')
      return await bridge.call(
        'tab.waitFor',
        {
          ...tabTarget(args),
          ...(args.text ? { text: args.text } : {}),
          ...(args.selector ? { selector: args.selector } : {}),
          ...(Number.isInteger(args.timeoutMs) ? { timeoutMs: args.timeoutMs } : {})
        },
        { signal: exec?.signal }
      )
    }
  }))

  register('browser_screenshot', text({
    description:
      'Capture a PNG of the visible page area. Saves it to disk and returns the path, which you can pass to read_image. ' +
      'The tab is brought to the front first, so screenshots always show the live page.',
    parameters: jsonSchema(
      { tabId: { type: 'integer', description: 'Optional tab id; defaults to the active tab.' } },
      []
    ),
    run: async (args, exec) => {
      const shot = await bridge.call('tab.screenshot', tabTarget(args), { signal: exec?.signal })
      const match = /^data:image\/png;base64,(.*)$/s.exec(shot.dataUrl ?? '')
      if (!match) throw new Error('The extension returned a screenshot in an unexpected format.')
      const dir = screenshotDir(config)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const path = join(dir, `shot-${stamp}-${randomBytes(3).toString('hex')}.png`)
      const bytes = Buffer.from(match[1], 'base64')
      // A capture can show a dashboard, an inbox, a bank page. Keep it owner-only.
      await writeFile(path, bytes, { mode: 0o600 })
      // Mirror the capture to the side panel so the chat shows the page, not just
      // a file path. The panel keeps only the last few frames.
      bridge.broadcast({ type: 'screenshot', path, dataUrl: shot.dataUrl, at: new Date().toISOString() })
      return { path, bytes: bytes.length, width: shot.width ?? null, height: shot.height ?? null, url: shot.url ?? null }
    }
  }))

  register('browser_save_file', text({
    description:
      'Save text or base64 bytes as a file for the user and start a Chrome download into their Downloads folder. ' +
      'Use this when the user asks to save, export or download something you produced. The loopback URL is also ' +
      'returned, so the file can be fetched if the browser is not connected. Executable, script, and installer ' +
      'file types are refused.',
    parameters: jsonSchema(
      {
        filename: { type: 'string', description: 'Suggested file name, including an extension (e.g. "report.md").' },
        content: { type: 'string', description: 'UTF-8 text content. Pass this or contentBase64, not both.' },
        contentBase64: { type: 'string', description: 'Base64-encoded bytes, for binary files.' },
        mimeType: { type: 'string', description: 'Content type, e.g. text/markdown or application/pdf.' }
      },
      ['filename']
    ),
    run: async (args, exec) => {
      assertSafeSaveName(args.filename)
      const hasText = typeof args.content === 'string'
      const hasBase64 = typeof args.contentBase64 === 'string'
      if (hasText === hasBase64) throw new Error('Pass exactly one of content or contentBase64.')
      const data = hasBase64 ? Buffer.from(args.contentBase64, 'base64') : Buffer.from(args.content, 'utf8')
      const offered = bridge.offerFile({ filename: args.filename, mimeType: args.mimeType, data })
      let downloadId = null
      let downloadError = null
      try {
        const result = await bridge.call(
          'file.download',
          { url: offered.url, filename: offered.filename },
          { signal: exec?.signal }
        )
        downloadId = result?.downloadId ?? null
      } catch (error) {
        downloadError = String(error?.message ?? error)
      }
      const notConnected = downloadError
        ? /not connected|companion is not connected/i.test(downloadError)
        : false
      return {
        filename: offered.filename,
        url: offered.url,
        bytes: offered.bytes,
        downloaded: downloadId !== null,
        downloadId,
        note: downloadId !== null
          ? 'Chrome is downloading the file into the default Downloads folder.'
          : notConnected
            ? 'The browser is not connected; the loopback URL is valid for ten minutes.'
            : `Chrome could not start the download${downloadError ? ` (${downloadError.slice(0, 160)})` : ''}. The loopback URL is valid for ten minutes.`
      }
    },
    render: (args, value) => [{
      type: 'text',
      text: value.downloaded
        ? `Saved ${value.filename} (${value.bytes} bytes) — Chrome is downloading it.`
        : `Prepared ${value.filename} (${value.bytes} bytes). ${value.note}\n${value.url}`
    }]
  }))

  register('browser_evaluate', text({
    description:
      'Run a JavaScript expression in the page and return its JSON value. Disabled unless the deployment turns on ' +
      'allowEvaluate. Use browser_read or browser_snapshot instead whenever they suffice.',
    parameters: jsonSchema(
      {
        expression: { type: 'string', description: 'JavaScript expression, e.g. "document.title".' },
        tabId: { type: 'integer', description: 'Optional tab id; defaults to the active tab.' }
      },
      ['expression']
    ),
    run: async (args, exec) => {
      if (!allowEvaluate) {
        throw new Error('browser_evaluate is disabled. Enable it with `allowEvaluate: true` in the browser-companion config.')
      }
      return await bridge.call(
        'tab.evaluate',
        { ...tabTarget(args), expression: args.expression },
        { signal: exec?.signal }
      )
    }
  }))

  return disposers
}
