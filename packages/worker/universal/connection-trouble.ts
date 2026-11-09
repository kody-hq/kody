export const integrationAuthFailureReasons = [
	'missing_refresh_token',
	'provider_rejected',
	'missing_secret',
	'host_not_approved',
	'invalid_config',
	'provider_unavailable',
] as const

export type IntegrationAuthFailureReason =
	(typeof integrationAuthFailureReasons)[number]

export const connectionTroubleActors = ['you', 'kody', 'the-service'] as const

type ConnectionTroubleActor = (typeof connectionTroubleActors)[number]

export type IntegrationAuthFailureView = {
	reason: IntegrationAuthFailureReason
	occurredAt: string
	reconnectable: boolean
	providerError: string | null
	providerErrorDescription: string | null
	httpStatus: number | null
	title: string
	why: string
	who: ConnectionTroubleActor
	doLabel: string
	reconnectHref: string
	accountHref: string
}

export type ConnectionTroubleCopy = {
	title: string
	why: string
	who: ConnectionTroubleActor
	doLabel: string
	href: string
	reconnectable: boolean
}

export const waitingExpiredSecretCap = 3
export const searchWaitingItemCap = 3

export function isIntegrationAuthFailureReason(
	value: string,
): value is IntegrationAuthFailureReason {
	return (integrationAuthFailureReasons as ReadonlyArray<string>).includes(
		value,
	)
}

function humanizeConnectionName(name: string) {
	const trimmed = name.trim()
	if (!trimmed) return 'This connection'
	return trimmed
		.split('-')
		.filter((part) => part.length > 0)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ')
}

function integrationTroubleTitle(
	name: string,
	accountLabel: string | null | undefined,
) {
	const display = humanizeConnectionName(name)
	const label = accountLabel?.trim()
	return label
		? `${display} · ${label} stopped working`
		: `${display} stopped working`
}

export function buildIntegrationReconnectHref(input: {
	name: string
	accountLabel?: string | null
	/** Team org that owns the connection; omit for the personal org. */
	orgSlug?: string | null
}) {
	const params = new URLSearchParams({ provider: input.name })
	const label = input.accountLabel?.trim() ?? ''
	if (label.includes('@') && label.includes('.')) {
		params.set('loginHint', label)
	}
	const orgSlug = input.orgSlug?.trim()
	if (orgSlug) params.set('org', orgSlug)
	return `/connect/oauth?${params.toString()}`
}

function buildIntegrationAccountHref(name: string) {
	return `/account/integrations/${encodeURIComponent(name).replaceAll('.', '%2E')}`
}

function buildExpiredSecretHref(name: string) {
	return `/account/secrets/user/${encodeURIComponent(name).replaceAll('.', '%2E')}`
}

export function integrationAuthFailureCopy(input: {
	name: string
	accountLabel?: string | null
	lane?: 'user' | 'platform'
	reason: IntegrationAuthFailureReason
	providerError?: string | null
	providerErrorDescription?: string | null
	httpStatus?: number | null
	/**
	 * OAuth app provider slug when it differs from the connection `name`
	 * (custom connections). Used only in failure attribution copy; titles and
	 * reconnect links still use `name`.
	 */
	provider?: string | null
	/** Team org that owns the connection; omit for the personal org. */
	orgSlug?: string | null
}): ConnectionTroubleCopy {
	const title = integrationTroubleTitle(input.name, input.accountLabel)
	const reconnectHref = buildIntegrationReconnectHref({
		name: input.name,
		accountLabel: input.accountLabel,
		orgSlug: input.orgSlug,
	})
	const accountHref = buildIntegrationAccountHref(input.name)
	const providerDetail = formatProviderDetail(
		input.providerError,
		input.providerErrorDescription,
	)

	const providerSlug = input.provider?.trim() || input.name
	const providerLabel = humanizeConnectionName(providerSlug)

	if (input.reason === 'provider_unavailable') {
		const status =
			input.httpStatus != null ? ` (HTTP ${String(input.httpStatus)})` : ''
		return {
			title,
			why: `${providerLabel}'s token service failed${status}. This is not a dead sign-in, and it is not a Kody plan limit.`,
			who: 'the-service',
			doLabel: 'Open integration',
			href: accountHref,
			reconnectable: false,
		}
	}

	if (input.reason === 'missing_secret' && input.lane === 'platform') {
		return {
			title,
			why: "Kody's built-in app is missing a server credential. You cannot fix this by reconnecting.",
			who: 'kody',
			doLabel: 'Open integration',
			href: accountHref,
			reconnectable: false,
		}
	}

	// Token-endpoint 429 is a provider limit, not a dead grant. Keep it off the
	// "Needs you / Reconnect" queue so people wait instead of reconnecting.
	if (input.reason === 'provider_rejected' && input.httpStatus === 429) {
		return {
			title,
			why: integrationAuthFailureWhy(
				input.reason,
				providerDetail,
				providerLabel,
				429,
			),
			who: 'the-service',
			doLabel: 'Open integration',
			href: accountHref,
			reconnectable: false,
		}
	}

	const why = integrationAuthFailureWhy(
		input.reason,
		providerDetail,
		providerLabel,
		input.httpStatus ?? null,
	)
	return {
		title,
		why,
		who: 'you',
		doLabel: 'Reconnect',
		href: reconnectHref,
		reconnectable: true,
	}
}

