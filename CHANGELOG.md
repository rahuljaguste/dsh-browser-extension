# Changelog

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
