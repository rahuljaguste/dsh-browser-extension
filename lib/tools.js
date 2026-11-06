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
      'Check whether the Chrome browser companion is connected, which browser it is, and the pairing token. ' +
      'Call this first when any other browser tool reports that the companion is not connected.',
    run: async () => {
      const status = bridge.status()
      const paired = status.connected
        ? `Connected to ${status.client?.name ?? 'Chrome'} ${status.client?.version ?? ''} on port ${status.port}.`
        : `Not connected. Open Chrome, click the DSH Browser Extension extension icon, and pair it with port ${status.port} and the token below.`
      return { ...status, summary: paired }
    },
    render: (args, value) => [
      {
        type: 'text',
        text: [
          value.summary,
          '',
          `bridge: ${value.bridge}${value.error ? ` (${value.error})` : ''}`,
          `port: ${value.port}`,
          `token: ${value.token}`,
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
