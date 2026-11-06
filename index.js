/**
 * DSH Browser Extension — Host half.
 *
 * Registers the `browser_*` tools and runs the loopback bridge that a Chrome
 * extension dials. The extension half lives in `./extension`; a browser tab is
 * never required for the tools to exist, only for them to succeed.
 *
 * Failure here must never take the harness down: the bridge catches listen
 * errors and reports them through `browser_status` instead of throwing at boot.
 */
import { homedir } from 'node:os'
import { createBridge } from './lib/bridge.js'
import { createChat } from './lib/chat.js'
import { registerBrowserTools } from './lib/tools.js'

/** Plugin name registered with the Loader. */
export const name = 'browser-companion'

/** Host services this plugin consumes. */
export const inject = ['tools']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const port = Number.isFinite(Number(config.port)) ? Number(config.port) : 8787
  const bridge = createBridge({
    port,
    ...(typeof config.token === 'string' && config.token.length > 0 ? { token: config.token } : {}),
    ...(Number.isFinite(Number(config.commandTimeoutMs)) ? { commandTimeoutMs: Number(config.commandTimeoutMs) } : {})
  })

  ctx.effect(() => {
    void bridge.start()
    return () => bridge.stop()
  })

  const chat = createChat({
    ctx,
    cwd: typeof config.chatCwd === 'string' && config.chatCwd.length > 0 ? config.chatCwd : homedir(),
    ...(typeof config.attachmentDir === 'string' && config.attachmentDir.length > 0 ? { attachmentDir: config.attachmentDir } : {}),
    ...(typeof config.toolPolicy === 'string' ? { toolPolicy: config.toolPolicy } : {})
  })

  ctx.effect(() => {
    const off = chat.subscribe((message) => bridge.broadcast(message))
    return () => {
      off()
      chat.dispose()
    }
  })

  bridge.setChatHandler(async (message) => {
    if (message.type === 'chat/open') {
      await chat.prepare()
      return chat.snapshot()
    }
    if (message.type === 'chat/cancel') {
      await chat.cancel()
      return chat.snapshot()
    }
    if (message.type === 'chat/approval') {
      chat.answerApproval(message.id, message.decision)
      return chat.snapshot()
    }
    await chat.send(message.text, message.attachments)
    return chat.snapshot()
  })

  ctx.effect(() => {
    const disposers = registerBrowserTools(ctx, bridge, {
      allowEvaluate: config.allowEvaluate === true,
      ...(typeof config.screenshotDir === 'string' ? { screenshotDir: config.screenshotDir } : {})
    })
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // A disposed scope may already have unregistered it.
        }
      }
    }
  })
}
