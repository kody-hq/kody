import * as Sentry from '@sentry/cloudflare'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { getErrorCauseChain } from '@kody-internal/shared/error-message.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import {
	isComputeOverageLimitError,
	isEntitlementLimitError,
	isJobIntervalFloorError,
} from '#worker/entitlements/errors.ts'
import { isSearchRateLimitError } from '#worker/search-rate-limit-error.ts'
import { PackageNameInputError } from '#worker/package-registry/package-name.ts'
import { SavedPackageNotFoundError } from '#worker/package-runtime/package-import-resolution.ts'
import { isKodyDescriptionLengthMessage } from '#worker/package-registry/types.ts'
import {
	isRepoDiffTooLargeMessage,
	isRepoLargeFileMessage,
} from '#worker/repo/large-file-policy.ts'
import { isRepoChecksFailedError } from '#worker/repo/repo-checks-failed-error.ts'
import {
	isGitPushNotFastForwardMessage,
	isRepoDisallowedPathMessage,
	isRepoSearchInvalidRegexMessage,
	isRepoSessionApplyPatchCallerMessage,
	isRepoSessionInactiveMessage,
	isRepoSessionNotFoundMessage,
	isRepoSessionStructuralEditCallerMessage,
} from '#worker/repo/repo-session-caller-error.ts'
import {
	isDestructiveOverwriteConfirmationMessage,
	isArtifactsGitReadTimeoutMessage,
	isArtifactsOpaqueInternalRetryMessage,
	isArtifactsRepoLookupTimeoutMessage,
	isPrivateVisibilityChangeConfirmationMessage,
} from '#worker/repo/source-safety-policy.ts'
import { isUserStorageSqlCallerMessage } from '#worker/storage-sql-caller-error.ts'
import { isIntegrationTokenRefreshCallerMessage } from '#worker/integrations/token-refresh.ts'
import { isUserCodeError } from '#worker/user-code-error.ts'
import { isMcpCallerError } from './caller-error.ts'

export type McpToolKind = 'search' | 'execute' | 'api' | 'capability' | 'app'

export type McpFailurePhase = 'parse_input' | 'handler' | 'parse_output'

export type McpObservabilityPayload = {
	category: 'mcp'
	tool: McpToolKind
	toolName?: string
	capabilityName?: string
	domain?: string
	capabilitySource?: string
	outcome: 'success' | 'failure'
	durationMs: number
	baseUrl: string
	hasUser: boolean
	/** Stable user id of the caller, when authenticated. */
	userId?: string
	/**
	 * MCP tool conversation id when the call is part of a multi-turn tool
	 * session. Kept on context (not tags) to avoid high-cardinality indexing.
	 */
	conversationId?: string
	/**
	 * Bound durable storage id for execute/capability calls that run against a
	 * specific bucket. Kept on context (not tags) for the same reason.
	 */
	storageId?: string
	failurePhase?: McpFailurePhase
	sandboxError?: boolean
	/**
	 * Set at failure sites that report a caller mistake without throwing an
	 * `McpCallerError` (batch lookups, early argument validation).
	 */
	callerError?: boolean
	registeredCapabilityCount?: number
	errorName?: string
	errorMessage?: string
	message?: string
	context?: Record<string, unknown>
	timestamp: string
}

export type LogMcpEventInput = Omit<McpObservabilityPayload, 'timestamp'> & {
	timestamp?: string
	/** Original error for Sentry (not serialized on the log line). */
	cause?: unknown
}

export function callerContextFields(context: McpCallerContext) {
	return {
		baseUrl: context.baseUrl,
		hasUser: context.user != null,
		userId: context.user?.userId,
		storageContext: context.storageContext ?? null,
		storageId: context.storageContext?.storageId ?? undefined,
	}
}

export function errorFields(error: unknown): {
	errorName: string
	errorMessage: string
} {
	if (error instanceof Error) {
		return { errorName: error.name, errorMessage: error.message }
	}
	return { errorName: 'Unknown', errorMessage: String(error) }
}

/**
 * Failures the caller caused and can fix. They stay on the structured
 * `mcp-event` log line; sending them to Sentry creates issues that look like
 * platform bugs and trip triage automation.
 *
 * Plan-limit denials (`EntitlementLimitError`) belong here too: the user can
 * clean up or upgrade, and volume is still visible on `mcp-event` lines if a
 * spike ever needs investigation.
 */
