/**
 * MCP Events extension pin. Kody implements the webhook-only profile ChatGPT
 * consumes; poll (`events/poll`), push (`events/stream`), `gap`, and
 * `terminated` control envelopes are out of scope for v1.
 *
 * - Design sketch (Draft proposal, 2026-02-19):
 *   https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md
 * - ChatGPT / OpenAI profile (protocol 2026-07-28, Standard Webhooks, callback
 *   verification, 256 KiB bodies):
 *   https://developers.openai.com/plugins/build/mcp-events
 *
 * See docs/contributing/decisions/0059-mcp-events-extension-behind-flag.md
 * and docs/contributing/decisions/0087-mcp-events-no-client-declaration.md.
 */
export const mcpEventsSpecPin =
	'experimental-ext-triggers-events design sketch 2026-02-19 (draft); OpenAI MCP Events webhook profile; protocol 2026-07-28'

export const mcpEventsListMethod = 'events/list'
export const mcpEventsSubscribeMethod = 'events/subscribe'
export const mcpEventsUnsubscribeMethod = 'events/unsubscribe'

/** Complete webhook request body cap (262,144 bytes). */
export const mcpEventPayloadMaxBytes = 256 * 1024

/** Granted when the client omits `ttlMs`. */
export const mcpEventSubscriptionDefaultTtlMs = 60 * 60 * 1000
/** Upper bound on any grant, including `ttlMs: null` (no-expiry is refused). */
export const mcpEventSubscriptionMaxTtlMs = 24 * 60 * 60 * 1000
/** Floor that protects against refresh storms from tiny `ttlMs` values. */
export const mcpEventSubscriptionMinTtlMs = 60 * 1000

/** Active subscriptions one (user, OAuth client) principal may hold. */
export const mcpEventSubscriptionsPerPrincipalMax = 100

/** A successful challenge covers the same (principal, url) for this long. */
export const mcpEventCallbackVerificationTtlMs = 24 * 60 * 60 * 1000

/** Old secret keeps co-signing deliveries for this long after rotation. */
export const mcpEventSecretRotationGraceMs = 5 * 60 * 1000

export const mcpEventRequestTimeoutMs = 10_000

/**
 * Bounded in-consumer retry: one initial attempt plus one retry per delay.
 * 410 and 413 are never retried (receiver rejected this event on purpose).
 */
export const mcpEventDeliveryRetryDelaysMs: ReadonlyArray<number> = [
	1_000, 4_000,
]

export const mcpEventDeliveryConcurrency = 5

/** Draft error codes (JSON-RPC implementation-defined server range). */
export const mcpEventsErrorCodes = {
	invalidParams: -32602,
	notFound: -32011,
	forbidden: -32012,
	resourceExhausted: -32013,
	unsupported: -32014,
	callbackEndpointError: -32015,
} as const

/** `deliveryStatus.lastError` / `-32015 data.reason` categories. */
export type McpEventDeliveryErrorCategory =
	| 'connection_refused'
	| 'timeout'
	| 'tls_error'
	| 'http_4xx'
	| 'http_5xx'
	| 'challenge_failed'
