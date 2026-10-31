import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	redactKodyCredentials,
	redactKodyCredentialsDeep,
} from '@kody-internal/shared/api-token-format.ts'
import {
	getErrorCauseChain,
	getErrorMessage,
} from '@kody-internal/shared/error-message.ts'
import { McpCallerError, isMcpCallerError } from '#mcp/caller-error.ts'
import { isExecutionContextError } from '#worker/execution-contexts/errors.ts'
import { EncodedPlaceholderError } from '#mcp/secrets/encoded-placeholder.ts'
import {
	AuthorizationError,
	LivePersonRequiredError,
} from '#worker/authorization/authorize.ts'
import {
	AccountDeletionInProgressError,
	AccountWriteLeaseLostError,
} from '#worker/account/deletion-state.ts'
import {
	isComputeOverageLimitError,
	isEntitlementLimitError,
	isJobIntervalFloorError,
} from '#worker/entitlements/errors.ts'
import { isQuarantinedInboundReplyError } from '#worker/email/quarantined-inbound-reply.ts'
import {
	isRetryableD1LockMessage,
	transientDatabaseUnavailableMessage,
} from '#worker/d1-retry.ts'
import { isPublishComputeLimitMessage } from '#worker/repo/isolated-runner-limit-message.ts'
import { readRemoteRefNotConfirmedError } from '#worker/repo/remote-ref-not-confirmed-error.ts'
import {
	ArtifactsGitUnavailableError,
	artifactsGitTemporarilyUnavailableMessage,
	isArtifactsGitTransientRemapError,
	toArtifactsGitUnavailableError,
} from '#worker/repo/artifacts-git-retry.ts'

export { artifactsGitTemporarilyUnavailableMessage }
export { transientDatabaseUnavailableMessage }

const transientDatabaseRetryAfterSeconds = '5'

/**
 * A bare Durable Object CPU or memory reset (not a D1 / DO SQLite error) is
 * a compute limit, not a storage outage (KODY-CY).
 */
export const computeLimitExceededMessage =
	'This request exceeded a Kody compute limit (CPU time or memory) and was ' +
	'stopped before it finished. This is not a storage outage. Retry once; ' +
	'if it fails the same way, the request is too large to finish in one run, ' +
	'so split it into smaller pieces. For a package publish, run ' +
	'`kody dev check` to see which step is over the limit.'

/** A bare deploy-time Durable Object reset: the server restarted. */
export const serverRestartedMessage =
	'The Kody server handling this request restarted (usually during a ' +
	'deploy) before it finished. Retry in a few seconds.'

const storageResetPrefixPattern = /D1_ERROR|SQL query failed|SQLITE_/i

// Literal platform sentences (see `sentry-options.ts`); importing that module
// here would create an import cycle through the executor.
const durableObjectComputeLimitResetMessages = new Set([
	"Durable Object's isolate exceeded its memory limit and was reset.",
	'Durable Object exceeded its CPU time limit and was reset.',
])
const durableObjectCodeUpdatedResetMessage =
	'Durable Object reset because its code was updated.'

function normalizePlatformResetMessage(message: string) {
	const trimmed = message.trim().replace(/^Error:\s*/i, '')
	return trimmed.endsWith('.') ? trimmed : `${trimmed}.`
}

function classifyBareDurableObjectReset(
	error: unknown,
): 'compute_limit' | 'restart' | null {
	for (const entry of getErrorCauseChain(error)) {
		if (entry instanceof McpCallerError) continue
		const message = getErrorMessage(entry)
		// D1 and DO SQLite surface the same sentences; those stay storage.
		if (storageResetPrefixPattern.test(message)) continue
		const normalized = normalizePlatformResetMessage(message)
		if (durableObjectComputeLimitResetMessages.has(normalized)) {
			return 'compute_limit'
		}
		if (normalized === durableObjectCodeUpdatedResetMessage) return 'restart'
	}
	return null
}

export const apiErrorCodes = [
	'invalid_request',
	'unauthorized',
	'insufficient_scope',
	'email_verification_required',
	'account_suspended',
	'feature_unavailable',
	'feature_disabled',
	'not_granted',
	'context_revoked',
	'chain_changed',
	'chain_too_long',
	'context_not_usable',
	'no_execution_context_available',
	'execution_context_unavailable',
	'execution_context_lease_invalid',
	'execution_context_access_lost',
	'context_not_revoked',
	'commands_opt_in_local',
	'execution_context_commands_off',
	'execution_context_command_not_granted',
	'execution_context_command_requires_context',
	'not_found',
	'method_not_allowed',
	'account_deleting',
	'payload_too_large',
	'unsupported_media_type',
	'rate_limited',
	'entitlement_limit',
	'capability_error',
	'quarantined_inbound_reply',
	'package_import_unresolved',
	'package_import_unpublished',
	'unsupported_dynamic_package_import',
	'publish_not_applied',
	'internal_error',
] as const

