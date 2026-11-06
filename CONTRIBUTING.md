# Contributing

Thanks for taking a look. This is a small, dependency-free package; keeping it
that way is the main design constraint.

## Setup

```sh
git clone https://github.com/rahuljaguste/dsh-browser-extension && cd dsh-browser-extension
npm install                      # playwright-core, for the e2e test only
```

Install it into a harness profile while you work:

```sh
/Applications/DeepSeek\ Harness.app/Contents/Resources/runtime/cli/bin/dsh \
  plugin --profile <profile> add link:$PWD
```

Profile layers compose at boot, so restart the app after changing Host code.
Extension code reloads with **Reload** on `chrome://extensions`.

## Tests

```sh
npm run check      # syntax check every source file
npm run test:unit  # chat + tool tests, no browser
npm run test:e2e   # real Chromium + real extension + real bridge
```

The e2e suite needs Playwright's Chromium (branded Chrome 137+ ignores
`--load-extension`):

```sh
PLAYWRIGHT_BROWSERS_PATH=../.pw-browsers \
  node node_modules/playwright-core/cli.js install chromium
```

Please keep a test for behaviour you add. The unit suites use fakes for the
Cordis context and the bridge, so they run anywhere.

## Layout

```
index.js          plugin entry: config, bridge, chat, tools
lib/ws.js         RFC 6455 server (handshake, frames, ping/pong)
lib/bridge.js     loopback socket, pairing, request/response multiplexer
lib/chat.js       sidebar Session: prompt, events, approvals, policy, backfill
lib/tools.js      browser_* tool definitions
extension/        MV3 extension: worker, page agent, popup, side panel
test/             fixture site, unit suites, e2e
```

## Style

- Plain ESM, no build step, no runtime dependencies. If you need a package,
  explain why in the PR.
- `node --check` must pass for every source file (`npm run check`).
- Comments explain *why*, not *what*; the tricky parts (masking, approval
  semantics, session event shapes) deserve a sentence.
- UI text is sentence case. Errors should say what happened and what to do next.

## Pull requests

- One concern per PR; describe the user-visible change first.
- Include the command you ran to verify, and paste the relevant output.
- Security-relevant changes (auth, permissions, paths, tool policy) get an extra
  look — see [SECURITY.md](SECURITY.md).
