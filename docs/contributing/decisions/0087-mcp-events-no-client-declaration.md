# 0087: MCP Events need no client declaration; OAuth and the flag stay

- **Status:** accepted
- **Date:** 2026-10-29
- **Supersedes in part:** [0059](./0059-mcp-events-extension-behind-flag.md)
  (the client-declaration gate only)

## Context

[0059](./0059-mcp-events-extension-behind-flag.md) registered the MCP Events
surface only when three gates passed: the request's client declared events
support in its per-request `_meta` client capabilities (top-level `events`,
`experimental.events`, or `extensions["io.modelcontextprotocol/events"]`), the
caller was an OAuth principal, and the `mcp-events-extension` flag was on for
the user.

The
[OpenAI MCP Events profile](https://developers.openai.com/plugins/build/mcp-events)
has the server add `events: {}` to its `server/discover` capabilities, and the
client declares nothing. ChatGPT, the client this surface exists for, never
sends a declaration, so it never saw Kody's events.

## Decision

Drop the client-declaration gate. `registerMcpEvents` advertises
`capabilities.events` and serves `events/list`, `events/subscribe`, and
`events/unsubscribe` when the caller is an OAuth principal **and** the
`mcp-events-extension` flag is on for the user. Both gates cover advertising and
subscribing; otherwise nothing is registered and the methods answer
MethodNotFound. A client that still declares events support is neither required
nor treated differently. Delivery-time re-checks from 0059 (flag, subscription
liveness, connection-profile `read` grant, stamped `mcp` field) are unchanged.

The `mcp-events-clients` exposure is written when the client calls an `events/*`
method, not on every OAuth request, so clients that ignore the capability stay
outside the experiment's cohorts.

## Consequences

Every flag-on OAuth client sees `events: {}` on `server/discover`, including
hosts that do not implement events (they ignore the unknown capability). The
flag remains the rollout control; no per-client allowlist.

**Revisit-if** the MCP Events draft settles a required client-side declaration,
or a host breaks on the unknown `events` capability.
