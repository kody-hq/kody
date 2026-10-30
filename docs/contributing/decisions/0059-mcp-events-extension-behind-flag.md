# 0059 — MCP Events extension (webhook profile) behind a flag

- **Status:** accepted; the client-declaration gate is superseded by
  [0087](./0087-mcp-events-no-client-declaration.md)
- **Date:** 2026-10-07

## Context

MCP clients such as ChatGPT can now subscribe to server-side events and receive
them as signed webhooks. Two documents define the shape:

- The MCP Events
  [design sketch](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md)
  (Draft, 2026-02-19): `events/list`, `events/subscribe`, `events/unsubscribe`;
  webhook, poll, and push delivery; `gap` / `terminated` control envelopes;
  error codes -32011 to -32015.
- The
  [OpenAI MCP Events profile](https://developers.openai.com/plugins/build/mcp-events):
  protocol revision 2026-07-28, webhook delivery only, Standard Webhooks
  signatures, a callback verification challenge, and a 256 KiB body cap.

Kody already has an event bus. Packages declare `kody.emits` topics, emit with
`events.dispatch`, and the `kody-package-events-dispatch` queue consumer
(`deliverPackageEvent`) fans each event out to package subscribers. The spec is
a draft, so the client capability shape is still unsettled and the SDK
(`@modelcontextprotocol/server` 2.0.0) has no types for it.

## Decision

Kody implements the **webhook-only ChatGPT profile** of the draft, pinned to the
two documents above (`mcpEventsSpecPin` in `packages/worker/src/mcp/events/`).
Poll (`events/poll`), push (`events/stream`), `gap`, and `terminated` are out of
scope.

- **Gated twice.** The `events` capability and the three methods are registered
  only when the request's client declares events support **and** the
  `mcp-events-extension` flag (`experiments_opt_in`, default off) is on for the
  user **and** the caller is an OAuth principal. The client can declare support
  as top-level `events`, `experimental.events`, or
  `extensions["io.modelcontextprotocol/events"]` in the per-request `_meta`
  client capabilities. Otherwise nothing is registered and the methods answer
  MethodNotFound. Only the stateless 2026-07-28 lane serves events. The legacy
  Durable Object lane is unchanged. The `search` / `execute` / `api` tool
  surface and the server instructions do not change.
- **Opt-in per topic.** A `kody.emits` topic is exposed only with `mcp: true`.
  Absent or `false` keeps it package-internal. The MCP event name is the package
  topic. Events take no subscription arguments (`inputSchema` is the empty
  object). The caller's saved packages are the source, filtered by the
  connection profile's `read` grants.
- **One dispatch path.** `events.dispatch` stamps `mcp: true` and `emittedAt` on
  the queue message when the declared topic opted in. The same consumer message
  that delivers to package subscribers then calls
  `fanOutPackageEventToMcpSubscriptions`. At delivery time, fan-out re-checks
  four things: the flag, the subscription's liveness and verification, its
  stored connection profile's `read` grant on the emitting package, and the
  stamped `mcp` field (an absent field fails closed). A fan-out failure is
  logged and never throws to the queue, so a dead callback cannot replay package
  subscribers.
- **Subscriptions.** Rows live in `mcp_event_subscriptions` (migration 0083).
  The subscription key is (stable user id, OAuth client id, event name,
  canonical arguments, callback URL), and the row id is a deterministic `sub_`
  hash of that key. Subscribe and refresh are the same upsert. TTL defaults to 1
  h, is clamped to [60 s, 24 h], and a `ttlMs: null` (no expiry) request gets
  the 24 h maximum. Each principal may hold 100 live subscriptions. A client
  cursor yields `truncated: true`, because package events have no replay.
- **Webhooks.** Kody signs with Standard Webhooks: `whsec_` secrets of 24-64
  bytes, encrypted at rest under a dedicated secret-store purpose. Headers are
  `webhook-id` / `webhook-timestamp` / `webhook-signature` plus
  `X-MCP-Subscription-Id`. Rotating a secret co-signs with the old one for 5
  minutes. `webhook-id` is a stable `evt_` hash of (source package, topic,
  idempotency key), so redeliveries dedupe at the receiver. Delivery makes up to
  three attempts (1 s, 4 s backoff) with a 10 s timeout. 410 and 413 are not
  retried. The outcome lands in `last_delivery_at` / `last_error`, using the
  draft's `deliveryStatus` categories.
- **Callback verification.** Before a subscription goes active, Kody POSTs a
  signed `{type: "verification", challenge}`. It requires a 2xx response that
  echoes the challenge, compared in constant time. A success covers the same
  (principal, URL) for 24 h. Failures surface as -32015 with only a category in
  `data.reason`, never the endpoint's response.
- **SSRF.** Workers cannot resolve DNS or pin `fetch` to a validated IP, so the
  draft's resolve-then-connect check is not implementable. On every outbound
  request, verification included, Kody requires https, rejects credentials,
  fragments, special-use and single-label hostnames, and non-global IPv4/IPv6
  literals, and uses `redirect: "error"` with a timeout.
- **Revoke cleanup.** Every grant revoke also deletes the matching
  subscriptions: the account OAuth-client revoke, the connected-agent revoke,
  authorize `reset-client`, and password change/reset. A shared client loses
  only that user's rows. A deleted registration loses all of its rows.
- **SDK workaround.** `ServerCapabilities` has no `events` key. Kody passes
  `{ events: {} }` through a cast to `server.server.registerCapabilities`, and
  the SDK spreads it into the `server/discover` result at runtime. The custom
  methods use the 3-arg
  `server.server.setRequestHandler(method, { params, result }, handler)` form
  with zod schemas. The SDK client's typed `getServerCapabilities()` strips the
  unknown key, so tests read `events` off the wire.

## Consequences

ChatGPT-style clients can subscribe to opted-in package topics without a second
event system, and packages control exposure per topic. The
`mcp_event_subscriptions` table is user-owned account data: it is in data
targets, and both secret columns are redacted from export.

The SSRF mitigation leaves accepted residual risk. A public hostname whose DNS
answers a private address is not caught at the URL layer. Worker egress runs on
Cloudflare's network with `global_fetch_strictly_public`, and no Tunnel or VPC
binding gives that fetch a private route.

Expired rows are pruned on `events/subscribe`, and the deliverable query filters
them out, so the hot path stays read-only. Rows per principal stay bounded by
the 100-subscription cap.

The contributor/user guide is `/docs/mcp-events` (`guide:mcp_events`), with a
signed-in self opt-in POST at `/docs/mcp-events/opt-in` (same pattern as package
sharing). The `mcp-ping` fixture under
`packages/worker/src/mcp/events/fixtures/` is the real-example package shape.

**Revisit-if** the draft settles a client capability shape, adds required
behavior to the webhook profile (for example `terminated` on revoke), or the SDK
ships typed events support. Also revisit if Workers gain DNS resolution with
connect-to-IP, so the full resolve-then-connect SSRF check becomes possible.
