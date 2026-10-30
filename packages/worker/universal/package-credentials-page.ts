/**
 * The package Credentials, Default mappings, and Triggers tabs on top of the
 * package credentials API (docs/contributing/contracts/credential-mappings-api.md):
 * tab paths, the page payload, and the labels each tab shows. Nothing here
 * carries a credential value.
 */
import {
	type CredentialMappingSource,
	type CredentialRef,
	type CredentialTriggerKind,
	type CredentialTriggerRef,
	type EffectiveCredentialMappingStatus,
	isInboundEmailApprovalTopic,
	type PackageCredentialNeedView,
	type PackageCredentialsIncomplete,
	type PackageCredentialsView,
	type PackageTriggerView,
} from '#universal/credential-contracts.ts'
import { orgResourcePath } from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'

export const packageCredentialsTabs = [
	'credentials',
	'mappings',
	'triggers',
] as const

export type PackageCredentialsTab = (typeof packageCredentialsTabs)[number]

export function packageCredentialsTabLabel(tab: PackageCredentialsTab) {
	switch (tab) {
		case 'credentials':
			return 'Credentials'
		case 'mappings':
			return 'Default mappings'
		case 'triggers':
			return 'Triggers'
		default: {
			const exhaustive: never = tab
			return exhaustive
		}
	}
}

export function packageCredentialsTabHref(input: {
	username: string
	kodyId: string
	tab: PackageCredentialsTab
}) {
	const params = { username: input.username, kodyId: input.kodyId }
	switch (input.tab) {
		case 'credentials':
			return routes.communityPackageCredentials.href(params)
		case 'mappings':
			return routes.communityPackageMappings.href(params)
		case 'triggers':
			return routes.communityPackageTriggers.href(params)
		default: {
			const exhaustive: never = input.tab
			return exhaustive
		}
	}
}

/** `/@user/kody-id/<tab>` and its tab, or null for any other path. */
export function readPackageCredentialsTabPath(pathname: string): {
	username: string
	kodyId: string
	tab: PackageCredentialsTab
} | null {
	const match = /^\/@([^/]+)\/([^/]+)\/([^/]+)\/?$/.exec(pathname)
	if (!match) return null
	const [, rawUsername, rawKodyId, rawTab] = match
	const tab = packageCredentialsTabs.find((candidate) => candidate === rawTab)
	if (!tab || rawKodyId === '-') return null
	try {
		return {
			username: decodeURIComponent(rawUsername!),
			kodyId: decodeURIComponent(rawKodyId!),
			tab,
		}
	} catch {
		return null
	}
}

/** The package chrome for the tabs, from the package detail API. */
type PackageCredentialsPageShell = {
	username: string
	kodyId: string
	name: string
	description: string
	isPrivate: boolean
	isListed: boolean
	listingId: string | null
	defaultBranch: string | null
	publishedCommit: string | null
	ownerProfilePublic: boolean
	viewerCanManage: boolean
	viewerCanManageAccess: boolean
	viewerCanSeeConnectedPeople: boolean
}

type PackageCredentialsPageData = {
	shell: PackageCredentialsPageShell
	/** Null when the credentials API failed; `viewError` says why. */
	view: PackageCredentialsView | null
	viewError: string | null
}

/** Not found also covers a viewer without `package:execute`, as the API does. */
export type PackageCredentialsLoaderData =
	| ({ ok: true } & PackageCredentialsPageData)
	| { ok: false; notFound: true }

function credentialTriggerKindLabel(kind: CredentialTriggerKind) {
	switch (kind) {
		case 'cron':
			return 'Schedule'
		case 'subscription':
			return 'Subscription'
		case 'webhook':
			return 'Webhook'
		default: {
			const exhaustive: never = kind
			return exhaustive
		}
	}
}

export function describeTrigger(trigger: CredentialTriggerRef) {
	return `${credentialTriggerKindLabel(trigger.kind)} “${trigger.name}”`
}

/** Where an effective mapping came from, as a short phrase. */
export function mappingSourceLabel(source: CredentialMappingSource) {
	switch (source) {
		case 'call':
			return 'Set by the call'
		case 'trigger':
			return 'This trigger’s mapping'
		case 'mine':
			return 'Your default'
		case 'org':
			return 'Org default'
		case 'auto':
			return 'Only match'
		case 'none':
			return 'Nothing mapped'
		default: {
			const exhaustive: never = source
			return exhaustive
		}
	}
}

export type MappingStatusTone = 'ok' | 'muted' | 'warning' | 'danger'

export function mappingStatusLabel(
	status: EffectiveCredentialMappingStatus,
	options: { hasPossibleMatch?: boolean } = {},
): {
	label: string
	tone: MappingStatusTone
} {
	switch (status) {
		case 'ready':
			return { label: 'Ready', tone: 'ok' }
		case 'none':
			return { label: 'None on purpose', tone: 'muted' }
		case 'unbound':
			return options.hasPossibleMatch
				? { label: 'Not linked yet', tone: 'warning' }
				: { label: 'No credential', tone: 'danger' }
		case 'ambiguous':
			return { label: 'Pick one', tone: 'warning' }
		case 'unusable':
			return { label: 'Can’t use it', tone: 'danger' }
		case 'expired':
			return { label: 'Expired', tone: 'warning' }
		default: {
			const exhaustive: never = status
			return exhaustive
		}
	}
}

