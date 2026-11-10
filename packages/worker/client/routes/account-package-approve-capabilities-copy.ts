import { isCredentialKind } from '#universal/credential-contracts.ts'
import { credentialKindLabel } from '#universal/credentials-list.ts'
import type { AccountPackageApproveCapabilitiesLoaderData } from '#universal/loader-data.ts'

export type CapabilityEntry =
	AccountPackageApproveCapabilitiesLoaderData['entries'][number]

/**
 * The dependency on an entry's reach path, or null when only the package
 * itself reaches it. Deduped rows keep the longest path, so a dependency path
 * does not rule out the package also using the entry directly.
 */
export function reachingDependency(entry: CapabilityEntry) {
	return entry.via.length > 1 ? (entry.via.at(-1) ?? null) : null
}

function credentialKindText(kind: string | undefined) {
	if (kind === undefined) return credentialKindLabel('secret')
	return isCredentialKind(kind) ? credentialKindLabel(kind) : kind
}

function credentialReachText(entry: CapabilityEntry) {
	const dependency = reachingDependency(entry)
	if (dependency) return `reachable through its dependency ${dependency}`
	switch (entry.source) {
		case 'need':
			return entry.needKey
				? `fills its declared ${entry.needKey} credential`
				: 'fills a credential it declares'
		case 'mount':
			return 'declared by this package'
		case 'grant':
			return 'you granted this package access'
		case 'package':
			return 'saved for this package only'
		case undefined:
			return 'used by this package'
		default: {
			const exhaustive: never = entry.source
			throw new Error(`Unknown credential source: ${String(exhaustive)}`)
		}
	}
}

export function credentialSummary(entry: CapabilityEntry) {
	return `${credentialKindText(entry.credentialKind)} · ${credentialReachText(entry)}`
}

/**
 * Set when a need still declares the deprecated
 * `ownerCredentialForVisitors` flag, a legacy alias for supplier
 * `publisher`: apps already use the publisher's credentials for every visitor.
 */
export function credentialVisitorsNote(entry: CapabilityEntry) {
	if (!entry.ownerCredentialForVisitors) return null
	const need = entry.needKey ? `The ${entry.needKey} need` : 'A need'
	return `${need} sets ownerCredentialForVisitors, which is deprecated: it is a legacy alias for supplier “publisher”. The app already uses the publisher’s credentials for every visitor.`
}

/** Stable list key: one credential can appear once per visitor-shared need. */
export function credentialEntryKey(entry: CapabilityEntry) {
	const id = entry.credentialId ?? entry.name ?? ''
	return entry.ownerCredentialForVisitors
		? `${id}:visitors:${entry.needKey ?? ''}`
		: id
}

export const noCapabilitiesMessage =
	'This package uses no credentials or other capabilities.'

export type UnboundNeed =
	AccountPackageApproveCapabilitiesLoaderData['unboundNeeds'][number]

/** Whether the bound entries are only part of what the tree declares. */
export function unboundNeedsIntro(hasBoundCredentials: boolean) {
	return hasBoundCredentials
		? 'It also declares these credentials, which nothing fills yet. Approving does not bind them.'
		: 'It declares these credentials, but none has a credential bound yet. Approving does not bind them.'
}

function declaringDependency(item: { from?: string; via: Array<string> }) {
	if (item.from) return item.from
	return item.via.length > 1 ? (item.via.at(-1) ?? null) : null
}

export function unboundNeedSummary(need: UnboundNeed) {
	const what = need.secretProviderPackage
		? 'Secret provider'
		: need.provider
			? `${need.provider} credential`
			: 'Credential'
	const dependency = declaringDependency(need)
	return `${what} · ${dependency ? `declared by its dependency ${dependency}` : 'declared by this package'}`
}

export function unboundNeedState(need: UnboundNeed) {
	if (need.invalid) return `Invalid declaration: ${need.invalid}`
	if (need.secretProviderPackage) {
		return `Filled by your ${need.secretProviderPackage} secret provider binding, not a saved credential`
	}
	return 'No credential bound yet'
}

const manifestFieldLabels: Record<string, string> = {
	secretMounts: 'Secret mounts',
	secretProvider: 'Secret provider',
	subscriptions: 'Event subscriptions',
	emits: 'Emitted events',
	jobs: 'Scheduled jobs',
	webhooks: 'Webhooks',
}

export function manifestFieldLabel(field: string) {
	return manifestFieldLabels[field] ?? field
}

export function declaredFieldSummary(item: {
	field: string
	via: Array<string>
}) {
	const dependency = declaringDependency(item)
	return dependency
		? `Its dependency ${dependency} declares kody.${item.field}.`
		: `This package declares kody.${item.field}.`
}

type SelfPublishReason = NonNullable<
	AccountPackageApproveCapabilitiesLoaderData['selfPublishBlocker']
>['reasons'][number]

function namedNeeds(needs: NonNullable<SelfPublishReason['needs']>) {
	return needs
		.map((need) =>
			need.description.trim()
				? `${need.key} (${need.description.trim().replace(/[.!?]$/, '')})`
				: need.key,
		)
		.join(', ')
}

