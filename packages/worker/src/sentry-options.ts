import { type CloudflareOptions } from '@sentry/cloudflare'
import { type ErrorEvent, type EventHint } from '@sentry/core'
import { redactKodyCredentials } from '@kody-internal/shared/api-token-format.ts'
import { getErrorCauseChain } from '@kody-internal/shared/error-message.ts'
import { isRetryableD1LockSentryEvent } from './d1-retry.ts'
import { isCloudflareKvTransientHttpErrorMessage } from './cloudflare-kv-platform-error.ts'
import { isCloudflareOpaqueInternalErrorMessage } from './cloudflare-opaque-internal-error.ts'
import { isCimdUnknownClientSentryMessage } from './oauth-cimd-error.ts'
import {
	isComputeOverageLimitError,
	isEntitlementLimitError,
} from './entitlements/errors.ts'
import { isIntegrationTokenRefreshCallerMessage } from './integrations/token-refresh.ts'
import {
	isArtifactsGitTransientErrorMessage,
	isArtifactsGitTransientRemapError,
} from './repo/artifacts-git-retry.ts'
import {
	isArtifactsGitReadTimeoutMessage,
	isArtifactsOpaqueInternalRetryMessage,
	isArtifactsRepoLookupTimeoutMessage,
	isSourceRecoveryOpaqueInternalErrorMessage,
} from './repo/source-safety-policy.ts'
import { isUserCodeError } from './user-code-error.ts'

export {
	cloudflareArtifactsOpaqueInternalErrorMessage,
	cloudflareOpaqueInternalErrorMessage,
	isCloudflareOpaqueInternalErrorMessage,
} from './cloudflare-opaque-internal-error.ts'

function sentryEventMessages(event: ErrorEvent) {
	return [
		event.message,
		...(event.exception?.values?.map((value) => value.value) ?? []),
	]
}

export function redactKodyCredentialsInSentryEvent(
	event: ErrorEvent,
): ErrorEvent {
	if (typeof event.message === 'string') {
		event.message = redactKodyCredentials(event.message)
	}

	const logentry = event.logentry
	if (typeof logentry?.message === 'string') {
		logentry.message = redactKodyCredentials(logentry.message)
	}

	for (const exception of event.exception?.values ?? []) {
		if (typeof exception.value === 'string') {
			exception.value = redactKodyCredentials(exception.value)
		}
	}

	const request = event.request
	if (request) {
		if (typeof request.url === 'string') {
			request.url = redactConnectTicket(request.url)
		}
		if (typeof request.query_string === 'string') {
			request.query_string = redactConnectTicket(request.query_string)
		}
	}

	return event
}