/** What to do about one incomplete mapping, in a sentence. */
export function describeIncompleteMapping(
	item: PackageCredentialsIncomplete,
	options: {
		/** False when this viewer cannot edit the mapping that would link a match. */
		canLink?: boolean
		supplier?: PackageCredentialNeedView['supplier']
	} = {},
): string {
	const where =
		item.where.type === 'default'
			? 'Runs'
			: item.where.enablementId
				? `${describeTrigger(item.where.trigger)} (one of your instances) runs`
				: `${describeTrigger(item.where.trigger)} runs`
	switch (item.status) {
		case 'unbound': {
			const matches = item.possibleMatches ?? []
			if (matches.length === 0) {
				return `${where} have no credential for “${item.needKey}”. Add one or map an existing one.`
			}
			const names = matches
				.map((ref) => `“${credentialRefLabel(ref)}”`)
				.join(', ')
			const tab = packageCredentialsTabLabel(
				incompleteMappingTab(item, options.supplier),
			)
			const match =
				options.canLink === false
					? `${names} ${matches.length === 1 ? 'looks like a match' : 'look like matches'}; ask a package manager to link it.`
					: matches.length === 1
						? `${names} looks like a match; pick it in ${tab}.`
						: `${names} look like matches; pick one in ${tab}.`
			return `${where} aren’t linked to a credential for “${item.needKey}” yet. ${match}`
		}
		case 'ambiguous':
			return `${where} match several credentials for “${item.needKey}”. Pick one so runs don’t fail.`
		case 'unusable':
			return `${where} map “${item.needKey}” to a credential that can no longer be used. Map another one.`
		default: {
			const exhaustive: never = item.status
			return exhaustive
		}
	}
}

/** The tab that fixes an incomplete mapping. */
/** Publisher trigger mappings are read-only, so their fix is the org default in Mappings. */
export function incompleteMappingTab(
	item: PackageCredentialsIncomplete,
	supplier?: PackageCredentialNeedView['supplier'],
): PackageCredentialsTab {
	return item.where.type === 'default' || supplier === 'publisher'
		? 'mappings'
		: 'triggers'
}

export function credentialRefHref(orgSlug: string, ref: CredentialRef) {
	return orgResourcePath(orgSlug, 'credentials', encodeURIComponent(ref.id))
}

export function credentialRefLabel(ref: CredentialRef) {
	return ref.scope === 'personal' ? `${ref.name} (yours)` : ref.name
}

/** Needs whose effective mapping is not ready, so the Credentials tab can lead with them. */
export function sortNeedsByAttention(
	needs: ReadonlyArray<PackageCredentialNeedView>,
) {
	const rank = (need: PackageCredentialNeedView) => {
		switch (need.effective.status) {
			case 'ready':
			case 'none':
			case 'expired':
				// Expired stays bound (self-refreshing package Keys need no owner fix).
				return 1
			case 'unbound':
			case 'ambiguous':
			case 'unusable':
				return 0
			default: {
				const exhaustive: never = need.effective.status
				return exhaustive
			}
		}
	}
	return [...needs].sort(
		(a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key),
	)
}

/**
 * The API withholds a trigger's mappings whenever someone else's enablement
 * owns it, in every state, so an empty list there is not "no overrides".
 */
export function withheldTriggerMappingsNote(trigger: PackageTriggerView) {
	const enablement = trigger.enablement
	if (!enablement || enablement.enabledByYou) return null
	const state = enablement.state
	switch (state) {
		case 'on':
			return 'Someone else turned this trigger on, so its credential mappings are theirs.'
		case 'paused':
			return 'Someone else turned this trigger on (it is paused), so its credential mappings are theirs.'
		case 'off':
			return 'Someone else set up this trigger (it is off), so its credential mappings are theirs.'
		default: {
			const exhaustive: never = state
			return exhaustive
		}
	}
}

export function triggerEnablementStateLabel(input: {
	state: 'on' | 'paused' | 'off'
	enabledByYou: boolean
}) {
	const who = input.enabledByYou ? 'by you' : 'by someone else'
	switch (input.state) {
		case 'on':
			return `On ${who}`
		case 'paused':
			return `Paused ${who}`
		case 'off':
			return 'Off'
		default: {
			const exhaustive: never = input.state
			return exhaustive
		}
	}
}

export function triggerStateLabel(trigger: PackageTriggerView) {
	if (!trigger.enablement) {
		return trigger.trigger.kind === 'webhook' && trigger.instanceId === null
			? 'Not minted'
			: 'Off'
	}
	return triggerEnablementStateLabel(trigger.enablement)
}

/** Whether the Triggers tab may offer an on/off switch for this declared trigger. */
export function canToggleTriggerEnablement(trigger: PackageTriggerView) {
	if (!trigger.canEdit) return false
	if (
		trigger.trigger.kind === 'subscription' &&
		isInboundEmailApprovalTopic(trigger.trigger.name)
	) {
		// Inbound email runs per sender via Approve; enablementEnable refuses it.
		return false
	}
	if (trigger.trigger.kind === 'webhook' && trigger.instanceId === null) {
		return false
	}
	// A webhook's first turn-on needs Approve; the switch only toggles an
	// enablement that already exists (or a cron / subscription).
	if (trigger.trigger.kind === 'webhook' && trigger.enablement === null) {
		return false
	}
	return true
}