export type ApiErrorCode = (typeof apiErrorCodes)[number]

export type ApiErrorBody = {
	error: {
		code: ApiErrorCode
		message: string
		details?: unknown
	}
}

export class ApiError extends Error {
	readonly status: number
	readonly code: ApiErrorCode
	readonly details: unknown
	readonly headers: Record<string, string>
	/**
	 * Owning user for observe-only metering when auth fails before
	 * `invokeApiOperation`. Never serialized to clients.
	 */
	readonly meteringUserId?: OwnerId

	constructor(input: {
		status: number
		code: ApiErrorCode
		message: string
		details?: unknown
		headers?: Record<string, string>
		meteringUserId?: OwnerId
		cause?: unknown
	}) {
		super(
			input.message,
			input.cause === undefined ? undefined : { cause: input.cause },
		)
		this.name = 'ApiError'
		this.status = input.status
		this.code = input.code
		this.details = input.details
		this.headers = input.headers ?? {}
		this.meteringUserId = input.meteringUserId
	}

	toBody(): ApiErrorBody {
		return {
			error: {
				code: this.code,
				message: redactKodyCredentials(this.message),
				...(this.details === undefined
					? {}
					: { details: redactKodyCredentialsDeep(this.details) }),
			},
		}
	}
}

export function invalidRequest(message: string, details?: unknown) {
	return new ApiError({
		status: 400,
		code: 'invalid_request',
		message,
		details,
	})
}

export function notFound(message: string) {
	return new ApiError({ status: 404, code: 'not_found', message })
}

/**
 * Map a thrown value to the public error envelope. Caller errors become
 * 400 (or 404 when they say something was not found); unknown errors are
 * 500 with a generic message so internals never leak. Exhausted Artifacts
 * git unavailability is 503 `internal_error` with a report id and upstream
 * status class in the message/details (closed OpenAPI code enum — no new
 * public code). Transient D1 platform unavailability that outlived the
 * storage retries (an in-flight export, overload, opaque platform faults) is
 * 503 `internal_error` with `Retry-After`, so clients can tell it from a real
 * defect and retry.
 */