/** Plain-language line for one reason self-publish does not apply. */
export function selfPublishReasonText(
	reason: SelfPublishReason,
	rootSourceId: string,
) {
	const who =
		reason.sourceId && reason.sourceId !== rootSourceId
			? 'A dependency'
			: 'This package'
	switch (reason.kind) {
		case 'credential_needs': {
			const count = reason.needCount ?? reason.needs?.length ?? 1
			const needs =
				reason.needs && reason.needs.length > 0
					? `: ${namedNeeds(reason.needs)}`
					: ''
			const executor = reason.executorNeedCount ?? 0
			const visitors =
				executor > 0 && executor >= count
					? ' Visitors supply these, but going internet-visible still needs your approval.'
					: ''
			return `${who} declares ${count === 1 ? 'a credential need' : `${String(count)} credential needs`}${needs}.${visitors}`
		}
		case 'credential_entry': {
			const label = reason.name ?? 'a credential'
			const dependency =
				reason.via && reason.via.length > 1 ? reason.via.at(-1) : null
			return dependency
				? `Its dependency ${dependency} can use ${label}.`
				: `It can use ${label}.`
		}
		case 'storage_entry': {
			if (reason.assumed) {
				return 'It is assumed to use package storage because its published source could not be read.'
			}
			const matches = reason.matches ?? []
			if (matches.length === 0) return 'It can save and read its own data.'
			const shown = matches
				.slice(0, 3)
				.map(
					(match) => `${match.path}:${String(match.line)} (${match.pattern})`,
				)
				.join(', ')
			const more =
				matches.length > 3 ? ` and ${String(matches.length - 3)} more` : ''
			return `It uses package storage at ${shown}${more}.`
		}
		case 'realtime_entry':
			return reason.anonymousRealtime === 'two-way'
				? 'Visitors who are not signed in can open live connections and send messages to its realtime code.'
				: 'Visitors who are not signed in can open live connections that receive its broadcasts.'
		case 'manifest_field':
			return reason.field
				? `${who} declares ${manifestFieldLabel(reason.field).toLowerCase()} (kody.${reason.field}).`
				: `${who} declares a capability.`
		case 'unpublished':
			return `${who} has no published version.`
		case 'stale_dependencies':
			return 'A dependency was published again since this package was. Publish this package again.'
		case 'not_audited':
			return 'No passing security audit is recorded for this version.'
		case 'audit_concerns':
			return 'The security audit for this version raised concerns.'
		case 'not_permitted':
			return 'You do not have permission to publish this package.'
		default:
			return 'Something in this package needs your approval.'
	}
}

export function storageSummary(entry: CapabilityEntry) {
	const dependency = reachingDependency(entry)
	return dependency
		? `Its dependency ${dependency} can save and read its own data.`
		: 'This package can save and read its own data.'
}

const credentialValuesNote = 'Credential values never appear here.'

function sentence(text: string) {
	const trimmed = text.trim()
	if (trimmed.length === 0) return trimmed
	return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/**
 * Page title and lead copy follow what is actually waiting. Public / internet
 * visibility is mentioned only when a went_public request is pending or the
 * page is the capability-set pin for internet-visible serving.
 */
export function approveCapabilitiesPageCopy(
	payload: AccountPackageApproveCapabilitiesLoaderData,
) {
	const pending = payload.pendingApprovals
	const hasWentPublic = pending.some(
		(approval) => approval.reason === 'went_public',
	)
	const hasCredentialNeeds = pending.some(
		(approval) => approval.reason === 'credential_needs_changed',
	)
	if (pending.length > 0 && hasCredentialNeeds && !hasWentPublic) {
		const changeLines = pending.flatMap((approval) => approval.changes)
		const what =
			changeLines.length > 0
				? changeLines.map(sentence).join(' ')
				: 'This version changes the package’s credential needs.'
		return {
			title: 'Approve credential needs',
			description: `${what} The previously published version keeps running until you approve. ${credentialValuesNote}`,
			mentionInternet: false,
		}
	}
	if (pending.length > 0 && hasWentPublic) {
		return {
			title: 'Approve package changes',
			description: hasCredentialNeeds
				? `Review the credential and internet-visibility changes below. ${credentialValuesNote}`
				: `Approving turns on internet-visible serving for this package. ${credentialValuesNote}`,
			mentionInternet: true,
		}
	}
	if (payload.package.isInternetVisible) {
		return {
			title: 'Approve internet-visible capabilities',
			description: `${payload.package.name} is served on the public internet. Check what it can use before you re-approve. ${credentialValuesNote}`,
			mentionInternet: true,
		}
	}
	return {
		title: 'Approve internet-visible capabilities',
		description: `Before ${payload.package.name} is served on the public internet, check what it can use. ${credentialValuesNote}`,
		mentionInternet: true,
	}
}

export function credentialsSectionIntro(input: {
	isInternetVisible: boolean
	mentionInternet: boolean
}) {
	// Entries are the currently published capability set. On credential-needs-only
	// review, do not attribute them to the paused publish (shown above) or imply
	// they are already reachable via public requests.
	if (!input.mentionInternet) {
		return 'The previously published version can use these.'
	}
	if (input.isInternetVisible) {
		return 'It is internet-visible, so requests from anyone can run code that uses these.'
	}
	return 'Once it is internet-visible, requests from anyone can run code that uses these.'
}
