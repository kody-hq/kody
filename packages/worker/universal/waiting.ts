import {
	expiredSecretCopy,
	integrationAuthFailureCopy,
	isVendorLikelyMcpError,
	waitingExpiredSecretCap,
	type IntegrationAuthFailureReason,
} from './connection-trouble.ts'
import {
	onboardingChecklistItemHref,
	onboardingChecklistItemLabels,
	type OnboardingChecklistItemId,
} from './onboarding-process.ts'
import { enablementMappingPauseResourceType } from './credential-contracts.ts'
import { orgResourcePathForAccountPath } from './org-pages.ts'
import { routes } from './routes.ts'

export const waitingItemKinds = [
	'verify-email',
	'mcp-server',
	'integration-auth',
	'enablement-paused',
	'secret-expired',
	'publish-lock',
	'email-change',
	'entitlement',
	'error-rate',
	'onboarding',
	'first-use',
] as const

type WaitingItemKind = (typeof waitingItemKinds)[number]

export const waitingSeverities = ['block', 'degraded', 'setup'] as const

export type WaitingSeverity = (typeof waitingSeverities)[number]

/**
 * Discrete first-use gates on Waiting only. These are not `/onboarding`
 * wizard steps and are not checklist ids.
 */
export const waitingFirstUseIds = [
	'search',
	'memory',
	'execute',
	'package',
	'job',
	'integration',
	'secret',
	'discord',
] as const

export type WaitingFirstUseId = (typeof waitingFirstUseIds)[number]

/**
 * Coarse checklist ids that would duplicate the broken-out first-use cards.
 * The wizard still uses them; Waiting does not emit those onboarding cards.
 */
const onboardingWaitingCoarseIds = [
	'give-access',
	'install-starter',
] as const satisfies ReadonlyArray<OnboardingChecklistItemId>

const onboardingWaitingCoarseIdSet = new Set<OnboardingChecklistItemId>(
	onboardingWaitingCoarseIds,
)

/**
 * A current-state item the signed-in human can clear. Not a notification:
 * it disappears when the underlying gate clears. `who` is always `you` —
 * vendor outages and operator work do not belong here.
 */
export type WaitingItem = {
	id: string
	kind: WaitingItemKind
	title: string
	why: string
	who: 'you'
	doLabel: string
	href: string
	severity: WaitingSeverity
}

const userErrorRateMinErrors = 5
const userErrorRateMinPercent = 0.2
const userErrorRateAbsoluteErrors = 10

export function isElevatedUserErrorRate(input: {
	errorCount: number
	eventCount: number
}) {
	if (input.errorCount >= userErrorRateAbsoluteErrors) return true
	if (input.errorCount < userErrorRateMinErrors) return false
	if (input.eventCount <= 0) return false
	return input.errorCount / input.eventCount >= userErrorRateMinPercent
}

export type WaitingMcpServerSignal = {
	id: string
	name: string
	state: string
	error: string | null
}

export type WaitingIntegrationAuthSignal = {
	name: string
	accountLabel: string | null
	lane: 'user' | 'platform'
	reason: IntegrationAuthFailureReason
}

export type WaitingExpiredSecretSignal = {
	name: string
}

/**
 * One of the viewer's own paused enablements in the org being viewed. Only
 * the enabler sees it: a paused run of someone else's never lands here.
 */
export type WaitingPausedEnablementSignal = {
	id: string
	triggerKind: 'cron' | 'subscription' | 'webhook'
	triggerName: string
	packageName: string | null
	reason: 'org_access' | 'package_access' | 'credential_access'
	resourceType: string | null
	resourceId: string | null
}

export const waitingPausedEnablementCap = 3

type WaitingLockedPackageSignal = {
	id: string
	name: string
	kodyId: string
}

type WaitingEntitlementCapSignal = {
	resource: string
	label: string
}

export type WaitingSignals = {
	username: string
	emailVerified: boolean
	onboardingDismissed: boolean
	onboardingRemaining: Array<OnboardingChecklistItemId>
	mcpServers: Array<WaitingMcpServerSignal>
	integrationAuth: Array<WaitingIntegrationAuthSignal>
	pausedEnablements: Array<WaitingPausedEnablementSignal>
	expiredSecrets: Array<WaitingExpiredSecretSignal>
	lockedPackages: Array<WaitingLockedPackageSignal>
	pendingEmailChange: string | null
	/** Open (untriaged) Activity errors vs runs in the Activity window. */
	errorRate: { errorCount: number; eventCount: number } | null
	entitlementCaps: Array<WaitingEntitlementCapSignal>
	/**
	 * First-use gates we know are still open. Unknown probes are omitted so
	 * a storage blip cannot invent a card.
	 */
	firstUseMissing: Array<WaitingFirstUseId>
}

