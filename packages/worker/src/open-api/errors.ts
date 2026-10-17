import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	redactKodyCredentials,
	redactKodyCredentialsDeep,
} from '@kody-internal/shared/api-token-format.ts'
import {
	getErrorCauseChain,
	getErrorMessage,
} from '@kody-internal/shared/error-message.ts'
import { isMcpCallerError } from '#mcp/caller-error.ts'
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
	ArtifactsGitUnavailableError,
	artifactsGitTemporarilyUnavailableMessage,
	isArtifactsGitTransientRemapError,
	toArtifactsGitUnavailableError,
} from '#worker/repo/artifacts-git-retry.ts'

export { artifactsGitTemporarilyUnavailableMessage }

export const apiErrorCodes = [
	'invalid_request',
	'unauthorized',
	'insufficient_scope',
	'email_verification_required',
	'account_suspended',
	'feature_unavailable',
	'feature_disabled',
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
 * public code).
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