export function toApiError(error: unknown): ApiError {
	if (error instanceof ApiError) return error
	if (error instanceof AuthorizationError) {
		if (error.code === 'unauthenticated') {
			return new ApiError({
				status: 401,
				code: 'unauthorized',
				message: error.message,
				cause: error,
			})
		}
		return new ApiError({
			status: 403,
			code: 'insufficient_scope',
			message: error.message,
			details: {
				required_permission: error.permission,
				denial: error.code,
				...(error.mintScopes
					? { required_scope: error.permission, mint_scopes: error.mintScopes }
					: {}),
			},
			headers: {
				'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${error.permission}"`,
			},
			cause: error,
		})
	}
	if (error instanceof LivePersonRequiredError) {
		return new ApiError({
			status: 403,
			code: 'insufficient_scope',
			message: error.message,
			details: {
				capability: error.capabilityName,
				denial: 'live_person_required',
			},
			cause: error,
		})
	}
	if (error instanceof AccountDeletionInProgressError) {
		return new ApiError({
			status: 409,
			code: 'account_deleting',
			message:
				'Account deletion is in progress; user-owned writes are disabled.',
			cause: error,
		})
	}
	if (error instanceof AccountWriteLeaseLostError) {
		return new ApiError({
			status: 503,
			code: 'account_deleting',
			message:
				'Account deletion is in progress; retry after the current write finishes.',
			cause: error,
		})
	}
	const limitError = getErrorCauseChain(error).find(
		(entry) =>
			isEntitlementLimitError(entry) || isComputeOverageLimitError(entry),
	)
	if (limitError) {
		return new ApiError({
			status: 429,
			code: 'entitlement_limit',
			message: getErrorMessage(limitError),
			details: limitError.details,
			// Hint only — entitlement reset is not a fixed window. Clients should
			// back off at least this long before retrying a capped operation.
			headers: { 'Retry-After': '60' },
			cause: error,
		})
	}
	const contextError = getErrorCauseChain(error).find(isExecutionContextError)
	if (contextError) {
		return new ApiError({
			status: contextError.status,
			code: contextError.code,
			message: contextError.message,
			details: contextError.details,
			cause: error,
		})
	}
	const quarantinedReply = getErrorCauseChain(error).find((entry) =>
		isQuarantinedInboundReplyError(entry),
	)
	if (quarantinedReply) {
		return new ApiError({
			status: 409,
			code: 'quarantined_inbound_reply',
			message: quarantinedReply.message,
			cause: error,
		})
	}
	// The push did not land, so nothing moved. Say so with a real code: a
	// generic 500 leaves callers unsure whether the publish is half-applied.
	const notApplied = getErrorCauseChain(error)
		.map(readRemoteRefNotConfirmedError)
		.find((entry) => entry !== null)
	// No observed ref means the confirm read itself failed (or the ref is
	// gone): the pointer did not move, but whether the git ref did is unknown.
	if (notApplied && notApplied.observedCommit === null) {
		return new ApiError({
			status: 503,
			code: 'internal_error',
			message:
				'The publish outcome is unknown: Kody could not read the source repo refs back after the push, so the push may have landed. published_commit did not move. Check the source ref before retrying.',
			details: {
				published_commit_moved: false,
				ref_state: 'unknown',
				ref: notApplied.ref,
				expected_commit: notApplied.expectedCommit,
				status_capability: 'repoGetSession',
			},
			cause: error,
		})
	}
	if (notApplied) {
		return new ApiError({
			status: 409,
			code: 'publish_not_applied',
			message: notApplied.message,
			details: {
				published: false,
				retry_safe: true,
				ref: notApplied.ref,
				expected_commit: notApplied.expectedCommit,
				observed_commit: notApplied.observedCommit,
				status_capability: 'repoGetSession',
			},
			cause: error,
		})
	}
	// A publish step over its compute limit already says which step and what
	// to do. Checked before the D1 mapping: its cause is a raw reset that
	// would otherwise read as a storage outage (KODY-CY).
	const publishComputeLimit = getErrorCauseChain(error).find((entry) =>
		isPublishComputeLimitMessage(getErrorMessage(entry)),
	)
	if (publishComputeLimit) {
		return invalidRequest(getErrorMessage(publishComputeLimit))
	}
	switch (classifyBareDurableObjectReset(error)) {
		case 'compute_limit':
			return new ApiError({
				status: 503,
				code: 'internal_error',
				message: computeLimitExceededMessage,
				cause: error,
			})
		case 'restart':
			return new ApiError({
				status: 503,
				code: 'internal_error',
				message: serverRestartedMessage,
				headers: { 'Retry-After': transientDatabaseRetryAfterSeconds },
				cause: error,
			})
		case null:
			break
	}
	// Transient D1 before caller-error mapping: package prep and other hosts
	// wrap retryable D1 failures in McpCallerError, and those must stay 503
	// with Retry-After rather than becoming a 400 invalid_request. Match only
	// non-caller entries: a McpCallerError message can echo caller input (for
	// example a job id of "SQLITE_BUSY") and must not turn a 404 into a 503.
	if (
		getErrorCauseChain(error).some(
			(entry) =>
				!(entry instanceof McpCallerError) &&
				isRetryableD1LockMessage(getErrorMessage(entry)),
		)
	) {
		return new ApiError({
			status: 503,
			code: 'internal_error',
			message: transientDatabaseUnavailableMessage,
			headers: { 'Retry-After': transientDatabaseRetryAfterSeconds },
			cause: error,
		})
	}
	if (isMcpCallerError(error) || isJobIntervalFloorError(error)) {
		const message = getErrorMessage(error)
		return /\bnot found\b/i.test(message)
			? notFound(message)
			: invalidRequest(message)
	}
	if (error instanceof EncodedPlaceholderError) {
		return invalidRequest(error.message)
	}
	if (
		error instanceof ArtifactsGitUnavailableError ||
		isArtifactsGitTransientRemapError(error)
	) {
		const unavailable = toArtifactsGitUnavailableError(error)
		return new ApiError({
			status: 503,
			code: 'internal_error',
			message: unavailable.message,
			details: unavailable.toApiDetails(),
			cause: unavailable,
		})
	}
	return new ApiError({
		status: 500,
		code: 'internal_error',
		message: 'Internal error. Retry later or report it if it persists.',
		cause: error,
	})
}

export function apiErrorResponse(error: ApiError) {
	return Response.json(error.toBody(), {
		status: error.status,
		headers: { 'Cache-Control': 'no-store', ...error.headers },
	})
}