const severityRank: Record<WaitingSeverity, number> = {
	block: 0,
	degraded: 1,
	setup: 2,
}

const kindRank: Record<WaitingItemKind, number> = {
	'verify-email': 0,
	'mcp-server': 1,
	'integration-auth': 2,
	'enablement-paused': 3,
	'secret-expired': 4,
	'publish-lock': 5,
	'email-change': 6,
	entitlement: 7,
	'error-rate': 8,
	onboarding: 9,
	'first-use': 10,
}

const firstUseRank = Object.fromEntries(
	waitingFirstUseIds.map((id, index) => [id, index]),
) as Record<WaitingFirstUseId, number>

const mcpHumanStates = new Set(['authenticating', 'failed', 'disconnected'])

export function isWaitingMcpServerState(state: string) {
	return mcpHumanStates.has(state)
}

/** `pending_email_changes.expires_at` is a millisecond epoch, not a datetime. */
export function isUnexpiredEpochMs(expiresAt: number, now: Date) {
	return Number.isFinite(expiresAt) && expiresAt > now.getTime()
}

export function buildWaitingItems(
	signals: WaitingSignals,
	orgSlug: string,
): Array<WaitingItem> {
	const items: Array<WaitingItem> = []

	if (!signals.emailVerified) {
		items.push({
			id: 'verify-email',
			kind: 'verify-email',
			title: 'Verify your email',
			why: 'Unverified accounts can sign in, but outbound email stays off until you confirm the address.',
			who: 'you',
			doLabel: 'Verify email',
			href: routes.pendingVerification.href(),
			severity: 'block',
		})
	}

	for (const server of signals.mcpServers) {
		const item = buildMcpServerWaitingItem(server)
		if (item) items.push(item)
	}

	for (const connection of signals.integrationAuth) {
		const copy = integrationAuthFailureCopy(connection)
		if (copy.who !== 'you' || !copy.reconnectable) continue
		items.push({
			id: `integration-auth:${connection.name}`,
			kind: 'integration-auth',
			title: copy.title,
			why: copy.why,
			who: 'you',
			doLabel: copy.doLabel,
			href: copy.href,
			severity: 'block',
		})
	}

	const pausedEnablements = signals.pausedEnablements.slice(
		0,
		waitingPausedEnablementCap,
	)
	for (const enablement of pausedEnablements) {
		items.push(buildPausedEnablementWaitingItem(enablement))
	}
	const extraPaused =
		signals.pausedEnablements.length - pausedEnablements.length
	if (extraPaused > 0) {
		items.push({
			id: 'enablement-paused-more',
			kind: 'enablement-paused',
			title: `${String(extraPaused)} more of your automations are paused`,
			why: 'Ask your agent to run enablementList to see each paused enablement and why.',
			who: 'you',
			doLabel: pausedEnablementDocLabel,
			href: pausedEnablementDocHref,
			severity: 'block',
		})
	}

	const expiredSecrets = signals.expiredSecrets.slice(
		0,
		waitingExpiredSecretCap,
	)
	for (const secret of expiredSecrets) {
		const copy = expiredSecretCopy(secret.name)
		items.push({
			id: `secret-expired:${secret.name}`,
			kind: 'secret-expired',
			title: copy.title,
			why: copy.why,
			who: 'you',
			doLabel: copy.doLabel,
			href: copy.href,
			severity: 'degraded',
		})
	}
	const extraExpired = signals.expiredSecrets.length - expiredSecrets.length
	if (extraExpired > 0) {
		items.push({
			id: 'secret-expired-more',
			kind: 'secret-expired',
			title: `${String(extraExpired)} more expired keys`,
			why: 'Open Credentials to paste new values. Do not put them in chat.',
			who: 'you',
			doLabel: 'Open Credentials',
			href: '/account/credentials?kind=secret',
			severity: 'degraded',
		})
	}

	for (const pkg of signals.lockedPackages) {
		items.push({
			id: `publish-lock:${pkg.id}`,
			kind: 'publish-lock',
			title: `${pkg.name} is locked`,
			why: 'Agents can push drafts, but published code does not move until you promote a commit or unlock it.',
			who: 'you',
			doLabel: 'Review lock',
			href: routes.communityPackageApprovePublish.href({
				username: signals.username,
				kodyId: pkg.kodyId,
			}),
			severity: 'block',
		})
	}

	if (signals.pendingEmailChange) {
		items.push({
			id: 'email-change',
			kind: 'email-change',
			title: 'Confirm your new email',
			why: `A change to ${signals.pendingEmailChange} is waiting on the verification link sent to that address.`,
			who: 'you',
			doLabel: 'Open account email settings',
			href: routes.account.href(),
			severity: 'block',
		})
	}

	for (const cap of signals.entitlementCaps) {
		items.push({
			id: `entitlement:${cap.resource}`,
			kind: 'entitlement',
			title: `${cap.label} is at your plan cap`,
			why: 'New work that needs this resource will fail until you free some up or upgrade.',
			who: 'you',
			doLabel: 'Review usage',
			href: routes.accountUsage.href(),
			severity: 'degraded',
		})
	}

	if (
		signals.errorRate &&
		isElevatedUserErrorRate({
			errorCount: signals.errorRate.errorCount,
			eventCount: signals.errorRate.eventCount,
		})
	) {
		items.push({
			id: 'error-rate',
			kind: 'error-rate',
			title: 'Error rate is elevated',
			why: `${signals.errorRate.errorCount} of ${signals.errorRate.eventCount} recent runs failed and still need triage. Activity is where you handle those errors.`,
			who: 'you',
			doLabel: 'Open Activity',
			href: '/account/activity',
			severity: 'degraded',
		})
	}

	if (!signals.onboardingDismissed) {
		for (const step of signals.onboardingRemaining) {
			if (step === 'verify-email' && !signals.emailVerified) continue
			if (onboardingWaitingCoarseIdSet.has(step)) continue
			items.push({
				id: `onboarding:${step}`,
				kind: 'onboarding',
				title: onboardingChecklistItemLabels[step],
				why: 'Setup is still unfinished. Finish this step, or dismiss the checklist on Get started.',
				who: 'you',
				doLabel: 'Continue setup',
				href: onboardingChecklistItemHref(step, signals.username),
				severity: 'setup',
			})
		}
	}

	for (const id of signals.firstUseMissing) {
		items.push(buildFirstUseWaitingItem(id))
	}

	return items
		.map((item) => relocateWaitingHref(item, orgSlug))
		.sort((left, right) => {
			const severity =
				severityRank[left.severity] - severityRank[right.severity]
			if (severity !== 0) return severity
			const kind = kindRank[left.kind] - kindRank[right.kind]
			if (kind !== 0) return kind
			if (left.kind === 'first-use' && right.kind === 'first-use') {
				return firstUseItemRank(left.id) - firstUseItemRank(right.id)
			}
			if (left.id.endsWith('-more')) return 1
			if (right.id.endsWith('-more')) return -1
			return left.title.localeCompare(right.title)
		})
}

