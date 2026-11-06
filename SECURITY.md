# Security

## Reporting

Open a private security advisory on the repository (Security → Report a
vulnerability). Please do not open a public issue for anything that could let a
page, an extension, or a local process act on the user's browser or files without
permission.

Include: the version (`extension/manifest.json` and `package.json`), the host
platform, reproduction steps, and what you observed. You can expect an
acknowledgement within a few days.

## Trust model

Three parties are involved, and each trusts the others to a different degree.

| Party | Runs where | Can do |
|---|---|---|
| Host plugin | inside the DSH process | read/write the user's files as DSH can, run the sidebar agent, bind a loopback socket |
| Extension | inside Chrome | read and script any http(s) tab, capture the visible tab |
| Agent | a DSH Session | whatever tools the profile grants that Session |

The plugin adds no capability to the Host that DSH did not already have. The
extension adds browser control to the Host, not the reverse.

## What crosses the bridge

Only these frames: `hello`/`welcome`, `ping`/`pong`, `chat/open`, `chat/send`,
`chat/cancel`, `chat/approval`, `chat/state`, `chat/entry`, `chat/status`,
`chat/approval`, `chat/error`, `screenshot`, and command requests/results.
No environment variables, no configuration, no files are pushed unless a tool
result contains them.

## Authentication

- The bridge binds `127.0.0.1` only. `host` is fixed to loopback; there is no
  wildcard path.
- Every connection must send a 192-bit token as its first message; comparison is
  timing-safe. The token lives in `<DSH_HOME>/storages/browser-companion.json`
  with mode `0600`.
- WebSocket upgrades whose `Origin` is an `http(s)` page are refused, so a
  random web page cannot reach the socket. Local processes with no origin can
  still attempt a connection and still need the token.
- `/health` and `/state` are unauthenticated loopback debug endpoints. `/state`
  omits the token. Neither exposes credentials.

## Data at rest

| Path | Mode | Notes |
|---|---|---|
| `storages/browser-companion.json` | `0600` | pairing token + port |
| `browser-companion/chat.json` | `0600` | sidebar Session id |
| `browser-companion/screenshots/` | `0700` dir, `0600` files | captures can be sensitive |
| `browser-companion/attachments/` | `0700` dir, `0600` files | verbatim user files |

Nothing is deleted automatically. Remove those directories to clear local state.

## Known limitations, stated plainly

- **The extension requests `<all_urls>`.** It must, to script and capture tabs.
  With that permission it can read any page's DOM, including pages showing
  secrets, and it can see tab URLs (DSH's own GUI URL carries its local API
  token). The shipped code sends tab URLs only to the Host as tool results and
  never to a network. Treat a modified build of this extension as fully
  privileged over your browser.
- **The plugin runs in-process.** Any DSH plugin can read what the Host can read.
  This one does not touch `ctx.credentials`, but capability is inherent to the
  plugin model.
- **The sidebar agent inherits profile tools.** `toolPolicy` (default
  `no-shell`) removes `bash`/`pwsh`/`write`/`edit`/`terminal` from that Session;
  `browser-only` also removes `read`, `read_image`, `glob`, `grep`. `open`
  restores everything. Even under `no-shell`, `read` remains: an agent that is
  instructed to open a credential file can still do so, exactly as the main chat
  can.
- **Prompt injection.** A page can contain text that tells the agent to do
  something. The tool policy and DSH approvals are the mitigation; review
  approval cards before allowing anything.
- **`browser_evaluate`** is disabled unless `allowEvaluate: true`, and then runs
  arbitrary JavaScript in the page's main world.
- **Approvals** raised by the sidebar Session are answered from the extension. If
  nobody answers within five minutes the request is rejected (fail closed), and
  closing a turn retires outstanding cards.