function isCallerFailure(payload: McpObservabilityPayload, cause?: unknown) {
	// Sandbox failures come from caller-supplied module code (bad Notion
	// filters, syntax errors, thrown strings).
	if (payload.sandboxError) return true
	// Arguments that never matched the declared schema never reached a handler.
	if (payload.failurePhase === 'parse_input') return true
	if (payload.callerError) return true
	if (isUserCodeError(cause)) return true
	if (getErrorCauseChain(cause).some(isEntitlementLimitError)) return true
	if (getErrorCauseChain(cause).some(isSearchRateLimitError)) return true
	if (getErrorCauseChain(cause).some(isComputeOverageLimitError)) return true
	if (getErrorCauseChain(cause).some(isJobIntervalFloorError)) return true
	// Community preconditions (rate before fork, self-rate, banned, …) are
	// caller-clearable; keep them on mcp-event and out of Sentry.
	if (
		getErrorCauseChain(cause).some(
			(entry) => entry instanceof CommunityActionError,
		)
	) {
		return true
	}
	// Empty, mismatched-scope, or invalid package names. Agents must use the
	// leaf or their own "@owner/…" form. KODY-83.
	if (
		getErrorCauseChain(cause).some(
			(entry) => entry instanceof PackageNameInputError,
		)
	) {
		return true
	}
	// `kody:@scope/pkg` import (or equivalent resolve) for a package the
	// caller does not have. Agents must fork/install or fix the specifier.
	// KODY-86.
	if (
		getErrorCauseChain(cause).some(
			(entry) => entry instanceof SavedPackageNotFoundError,
		)
	) {
		return true
	}
	// Repo large-file and diff-line-limit rejections raised inside the
	// RepoSession Durable Object arrive as plain Errors (subclass identity
	// does not survive RPC); match on the stable message phrases (and the
	// raw `@cloudflare/shell` EFBIG wording) so caller-fixable size denials
	// stay out of Sentry. KODY-8E.
	if (
		getErrorCauseChain(cause).some(
			(entry) =>
				entry instanceof Error &&
				(isRepoLargeFileMessage(entry.message) ||
					isRepoDiffTooLargeMessage(entry.message)),
		)
	) {
		return true
	}
	// User-authored SQL against a storage bucket (missing tables/columns,
	// constraints, read-only policy). storageQuery wraps these as
	// McpCallerError; this message match covers plain Errors that still
	// arrive via RPC without subclass identity.
	// Restrict to storageQuery so that D1 errors from other capabilities
	// (e.g. application database FK/unique violations) still reach Sentry.
	if (
		payload.capabilityName === 'storageQuery' &&
		getErrorCauseChain(cause).some(
			(entry) =>
				entry instanceof Error && isUserStorageSqlCallerMessage(entry.message),
		)
	) {
		return true
	}
	// Published / inactive / missing repo sessions, invalid repoSearch
	// regexes, disallowed repo paths, structural delete/move validation, and
	// malformed / non-applying repoApplyPatch diffs are thrown inside the
	// RepoSession Durable Object as plain Errors. Match the stable phrases so
	// they stay out of Sentry even when a capability forgets to re-wrap as
	// McpCallerError. KODY-9B, KODY-A3.
	if (
		getErrorCauseChain(cause).some(
			(entry) =>
				entry instanceof Error &&
				(isRepoSessionInactiveMessage(entry.message) ||
					isRepoSessionNotFoundMessage(entry.message) ||
					isRepoSearchInvalidRegexMessage(entry.message) ||
					isRepoDisallowedPathMessage(entry.message) ||
					isRepoSessionStructuralEditCallerMessage(entry.message) ||
					isRepoSessionApplyPatchCallerMessage(entry.message)),
		)
	) {
		return true
	}
	// Non-fast-forward publish pushes (isomorphic-git PushRejectedError). The
	// DO maps these to base_moved; this phrase match covers any plain Error
	// that still escapes RPC — KODY-CLOUDFLARE-5M.
	if (
		getErrorCauseChain(cause).some(
			(entry) =>
				entry instanceof Error && isGitPushNotFastForwardMessage(entry.message),
		)
	) {
		return true
	}
	// Package source safety confirmation gates (confirm_destructive_overwrite /
	// confirm_private_visibility_change) throw plain Errors from shared policy
	// helpers used by MCP capabilities and Durable Object paths. Agents re-call
	// with the flag after explicit user approval — keep them off Sentry.
	if (
		getErrorCauseChain(cause).some(
			(entry) =>
				entry instanceof Error &&
				(isDestructiveOverwriteConfirmationMessage(entry.message) ||
					isPrivateVisibilityChangeConfirmationMessage(entry.message)),
		)
	) {
		return true
	}
	// Artifacts REST opaque internal errors remapped by source-safety to a
	// retry-oriented message (KODY-8F), and Artifacts lookup / git-read
	// timeouts remapped the same way. Same caller-retryable class — keep
	// volume on mcp-event lines.
	if (
		getErrorCauseChain(cause).some(
			(entry) =>
				entry instanceof Error &&
				(isArtifactsOpaqueInternalRetryMessage(entry.message) ||
					isArtifactsRepoLookupTimeoutMessage(entry.message) ||
					isArtifactsGitReadTimeoutMessage(entry.message)),
		)
	) {
		return true
	}
	// Oversized kody.description taglines (KODY-7S). Write/publish asserts
	// throw a plain Error from package-registry. packageGetGitRemote rejects
	// them at parse_input and stub create wraps as McpCallerError. This
	// phrase match keeps a remaining handler throw (packageSave, promote, or
	// checks rethrowing the assert) off Sentry.
	if (
		getErrorCauseChain(cause).some(
			(entry) =>
				entry instanceof Error && isKodyDescriptionLengthMessage(entry.message),
		)
	) {
		return true
	}
	// Failed publish/repo checks (KODY-96). packageSave rewraps as
	// McpCallerError; match the named error (and DO/JSRPC-flattened form)
	// so a leftover plain throw still stays off Sentry.
	if (getErrorCauseChain(cause).some(isRepoChecksFailedError)) {
		return true
	}
	// OAuth token refresh preconditions and provider 4xx rejections
	// (revoked/expired grant, connection without a refresh token). Agents
	// reconnect at /connect/oauth; keep volume on mcp-event lines.
	if (
		getErrorCauseChain(cause).some(
			(entry) =>
				entry instanceof Error &&
				isIntegrationTokenRefreshCallerMessage(entry.message),
		)
	) {
		return true
	}
	return isMcpCallerError(cause)
}