function relocateWaitingHref(item: WaitingItem, orgSlug: string): WaitingItem {
	const hashIndex = item.href.indexOf('#')
	const hash = hashIndex === -1 ? '' : item.href.slice(hashIndex)
	const beforeHash =
		hashIndex === -1 ? item.href : item.href.slice(0, hashIndex)
	const queryIndex = beforeHash.indexOf('?')
	const pathname =
		queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex)
	const search = queryIndex === -1 ? '' : beforeHash.slice(queryIndex)
	const orgPath = orgResourcePathForAccountPath(pathname, orgSlug)
	if (!orgPath) return item
	return { ...item, href: `${orgPath}${search}${hash}` }
}

function firstUseItemRank(itemId: string) {
	const id = itemId.slice('first-use:'.length) as WaitingFirstUseId
	return firstUseRank[id] ?? waitingFirstUseIds.length
}

function buildFirstUseWaitingItem(id: WaitingFirstUseId): WaitingItem {
	const copy = waitingFirstUseCopy[id]
	return {
		id: `first-use:${id}`,
		kind: 'first-use',
		title: copy.title,
		why: copy.why,
		who: 'you',
		doLabel: copy.doLabel,
		href: copy.href,
		severity: 'setup',
	}
}

const waitingFirstUseCopy: Record<
	WaitingFirstUseId,
	{ title: string; why: string; doLabel: string; href: string }
> = {
	search: {
		title: 'Try your first search',
		why: 'Search is how your agent looks things up in Kody — capabilities, guides, packages, and more.',
		doLabel: 'Read how search works',
		href: routes.docDetail.href({ slug: 'search-and-execute' }),
	},
	memory: {
		title: 'Save your first memory',
		why: 'Memories persist facts your agents can reuse across hosts.',
		doLabel: 'Open Memories',
		href: '/account/memories',
	},
	execute: {
		title: 'Run your first execute',
		why: 'Execute is how your agent does work in Kody — tools, packages, and jobs.',
		doLabel: 'Read how execute works',
		href: routes.docDetail.href({ slug: 'search-and-execute' }),
	},
	package: {
		title: 'Persist your first package',
		why: 'A saved package is reusable code your agents can keep and share.',
		doLabel: 'Open Repositories',
		href: '/account/packages',
	},
	job: {
		title: 'Create your first job',
		why: 'Jobs run on a schedule so your agents can keep working without you.',
		doLabel: 'Open Jobs',
		href: '/account/jobs',
	},
	integration: {
		title: 'Connect your first integration',
		why: 'An integration grant lets your agents call a connected third-party account.',
		doLabel: 'Connect an account',
		href: '/connect/credential?kind=oauth',
	},
	secret: {
		title: 'Add your first credential',
		why: 'Credentials stay out of chat. Add one so your agents can reach your services safely.',
		doLabel: 'Add a credential',
		href: '/connect/credential',
	},
	discord: {
		title: 'Join the Kody Discord',
		why: 'Connect Discord to join the official server and pick up your member role.',
		doLabel: 'Join Discord',
		href: routes.discord.href(),
	},
}

