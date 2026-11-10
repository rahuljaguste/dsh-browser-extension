# Changelog

## 0.9.0

- Security: the sidebar tool policy now resolves restored Sessions through
  `sessionController.resolveAgent()` before prompting; if the policy cannot be
  applied the send fails closed instead of running with the full profile.
- Security: pairing is a nonce/HMAC challenge-response. The raw token never
  crosses the socket, the extension verifies the bridge's proof before trusting
  it, commands are ignored until both proofs succeed, and the Host dispatches
  nothing until the extension confirms with `ready`. Explicit config tokens
  must be at least 16 characters. Protocol version is now 2 — update the Host
  plugin and the extension together.
- Security: the bridge no longer shifts to the next port when the configured one
  is busy; it reports an actionable error. Silent fallback let a local squatter
  on the configured port relay the handshake to the real bridge.
- Security: the extension enforces `allowEvaluate` from the authenticated
  welcome; `tab.evaluate` no longer runs for a peer that skips the Host tool.
- Security: `browser_type` no longer returns password-field values; scripting is
  limited to http(s) pages, closing the `file://` toggle gap.
- Fix: attachments are capped in aggregate (40 MB) on both sides, below the
  bridge's 64 MiB frame limit, instead of silently closing the socket.
- Fix: the MV3 worker reloads settings and reconnects on every worker start and
  uses a one-minute alarm, so it can redial after Chrome suspends it.
- Fix: `chat/error` restores the composer instead of leaving the panel stuck on
  "Working"; pending approvals are included in snapshots and survive a worker
  restart; stale element refs now fail instead of reporting a false success.
- Fix: the panel keeps its scroll position while reading history; a port-only
  popup save no longer requires re-pasting the token; smooth scrolling reports
  the settled position.
- Fix: WebSocket frames arriving with the upgrade `head` are no longer dropped;
  blank YAML numbers no longer coerce to zero.

## 0.8.0

- Renamed the repository and package to `dsh-browser-extension`; the Chrome
  extension now shows as "DSH Browser Extension".

## 0.7.0

- Renamed to `dsh-browser-companion` so it can be published to npm.
- Repository metadata, CI badge, extension icons.
- Hardening: host-side limits on message size, attachment count/bytes and base64
  validity; unique attachment names; `0700` state directory; approvals retired
  when a turn closes; WebSocket continuation-frame guard.

## 0.6.0

- Sidebar chat Session with a configurable tool policy (`no-shell` default,
  `browser-only`, `open`), applied per agent via `tools.restrict()`.
- Security: owner-only (`0600`) screenshots and saved attachments; host-side caps
  on message size, attachment count and attachment bytes; base64 validation;
  unique attachment filenames.
- Security: stale peer detection by pong timeout; socket identity guards in the
  worker.

## 0.5.0

- Stop button (`sessionController.cancel`).
- In-panel approvals with fail-closed timeout, scoped to the chat Session.
- Transcript backfill from the durable log after an app restart.
- New side-panel UI: status pill, approval cards, suggestion chips, jump to
  latest, light/dark tokens.

## 0.4.0

- Attachments: images through the attachment store, other files saved verbatim
  and referenced by path.

## 0.3.0

- Side panel hosts a chat client for a dedicated DSH Session.

## 0.2.0

- Chrome side panel with a live activity feed.

## 0.1.0

- Loopback bridge, pairing token, `browser_*` tools, MV3 extension, e2e harness.
