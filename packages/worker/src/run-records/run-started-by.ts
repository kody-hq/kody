/**
 * Who started a run, derived from {@link RequestContext} at begin/claim time.
 *
 * Stored on the run row (not only in opaque metadata) so Activity and
 * `runList` / `runGet` can show a person + client without a backfill. Old runs
 * omit the field and render as unknown.
 *
 * Never stores credential secrets — only kind, optional display label (token
 * name / connection profile), and the actor person id/username.
 */

import {
	type RequestContext,
	type RequestCredentialKind,
} from '@kody-internal/shared/request-context.ts'

/**
 * Client / source that started the run. Interactive kinds map from session,
 * MCP OAuth, CLI, API token, and package-app credentials. Automation kinds
 * (schedule, webhook, inbound-email, platform-event) mean a background
 * delivery owned by the enablement's actor — not an interactive click.
 */
export const runStartedByClientValues = [
	'session',
	'mcp',
	'cli',
	'api-token',
	'package-app',
	'schedule',
	'webhook',
	'inbound-email',
	'platform-event',
	'execution-context',
] as const

export type RunStartedByClient = (typeof runStartedByClientValues)[number]

export type RunStartedBy = {
	userId: string | null
	username: string | null
	client: RunStartedByClient
	/**
	 * Cheap display label: API token name, connection profile, or similar.
	 * Never a token value or secret.
	 */
	label: string | null
}

export function isRunStartedByClient(
	value: string,
): value is RunStartedByClient {
	return (runStartedByClientValues as ReadonlyArray<string>).includes(value)
}

export function runStartedByClientFromCredentialKind(
	kind: RequestCredentialKind,
): RunStartedByClient {
	switch (kind) {
		case 'session':
			return 'session'
		case 'mcp-oauth':
			return 'mcp'
		case 'cli':
			return 'cli'
		case 'api-token':
			return 'api-token'
		case 'package-app':
			return 'package-app'
		case 'inbound-email':
			return 'inbound-email'
		case 'webhook':
			return 'webhook'
		case 'schedule':
			return 'schedule'
		case 'platform-event':
			return 'platform-event'
		case 'execution-context-run':
			return 'execution-context'
		default: {
			const exhaustive: never = kind
			throw new Error(`Unhandled credential kind: ${String(exhaustive)}`)
		}
	}
}

function normalizeOptionalLabel(
	value: string | null | undefined,
): string | null {
	const trimmed = value?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : null
}

/**
 * Snapshot started-by from the live request. Returns null when there is no
 * request (callers that cannot name a person or client leave the run without
 * started_by; UI shows unknown).
 */
export function runStartedByFromRequest(
	request: RequestContext | null | undefined,
	options?: { label?: string | null },
): RunStartedBy | null {
	if (!request) return null
	const label =
		normalizeOptionalLabel(options?.label) ??
		normalizeOptionalLabel(request.credential.profileName)
	return {
		userId: request.actor?.userId ?? null,
		username: request.actor?.username?.trim() || null,
		client: runStartedByClientFromCredentialKind(request.credential.kind),
		label,
	}
}

/** Normalize a caller-supplied or deserialized started-by snapshot. */
export function normalizeRunStartedBy(
	value: RunStartedBy | null | undefined,
): RunStartedBy | null {
	if (!value) return null
	if (!isRunStartedByClient(value.client)) return null
	return {
		userId: normalizeOptionalLabel(value.userId),
		username: normalizeOptionalLabel(value.username),
		client: value.client,
		label: normalizeOptionalLabel(value.label),
	}
}