function reportMcpFailureToSentry(
	payload: McpObservabilityPayload,
	cause?: unknown,
) {
	try {
		if (isCallerFailure(payload, cause)) return
		if (!Sentry.isInitialized()) return
		const client = Sentry.getClient()
		if (!client?.getOptions().dsn) return

		Sentry.withScope((scope) => {
			scope.setLevel('error')

			// Id only: sendDefaultPii is false and emails stay out of Sentry.
			if (payload.userId) scope.setUser({ id: payload.userId })

			scope.setTag('mcp.tool', payload.tool)
			if (payload.toolName) scope.setTag('mcp.tool_name', payload.toolName)
			if (payload.capabilityName) {
				scope.setTag('mcp.capability', payload.capabilityName)
			}
			if (payload.domain) scope.setTag('mcp.domain', payload.domain)
			if (payload.capabilitySource) {
				scope.setTag('mcp.capability_source', payload.capabilitySource)
			}
			if (payload.failurePhase) {
				scope.setTag('mcp.failure_phase', payload.failurePhase)
			}
			scope.setContext('mcp', {
				baseUrl: payload.baseUrl,
				hasUser: payload.hasUser,
				durationMs: payload.durationMs,
				errorName: payload.errorName,
				errorMessage: payload.errorMessage,
				registeredCapabilityCount: payload.registeredCapabilityCount,
				conversationId: payload.conversationId,
				storageId: payload.storageId,
				// Structured call-site detail (entity refs, validation phase,
				// intent telemetry). Nested so it cannot clobber core fields.
				detail: payload.context,
			})

			if (cause instanceof Error) {
				Sentry.captureException(cause)
			} else if (
				payload.errorMessage != null &&
				payload.errorMessage.length > 0
			) {
				Sentry.captureMessage(
					`${payload.errorName ?? 'Error'}: ${payload.errorMessage}`,
				)
			}
		})
	} catch {
		// Never let observability break MCP execution.
	}
}

export function logMcpEvent(event: LogMcpEventInput) {
	const { cause, ...rest } = event
	try {
		const payload: McpObservabilityPayload = {
			...rest,
			timestamp: event.timestamp ?? new Date().toISOString(),
		}
		console.info('mcp-event', JSON.stringify(payload))
		if (payload.outcome === 'failure') {
			reportMcpFailureToSentry(payload, cause)
		}
	} catch (error) {
		console.warn('mcp-event-failed', error)
	}
}