const pausedEnablementDocLabel = 'How paused automation resumes'
const pausedEnablementDocHref = `${routes.docDetail.href({
	slug: 'organizations',
})}#automation-runs-as-the-person-who-turned-it-on`

function pausedEnablementTitle(signal: WaitingPausedEnablementSignal) {
	const pkg = signal.packageName ? `${signal.packageName} ` : ''
	switch (signal.triggerKind) {
		case 'cron':
			return `Your ${pkg}scheduled job is paused`
		case 'subscription':
			return `Your ${pkg}"${signal.triggerName}" subscription is paused`
		case 'webhook':
			return `Your ${pkg}webhook is paused`
		default: {
			const unknownKind: never = signal.triggerKind
			throw new Error(`Unknown enablement trigger kind: ${String(unknownKind)}`)
		}
	}
}

function pausedEnablementWhy(signal: WaitingPausedEnablementSignal) {
	const resumes =
		'Its events are dropped until then, and the next event resumes it.'
	switch (signal.reason) {
		case 'credential_access': {
			if (signal.resourceType === enablementMappingPauseResourceType) {
				return `It runs as you, and the credential mapped to its need "${signal.resourceId ?? 'unknown'}" is gone, you can no longer use it, or it no longer fits the need after a republish. Map another credential on the package's Credentials page, or get Use back. ${resumes}`
			}
			const credential =
				signal.resourceType && signal.resourceId
					? `the ${signal.resourceType} "${signal.resourceId}"`
					: 'a credential'
			return `It runs as you, and its last run needed Use on ${credential}, which you do not have. Ask an org Owner for access. ${resumes}`
		}
		case 'package_access':
			return `It runs as you, and you no longer hold package:execute on ${signal.packageName ?? 'its package'}. Ask an org Owner for access. ${resumes}`
		case 'org_access':
			return `It runs as you, and you no longer have access to this org. ${resumes}`
		default: {
			const unknownReason: never = signal.reason
			throw new Error(
				`Unknown enablement pause reason: ${String(unknownReason)}`,
			)
		}
	}
}

function buildPausedEnablementWaitingItem(
	signal: WaitingPausedEnablementSignal,
): WaitingItem {
	return {
		id: `enablement-paused:${signal.id}`,
		kind: 'enablement-paused',
		title: pausedEnablementTitle(signal),
		why: pausedEnablementWhy(signal),
		who: 'you',
		doLabel: pausedEnablementDocLabel,
		href: pausedEnablementDocHref,
		severity: 'block',
	}
}

function buildMcpServerWaitingItem(
	server: WaitingMcpServerSignal,
): WaitingItem | null {
	const href = `/account/mcp-servers/${encodeURIComponent(server.id).replaceAll('.', '%2E')}`
	if (server.state === 'authenticating') {
		return {
			id: `mcp-server:${server.id}`,
			kind: 'mcp-server',
			title: `${server.name} needs authorization`,
			why:
				server.error?.trim() ||
				'This MCP server is waiting for you to finish OAuth. Until you do, its tools stay off.',
			who: 'you',
			doLabel: 'Complete authorization',
			href,
			severity: 'block',
		}
	}
	if (server.state === 'failed') {
		if (isVendorLikelyMcpError(server.error)) return null
		return {
			id: `mcp-server:${server.id}`,
			kind: 'mcp-server',
			title: `${server.name} failed to connect`,
			why:
				server.error?.trim() ||
				'Kody could not reach this MCP server. Reconnect it so your agent can use its tools.',
			who: 'you',
			doLabel: 'Reconnect',
			href,
			severity: 'degraded',
		}
	}
	if (server.state === 'disconnected') {
		if (isVendorLikelyMcpError(server.error)) return null
		return {
			id: `mcp-server:${server.id}`,
			kind: 'mcp-server',
			title: `${server.name} is disconnected`,
			why: 'The connection dropped. Reconnect it so your agent can use its tools.',
			who: 'you',
			doLabel: 'Reconnect',
			href,
			severity: 'degraded',
		}
	}
	return null
}