export function toIntegrationAuthFailureView(input: {
	name: string
	accountLabel?: string | null
	lane?: 'user' | 'platform'
	reason: IntegrationAuthFailureReason
	occurredAt: string
	providerError?: string | null
	providerErrorDescription?: string | null
	httpStatus?: number | null
	/** OAuth app provider when it differs from the connection name. */
	provider?: string | null
	/** Team org that owns the connection; omit for the personal org. */
	orgSlug?: string | null
}): IntegrationAuthFailureView {
	const copy = integrationAuthFailureCopy(input)
	return {
		reason: input.reason,
		occurredAt: input.occurredAt,
		reconnectable: copy.reconnectable,
		providerError: input.providerError ?? null,
		providerErrorDescription: input.providerErrorDescription ?? null,
		httpStatus: input.httpStatus ?? null,
		title: copy.title,
		why: copy.why,
		who: copy.who,
		doLabel: copy.doLabel,
		reconnectHref: buildIntegrationReconnectHref({
			name: input.name,
			accountLabel: input.accountLabel,
			orgSlug: input.orgSlug,
		}),
		accountHref: buildIntegrationAccountHref(input.name),
	}
}

export function expiredSecretCopy(name: string): ConnectionTroubleCopy {
	return {
		title: `${name} expired`,
		why: 'Kody will not send that value. Paste a new token. Do not put it in chat.',
		who: 'you',
		doLabel: 'Update secret',
		href: buildExpiredSecretHref(name),
		reconnectable: true,
	}
}

/**
 * MCP hub errors that look like the remote host or network, not a grant the
 * signed-in human can finish. Waiting omits these so we do not ask someone
 * to reconnect a vendor outage.
 */
export function isVendorLikelyMcpError(error: string | null | undefined) {
	const text = error?.trim().toLowerCase() ?? ''
	if (!text) return false
	if (/\b(500|502|503|504)\b/.test(text)) return true
	if (text.includes('timeout') || text.includes('timed out')) return true
	if (
		text.includes('econnrefused') ||
		text.includes('econnreset') ||
		text.includes('enotfound')
	) {
		return true
	}
	if (text.includes('fetch failed')) return true
	if (text.includes('temporarily unavailable')) return true
	if (text.includes('service unavailable')) return true
	return false
}

function integrationAuthFailureWhy(
	reason: Exclude<IntegrationAuthFailureReason, 'provider_unavailable'>,
	providerDetail: string | null,
	providerLabel: string,
	httpStatus: number | null,
) {
	switch (reason) {
		case 'missing_refresh_token':
			return `This ${providerLabel} sign-in expires, but Kody has no refresh token to renew it. Reconnect ${providerLabel} under the workspace that should own the connection.`
		case 'provider_rejected':
			if (httpStatus === 429) {
				return `${providerLabel} rate-limited token refresh (HTTP 429). This is a provider limit, not a Kody plan limit. Wait and retry; reconnecting usually does not help.`
			}
			return providerDetail
				? `${providerLabel} rejected the saved sign-in (${providerDetail}). This is a ${providerLabel} auth failure, not a Kody plan limit. Reconnect ${providerLabel} under the workspace that should own the connection.`
				: `${providerLabel} rejected the saved sign-in. This is a ${providerLabel} auth failure, not a Kody plan limit. Reconnect ${providerLabel} under the workspace that should own the connection.`
		case 'missing_secret':
			return `A required ${providerLabel} credential for this connection is missing.`
		case 'host_not_approved':
			return `This ${providerLabel} connection is not approved for the token host.`
		case 'invalid_config':
			return `This ${providerLabel} connection's OAuth setup is incomplete.`
		default: {
			const exhaustive: never = reason
			return exhaustive
		}
	}
}

function formatProviderDetail(
	error: string | null | undefined,
	description: string | null | undefined,
) {
	const code = error?.trim() || ''
	const detail = description?.trim() || ''
	if (code && detail) return `${code}: ${detail}`
	return code || detail || null
}
