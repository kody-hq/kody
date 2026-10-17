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

export function humanizeConnectionName(name: string) {
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
}) {
	const params = new URLSearchParams({ provider: input.name })
	const label = input.accountLabel?.trim() ?? ''
	if (label.includes('@') && label.includes('.')) {
		params.set('loginHint', label)
	}
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
}): ConnectionTroubleCopy {
	const title = integrationTroubleTitle(input.name, input.accountLabel)
	const reconnectHref = buildIntegrationReconnectHref({
		name: input.name,
		accountLabel: input.accountLabel,
	})
	const accountHref = buildIntegrationAccountHref(input.name)
	const providerDetail = formatProviderDetail(
		input.providerError,
		input.providerErrorDescription,
	)

	if (input.reason === 'provider_unavailable') {
		const status =
			input.httpStatus != null ? ` (HTTP ${String(input.httpStatus)})` : ''
		return {
			title,
			why: `The provider's token service failed${status}. This is not a dead sign-in.`,
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

	const why = integrationAuthFailureWhy(input.reason, providerDetail)
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
) {
	switch (reason) {
		case 'missing_refresh_token':
			return 'This sign-in expires, but Kody has no refresh token to renew it.'
		case 'provider_rejected':
			return providerDetail
				? `The provider rejected the saved sign-in (${providerDetail}).`
				: 'The provider rejected the saved sign-in.'
		case 'missing_secret':
			return 'A required credential for this connection is missing.'
		case 'host_not_approved':
			return 'This connection is not approved for the token host.'
		case 'invalid_config':
			return "This connection's OAuth setup is incomplete."
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