/** Execution context connect tickets are bearer secrets in a query param. */
export function redactConnectTicket(value: string) {
	return value.replace(/([?&]|^)ticket=[^&#\s]*/g, '$1ticket=[redacted]')
}

/**
 * Shared Sentry options for the Cloudflare Worker and Durable Objects.
 * `dsn` may be undefined when Sentry is not configured (local dev / opt-out).
 */
export function filterRetryableD1LockSentryEvent(
	event: ErrorEvent,
	hint?: EventHint,
) {
	if (!isRetryableD1LockSentryEvent(event, hint)) return event
	return null
}

/**
 * Primary drop path for user-authored failures. Boundaries that know the code
 * is user-supplied throw `UserCodeError`; `beforeSend` receives that as
 * `hint.originalException` (including when wrapped further up the cause chain).
 */
export function filterUserCodeErrorSentryEvent(
	_event: ErrorEvent,
	hint?: EventHint,
) {
	if (isUserCodeError(hint?.originalException)) return null
	return _event
}

/**
 * Plan-limit denials are expected account policy outcomes (clean up usage or
 * upgrade), not platform defects. MCP observability already skips them via
 * `isCallerFailure`; this `beforeSend` gate is the backstop for any other
 * capture path that still forwards the typed error.
 */
export function isEntitlementLimitErrorSentryEvent(
	event: ErrorEvent,
	hint?: EventHint,
) {
	if (
		getErrorCauseChain(hint?.originalException).some(
			(error) =>
				isEntitlementLimitError(error) || isComputeOverageLimitError(error),
		)
	) {
		return true
	}
	return (
		event.exception?.values?.some(
			(value) =>
				value.type === 'EntitlementLimitError' ||
				value.type === 'ComputeOverageLimitError',
		) ?? false
	)
}

export function filterEntitlementLimitErrorSentryEvent(
	event: ErrorEvent,
	hint?: EventHint,
) {
	if (!isEntitlementLimitErrorSentryEvent(event, hint)) return event
	return null
}

/**
 * Runtime bundling of caller-supplied modules (MCP execute, inline workflows)
 * puts source under `.__kody_root__/`. When that source is invalid, esbuild
 * throws `Build failed with … virtual:.__kody_root__/…`. Those are user-module
 * mistakes, not platform defects — MCP execute already routes them as sandbox
 * errors, but workflow instrumentation still auto-captures the rethrow.
 *
 * Backstop for paths that cannot throw `UserCodeError` (e.g. bundler failures
 * that escape before a marked wrap). Prefer marking at the boundary.
 */
export function isUserModuleBundlerFailureSentryEvent(event: ErrorEvent) {
	return sentryEventMessages(event).some(
		(message) =>
			typeof message === 'string' &&
			message.includes('Build failed with') &&
			message.includes('.__kody_root__/'),
	)
}

export function filterUserModuleBundlerFailureSentryEvent(event: ErrorEvent) {
	if (!isUserModuleBundlerFailureSentryEvent(event)) return event
	return null
}

/**
 * Leading phrase of the message emitted by the execute sandbox when caller
 * code exceeds `timeoutMs` (`packages/worker/src/mcp/executor.ts`). The
 * executor injects the enforced budget after this phrase (`Execution timed
 * out after 90s: …` via `createExecutorSandboxTimeoutMessage`) so consumers
 * can tell a 90s ad hoc execute cut from a 300s background (job, async
 * webhook, workflow-step) cut.
 */
export const executorSandboxTimeoutMessagePrefix = 'Execution timed out'

/**
 * Abort-semantics explanation carried by every sandbox timeout message:
 * nested work is asked to abort, but already-started side effects may still
 * complete, so retries need idempotency.
 */
export const executorSandboxTimeoutMessageExplanation =
	': Kody stopped observing the sandbox. Nested work was asked to abort, but already-started remote work and side effects may still complete. Do not retry side-effecting work without an idempotencyKey; recover with runGet or replay the same idempotencyKey.'

/**
 * Budget-less form of the sandbox timeout message. Inline workflows rethrow
 * timeout strings as `UserCodeError`; `instrumentWorkflowWithSentry` then
 * auto-captures them. MCP execute already skips sandbox failures via
 * `sandboxError`, but workflow instrumentation still reports the rethrow.
 * Other platform timeouts use different wording (Kit, webhook, snapshot, …).
 *
 * Backstop for unmarked timeout rethrows. Prefer `UserCodeError` at the
 * boundary; keep this in sync with `createExecutorSandboxTimeoutMessage` in
 * `mcp/executor.ts`.
 */
export const executorSandboxTimeoutMessage = `${executorSandboxTimeoutMessagePrefix}${executorSandboxTimeoutMessageExplanation}`

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Anchored on purpose: wrapped forms (for example `Error: Execution timed
 * out`) are rethrows from other layers and must keep reaching Sentry. The
 * budget and the explanation are each optional so timeout messages from
 * older deployments (bare `Execution timed out`) stay filtered too.
 */
const executorSandboxTimeoutMessagePattern = new RegExp(
	`^${executorSandboxTimeoutMessagePrefix}(?: after \\d+(?:\\.\\d+)?m?s)?(?:${escapeRegExp(executorSandboxTimeoutMessageExplanation)})?$`,
)

export function isExecutorSandboxTimeoutMessage(message: string | undefined) {
	return (
		message !== undefined && executorSandboxTimeoutMessagePattern.test(message)
	)
}

export function isExecutorSandboxTimeoutSentryEvent(event: ErrorEvent) {
	return sentryEventMessages(event).some(isExecutorSandboxTimeoutMessage)
}

export function filterExecutorSandboxTimeoutSentryEvent(event: ErrorEvent) {
	if (!isExecutorSandboxTimeoutSentryEvent(event)) return event
	return null
}

/**
 * OAuth token-refresh caller state (no refresh token on the connection,
 * provider HTTP 4xx / invalid_grant, missing secrets). MCP observability
 * already skips them via `isCallerFailure`; this `beforeSend` gate is the
 * backstop for any other capture path that still forwards the plain Error.
 */
export function isIntegrationTokenRefreshCallerSentryEvent(event: ErrorEvent) {
	return sentryEventMessages(event).some(
		(message) =>
			typeof message === 'string' &&
			isIntegrationTokenRefreshCallerMessage(message),
	)
}

export function filterIntegrationTokenRefreshCallerSentryEvent(
	event: ErrorEvent,
) {
	if (!isIntegrationTokenRefreshCallerSentryEvent(event)) return event
	return null
}

/**
 * Exact Cloudflare Durable Object platform-reset messages. When a DO hits its
 * memory or CPU limit, when DO SQLite's allocator fails with SQLITE_NOMEM
 * before the isolate hard cap (KODY-65 / KODY-66), when a deploy replaces DO
 * code under an in-flight RPC/alarm (for example cron `oauth_purge_expired` →
 * OAuthPurgeCoordinator), when `blockConcurrencyWhile` exceeds its ~30s
 * deadlock timeout (for example PartyServer awaiting MCP Agent `onStart` via
 * `getServerByName` → `setName`), when a DO SQLite storage operation exceeds
 * the platform timeout and resets the object, when DO SQLite storage hits an
 * opaque internal fault and resets the object, or when an in-flight RPC's
 * target instance is evicted or replaced ("no longer active"), the platform
 * surfaces one of these errors to the caller. The next call gets a fresh
 * isolate / storage handle; app-level retry of non-idempotent work is still
 * unsafe, and moving heavy Agent/MCP startup out of `onStart` is an
 * architectural change outside a triage fix. Match only the bare platform
 * strings (optional `Error:` / `D1_ERROR:` prefixes — KODY-A9 — Agents SDK
 * `SQL query failed:` SqlError prefix — KODY-B9 — plus the storage form that
 * requires a support `reference =` token) so wrapped failures such as
 * exhausted `packagePublishExternalPush` recovery messages stay visible.
 */
export const durableObjectIsolateMemoryResetMessage =
	"Durable Object's isolate exceeded its memory limit and was reset."

export const durableObjectIsolateCpuResetMessage =
	'Durable Object exceeded its CPU time limit and was reset.'

/**
 * Cloudflare Durable Object SQLite allocator OOM (KODY-65 UserMeter lease
 * acquire; KODY-66 Agents `_ensureSchema` / `addColumnIfNotExists`). Same
 * resource-limit class as the isolate memory reset string: SQLite gives up
 * before workerd's hard isolate cap, so the platform surfaces
 * `out of memory: SQLITE_NOMEM` instead of "exceeded its memory limit".
 * Match this bare SQLite phrasing and the Agents SDK SqlError wrapper
 * (`SQL query failed: out of memory: SQLITE_NOMEM` — KODY-B9) so wrapped
 * recovery messages and unrelated `…: SQLITE_*` / `SQL query failed: …`
 * caller SQL failures stay Sentry-visible.
 */
export const durableObjectSqliteOutOfMemoryMessage =
	'out of memory: SQLITE_NOMEM.'

/**
 * Leading phrase the Cloudflare Agents SDK `SqlError` prepends when
 * `Agent.sql` / DO SQLite throws (`node_modules/agents` `sql-error.ts`:
 * ``SQL query failed: ${cause.message}``). Strip only this exact wrapper
 * so a bare platform reset underneath still classifies as a DO isolate
 * reset while `SQL query failed: <other SQLITE_* or caller text>` stays
 * visible.
 */
export const agentsSdkSqlErrorMessagePrefix = 'SQL query failed:'

export const durableObjectCodeUpdatedResetMessage =
	'Durable Object reset because its code was updated.'

export const durableObjectBlockConcurrencyWhileTimeoutResetMessage =
	'A call to blockConcurrencyWhile() in a Durable Object waited for too long. The call was canceled and the Durable Object was reset.'

/**
 * Cloudflare Durable Object SQLite storage operation timeout that resets the
 * object (KODY-CLOUDFLARE-3M). Same platform-reset class as memory/CPU /
 * blockConcurrencyWhile timeouts — not an application defect.
 */
export const durableObjectStorageOperationTimeoutResetMessage =
	'Durable Object storage operation exceeded timeout which caused object to be reset.'

/**
 * Cloudflare closes an in-flight Durable Object RPC when that instance is
 * evicted, replaced, or otherwise no longer current. The platform string
 * itself says to reconnect or retry; the next stub call lands on a fresh
 * instance. Same class as deploy-time "code was updated" resets — not an
 * application defect. Observed on package workflows as a misclassified
 * `UserCodeError` (`execution_failed`) when this string was unrecognized.
 */
export const durableObjectInstanceInactiveCloseMessage =
	'Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.'

/**
 * Cloudflare Durable Object SQLite storage opaque platform fault with a
 * support reference. Two platform phrasings (KODY-82 / KODY-95):
 * - `Internal error in Durable Object storage caused object to be reset; reference = <id>`
 * - `Internal error while starting up Durable Object storage caused object to be reset; reference = <id>`
 * D1 bindings can surface the same DO-storage reset under optional `Error:` /
 * `D1_ERROR:` prefixes. Same class as D1's `Internal error in D1 DB storage
 * caused object to be reset` (see `d1-retry.ts`): not an application defect —
 * DO storage hit an internal fault (including during storage startup). Require
 * `reference =` and one of these anchored sentences so bare / unrelated
 * "Durable Object storage …" or "Internal error while …" messages stay
 * Sentry-visible. Reference ids use the same alphabet as D1: alphanumeric,
 * plus `_` or `-`.
 */
const durableObjectStorageObjectResetPattern =
	/^internal error (?:in|while starting up) Durable Object storage caused object to be reset;\s*reference\s*=\s*[A-Za-z0-9_-]+$/i

/**
 * Strip the same optional platform prefixes D1 bindings attach (`Error:` then
 * `D1_ERROR:`) and the Agents SDK `SqlError` prefix (`SQL query failed:`)
 * before matching exact DO isolate-reset sentences. D1 is DO-backed, so
 * deploy/code-updated resets can arrive as
 * `D1_ERROR: Durable Object reset because its code was updated.` (KODY-A9).
 * Agents DO SQLite surfaces the same resets as
 * `SQL query failed: out of memory: SQLITE_NOMEM` (KODY-B9). Same `Error:` /
 * `D1_ERROR:` order as `stripD1ErrorPrefixes` in `d1-retry.ts`, then the
 * Agents SqlError phrase.
 */
function normalizeDurableObjectIsolateResetMessage(message: string) {
	const withoutErrorPrefix = message
		.trim()
		.replace(/^Error:\s*/i, '')
		.replace(/^D1_ERROR:\s*/i, '')
		// Agents SDK SqlError (`agentsSdkSqlErrorMessagePrefix`).
		.replace(/^SQL query failed:\s*/i, '')
	return withoutErrorPrefix.endsWith('.')
		? withoutErrorPrefix
		: `${withoutErrorPrefix}.`
}

/**
 * Strip the same optional platform prefixes D1 bindings attach (`Error:` then
 * `D1_ERROR:`) before matching the anchored DO-storage reset sentence. Same
 * order as `stripD1ErrorPrefixes` in `d1-retry.ts`.
 */
function normalizeDurableObjectStorageObjectResetMessage(message: string) {
	return message
		.trim()
		.replace(/^Error:\s*/i, '')
		.replace(/^D1_ERROR:\s*/i, '')
}

export function isDurableObjectStorageObjectResetMessage(message: string) {
	return durableObjectStorageObjectResetPattern.test(
		normalizeDurableObjectStorageObjectResetMessage(message),
	)
}

/**
 * Memory/CPU isolate resets and DO SQLite SQLITE_NOMEM only. Isolated
 * throwaway runners remap these to actionable "package too large" outcomes;
 * deploy resets ("code was updated") and other platform resets must keep
 * propagating so idempotent callers can retry on a fresh isolate.
 */
export function isDurableObjectIsolateResourceLimitResetMessage(
	message: string,
) {
	const normalized = normalizeDurableObjectIsolateResetMessage(message)
	return (
		normalized === durableObjectIsolateMemoryResetMessage ||
		normalized === durableObjectIsolateCpuResetMessage ||
		normalized === durableObjectSqliteOutOfMemoryMessage
	)
}

export function isDurableObjectIsolateResetMessage(message: string) {
	const normalized = normalizeDurableObjectIsolateResetMessage(message)
	return (
		isDurableObjectIsolateResourceLimitResetMessage(message) ||
		normalized === durableObjectCodeUpdatedResetMessage ||
		normalized === durableObjectBlockConcurrencyWhileTimeoutResetMessage ||
		normalized === durableObjectStorageOperationTimeoutResetMessage ||
		normalized === durableObjectInstanceInactiveCloseMessage ||
		isDurableObjectStorageObjectResetMessage(message)
	)
}

export function isDurableObjectIsolateResetSentryEvent(event: ErrorEvent) {
	const messages = sentryEventMessages(event).filter(
		(message): message is string =>
			typeof message === 'string' && message.trim().length > 0,
	)
	// Drop only when every reported message is a bare reset. A chained cause
	// that pairs a recovery/wrapper value with an inner reset must stay visible.
	return (
		messages.length > 0 &&
		messages.every((message) => isDurableObjectIsolateResetMessage(message))
	)
}

export function filterDurableObjectIsolateResetSentryEvent(event: ErrorEvent) {
	if (!isDurableObjectIsolateResetSentryEvent(event)) return event
	return null
}

/**
 * Cloudflare Durable Object queue saturation when a single instance cannot keep
 * up with incoming RPC/fetch work. Four exact platform phrasings (see DO
 * troubleshooting docs). Not an application defect — the DO input gate is
 * saturated. Same Sentry-drop class as D1 queue overload blips; unlike isolate
 * resets, Cloudflare marks these `.overloaded` and recommends not retrying into
 * a hot queue. Match only these bare platform strings (optional `Error:`
 * prefix / trailing period) so wrapped recovery messages stay visible.
 */
export const durableObjectOverloadedRequestsQueuedTooLongMessage =
	'Durable Object is overloaded. Requests queued for too long.'

export const durableObjectOverloadedTooManyRequestsQueuedMessage =
	'Durable Object is overloaded. Too many requests queued.'

export const durableObjectOverloadedTooMuchDataQueuedMessage =
	'Durable Object is overloaded. Too much data queued.'

export const durableObjectOverloadedTooManyRequestsTenSecondWindowMessage =
	'Durable Object is overloaded. Too many requests for the same object within a 10 second window.'

const durableObjectOverloadedMessages = [
	durableObjectOverloadedRequestsQueuedTooLongMessage,
	durableObjectOverloadedTooManyRequestsQueuedMessage,
	durableObjectOverloadedTooMuchDataQueuedMessage,
	durableObjectOverloadedTooManyRequestsTenSecondWindowMessage,
] as const

function normalizeDurableObjectOverloadedMessage(message: string) {
	const withoutErrorPrefix = message.trim().replace(/^Error:\s*/i, '')
	return withoutErrorPrefix.endsWith('.')
		? withoutErrorPrefix
		: `${withoutErrorPrefix}.`
}

export function isDurableObjectOverloadedMessage(message: string) {
	const normalized = normalizeDurableObjectOverloadedMessage(message)
	return durableObjectOverloadedMessages.some(
		(expected) => normalized === expected,
	)
}

export function isDurableObjectOverloadedSentryEvent(event: ErrorEvent) {
	const messages = sentryEventMessages(event).filter(
		(message): message is string =>
			typeof message === 'string' && message.trim().length > 0,
	)
	return (
		messages.length > 0 &&
		messages.every((message) => isDurableObjectOverloadedMessage(message))
	)
}

export function filterDurableObjectOverloadedSentryEvent(event: ErrorEvent) {
	if (!isDurableObjectOverloadedSentryEvent(event)) return event
	return null
}

/**
 * Bare Cloudflare platform "internal error" with no support reference and no
 * app context. Observed on `repoOpenSession` when Durable Object / Artifacts
 * infrastructure fails opaquely (KODY-CLOUDFLARE-4H) and on Artifacts REST
 * during package source-safety checks (KODY-8F). Matcher lives in
 * `cloudflare-opaque-internal-error.ts` so repo/ source-safety can share it
 * without importing this Sentry options module.
 *
 * Drop when every non-empty exception / message value is one of:
 * - the bare opaque Cloudflare / Artifacts sentence
 * - the source-safety retry wrapper for that blip
 * - a source-recovery wrap whose reason is that opaque sentence
 *
 * Real recovery wraps (missing snapshot, HEAD mismatch, repo not found, …)
 * stay Sentry-visible.
 */
export function isDroppableCloudflareOpaqueInternalErrorMessage(
	message: string,
) {
	return (
		isCloudflareOpaqueInternalErrorMessage(message) ||
		isArtifactsOpaqueInternalRetryMessage(message) ||
		isSourceRecoveryOpaqueInternalErrorMessage(message)
	)
}

export function isCloudflareOpaqueInternalErrorSentryEvent(event: ErrorEvent) {
	const messages = sentryEventMessages(event).filter(
		(message): message is string =>
			typeof message === 'string' && message.trim().length > 0,
	)
	return (
		messages.length > 0 &&
		messages.every((message) =>
			isDroppableCloudflareOpaqueInternalErrorMessage(message),
		)
	)
}

export function filterCloudflareOpaqueInternalErrorSentryEvent(
	event: ErrorEvent,
) {
	if (!isCloudflareOpaqueInternalErrorSentryEvent(event)) return event
	return null
}

/**
 * Cloudflare Artifacts git protocol HTTP 5xx / 429 after REST auth already
 * succeeded (KODY-CLOUDFLARE-4Y / 4Z / 50), and isomorphic-git packfile
 * corruption when upload-pack returns a bad pack body (KODY-CLOUDFLARE-55 /
 * 56). Call sites retry briefly; exhausted HTTP failures keep the stable
 * `Artifacts listServerRefs|git fetch|git clone failed for …: HTTP Error: NNN`
 * wrapper, the same operations timing out (`Artifacts git request timed out
 * after Nms`), and packfile corruption. Packfile corruption is matched by its
 * unique phrase even when bare (clone paths historically threw unwrapped
 * InternalError).
 *
 * Also drops source-safety remaps of Artifacts repo-lookup and git-HEAD
 * timeouts (`TimeoutError` / ArtifactsGitTimeoutError) so a lookup stall is
 * not labeled a git failure and neither opens Sentry issues.
 *
 * Open API / MCP map exhausted transient Artifacts git failures to
 * `ApiError` (`internal_error`, HTTP 503) with the wrapper as `cause`
 * (KODY-8P). Match `hint.originalException` through the cause chain so those
 * remapped events stay filtered the same way as the raw wrapper.
 */
export function isArtifactsGitTransientHttpErrorSentryEvent(
	event: ErrorEvent,
	hint?: EventHint,
) {
	if (isArtifactsGitTransientRemapError(hint?.originalException)) return true
	return sentryEventMessages(event).some(
		(message) =>
			typeof message === 'string' &&
			(isArtifactsGitTransientErrorMessage(message) ||
				isArtifactsGitReadTimeoutMessage(message) ||
				isArtifactsRepoLookupTimeoutMessage(message)),
	)
}

export function filterArtifactsGitTransientHttpErrorSentryEvent(
	event: ErrorEvent,
	hint?: EventHint,
) {
	if (!isArtifactsGitTransientHttpErrorSentryEvent(event, hint)) return event
	return null
}

/**
 * Bare Durable Object abort reason from Cloudflare Agents MCP session
 * teardown (`ctx.abort("destroyed")` inside `Agent.destroy()` /
 * `_cf_scheduleDestroy`). Observed on `/mcp` when a Streamable-HTTP client
 * DELETEs its session (or a concurrent request races the abort) —
 * KODY-CLOUDFLARE-4K. Same class as other DO platform-reset strings: not an
 * application defect. Match only the exact abort token (optional `Error:`
 * prefix / trailing period) so wrapped forms such as "stream was destroyed"
 * or "Cannot call write after a stream was destroyed" stay Sentry-visible.
 */
export const mcpAgentSessionDestroyedAbortMessage = 'destroyed'

function normalizeMcpAgentSessionDestroyedAbortMessage(message: string) {
	const withoutErrorPrefix = message.trim().replace(/^Error:\s*/i, '')
	return withoutErrorPrefix.endsWith('.')
		? withoutErrorPrefix.slice(0, -1)
		: withoutErrorPrefix
}

export function isMcpAgentSessionDestroyedAbortMessage(message: string) {
	return (
		normalizeMcpAgentSessionDestroyedAbortMessage(message) ===
		mcpAgentSessionDestroyedAbortMessage
	)
}

export function isMcpAgentSessionDestroyedAbortSentryEvent(event: ErrorEvent) {
	const messages = sentryEventMessages(event).filter(
		(message): message is string =>
			typeof message === 'string' && message.trim().length > 0,
	)
	return (
		messages.length > 0 &&
		messages.every((message) => isMcpAgentSessionDestroyedAbortMessage(message))
	)
}

export function filterMcpAgentSessionDestroyedAbortSentryEvent(
	event: ErrorEvent,
) {
	if (!isMcpAgentSessionDestroyedAbortSentryEvent(event)) return event
	return null
}

/**
 * CIMD metadata lookup failures the OAuth provider already maps to
 * unknown-client / invalid_client (KODY-6K / KODY-6M). Probe traffic,
 * mistyped client_id URLs, and upstream 404 / timeout are not platform
 * defects. Match only the bare prefixes emitted by `onError` and
 * `CimdFetchError` so wrapped recovery messages stay visible.
 */
export function isCimdUnknownClientSentryEvent(event: ErrorEvent) {
	const messages = sentryEventMessages(event).filter(
		(message): message is string =>
			typeof message === 'string' && message.trim().length > 0,
	)
	return (
		messages.length > 0 &&
		messages.every((message) => isCimdUnknownClientSentryMessage(message))
	)
}

export function filterCimdUnknownClientSentryEvent(event: ErrorEvent) {
	if (!isCimdUnknownClientSentryEvent(event)) return event
	return null
}

/**
 * Bare Workers KV binding HTTP 5xx / 429 (KODY-7W). Observed on
 * `POST /oauth/token` refresh when `@cloudflare/workers-oauth-provider`
 * persists the rotated grant or access token to `OAUTH_KV`
 * (`saveGrantWithTTL` / token `put` inside `handleRefreshTokenGrant`). The
 * provider remaps only 429 to `temporarily_unavailable`; 5xx rethrow and
 * `origin-handler` captures them. Best-effort refresh-family snapshots in
 * `BUNDLE_ARTIFACTS_KV` can throw the same binding string. Retrying the
 * provider grant from our wrapper is not safe (grant `put` then token `put`;
 * a 500 after the grant write would rotate again). Match only the bare
 * binding sentence so wrapped recovery stays visible.
 */
export function isCloudflareKvTransientHttpErrorSentryEvent(event: ErrorEvent) {
	const messages = sentryEventMessages(event).filter(
		(message): message is string =>
			typeof message === 'string' && message.trim().length > 0,
	)
	return (
		messages.length > 0 &&
		messages.every((message) =>
			isCloudflareKvTransientHttpErrorMessage(message),
		)
	)
}

export function filterCloudflareKvTransientHttpErrorSentryEvent(
	event: ErrorEvent,
) {
	if (!isCloudflareKvTransientHttpErrorSentryEvent(event)) return event
	return null
}

export function filterSentryEvent(event: ErrorEvent, hint?: EventHint) {
	// Marker first: primary mechanism for user-authored failures.
	if (filterUserCodeErrorSentryEvent(event, hint) === null) return null
	if (filterEntitlementLimitErrorSentryEvent(event, hint) === null) return null
	if (filterRetryableD1LockSentryEvent(event, hint) === null) return null
	// String-match backstops for paths that cannot yet be marked.
	if (filterUserModuleBundlerFailureSentryEvent(event) === null) return null
	if (filterExecutorSandboxTimeoutSentryEvent(event) === null) return null
	if (filterIntegrationTokenRefreshCallerSentryEvent(event) === null)
		return null
	if (filterDurableObjectIsolateResetSentryEvent(event) === null) return null
	if (filterDurableObjectOverloadedSentryEvent(event) === null) return null
	if (filterCloudflareOpaqueInternalErrorSentryEvent(event) === null)
		return null
	if (filterArtifactsGitTransientHttpErrorSentryEvent(event, hint) === null)
		return null
	if (filterMcpAgentSessionDestroyedAbortSentryEvent(event) === null)
		return null
	if (filterCimdUnknownClientSentryEvent(event) === null) return null
	if (filterCloudflareKvTransientHttpErrorSentryEvent(event) === null)
		return null
	return redactKodyCredentialsInSentryEvent(event)
}

/**
 * Resolve the Worker ingest DSN. Wrangler `env.test` (workers-unit, mcp-e2e,
 * Playwright e2e) must never ingest, even when a developer's
 * `packages/worker/.env` carries a real `SENTRY_DSN` — the pool logs "Using
 * secrets defined in packages/worker/.env" and those keys override wrangler
 * vars. Committed `.dev.vars.test` keeps the file-based secret empty; this
 * guard is the backstop when a DSN is still present on a test-env binding.
 */
export function resolveWorkerSentryDsn(env: {
	SENTRY_DSN?: string | undefined
	SENTRY_ENVIRONMENT?: string | undefined
}): string | undefined {
	if (env.SENTRY_ENVIRONMENT?.trim() === 'test') return undefined
	const dsn = env.SENTRY_DSN?.trim()
	return dsn || undefined
}

export function buildSentryOptions(env: Env): CloudflareOptions {
	const dsn = resolveWorkerSentryDsn(env)
	const environment = env.SENTRY_ENVIRONMENT?.trim() || 'development'
	const release = env.APP_COMMIT_SHA?.trim()
	// Default 1.0 = full trace sampling (low-traffic / personal use). Override with
	// `SENTRY_TRACES_SAMPLE_RATE` (e.g. 0.1) if volume or Sentry quota grows.
	const tracesSampleRate =
		typeof env.SENTRY_TRACES_SAMPLE_RATE === 'number'
			? env.SENTRY_TRACES_SAMPLE_RATE
			: 1.0

	return {
		...(dsn ? { dsn } : {}),
		environment,
		...(release ? { release } : {}),
		tracesSampleRate,
		sendDefaultPii: false,
		// D1 marks SQLITE_BUSY with NOSENTRY at the storage layer, but
		// application capture paths (for example scheduled_lane_failed) still
		// forwarded them. The same applies to "Currently processing a
		// long-running export" while the nightly DR D1 export holds the DB,
		// "Network connection lost" when the D1 binding drops mid-query,
		// "D1 DB is overloaded. Requests queued for too long" / "Too many
		// requests queued" when D1's request queue times out or rejects under
		// platform load, and opaque D1 "internal error …; reference = …"
		// platform faults (including storage object-reset). These are
		// transient platform unavailability errors retried in app code and
		// should not open or regress Sentry issues — including when Open API
		// remaps them to ApiError / rebuild exhaustion wrappers with the D1
		// blip as cause (KODY-AP), matching Artifacts git remaps (KODY-8P).
		//
		// User-authored failures are dropped primarily via `UserCodeError`
		// (`filterUserCodeErrorSentryEvent`). Plan-limit denials
		// (`EntitlementLimitError`) are dropped the same way — expected
		// account policy, still visible on structured `mcp-event` logs. Bundler
		// / sandbox-timeout string matches remain as backstops for unmarked
		// paths; see filterUserModuleBundlerFailureSentryEvent and
		// filterExecutorSandboxTimeoutSentryEvent. OAuth token-refresh
		// caller state (missing refresh token, provider 4xx / invalid_grant)
		// is dropped the same way — see
		// filterIntegrationTokenRefreshCallerSentryEvent. Bare Cloudflare Durable
		// Object platform reset strings (memory/CPU limits, DO SQLite
		// SQLITE_NOMEM including Agents SDK `SQL query failed:` SqlError
		// wrappers — KODY-B9 — deploy-time code updates, blockConcurrencyWhile
		// timeouts, DO storage operation timeouts, and DO storage object-reset
		// with a support reference — `in` or `while starting up` phrasing,
		// including D1_ERROR:-prefixed forms D1 bindings emit) are dropped the
		// same way — see filterDurableObjectIsolateResetSentryEvent. Bare Durable
		// Object queue
		// saturation strings ("… overloaded. Requests queued for too long", etc.)
		// are dropped the same way — see filterDurableObjectOverloadedSentryEvent.
		// Exact opaque Cloudflare "An internal error occurred." (and Artifacts
		// INTERNAL_ERROR wording) with no support reference are dropped the
		// same way, including source-safety retry wrappers and recovery wraps
		// whose reason is that opaque sentence (KODY-8F) — see
		// filterCloudflareOpaqueInternalErrorSentryEvent.
		// Artifacts git protocol HTTP 5xx / 429 wrappers (listServerRefs /
		// git fetch / git clone), stalled info/refs deadlines, and
		// isomorphic-git "Packfile payload corrupted" events are dropped the
		// same way after brief call-site retries — including when Open API
		// remaps them to ApiError with the wrapper as cause (KODY-8P) — see
		// filterArtifactsGitTransientHttpErrorSentryEvent.
		// Bare Durable Object abort token `destroyed` from Agents MCP session
		// teardown (`ctx.abort("destroyed")`) is dropped the same way — see
		// filterMcpAgentSessionDestroyedAbortSentryEvent. Expected CIMD
		// unknown-client outcomes (missing document, HTTP 404, metadata fetch
		// timeout) are dropped the same way — see
		// filterCimdUnknownClientSentryEvent. Bare Workers KV binding HTTP
		// 5xx / 429 (`KV PUT|GET|DELETE|LIST failed: …`) are dropped the same
		// way — see filterCloudflareKvTransientHttpErrorSentryEvent.
		beforeSend: filterSentryEvent,
	}
}

/**
 * Top-level Worker: skip Sentry wrapper overhead when no DSN is configured.
 */
export function getWorkerSentryOptions(
	env: Env,
): CloudflareOptions | undefined {
	const options = buildSentryOptions(env)
	return options.dsn ? options : undefined
}
