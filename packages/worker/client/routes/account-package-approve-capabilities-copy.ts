import { isCredentialKind } from '#universal/credential-contracts.ts'
import { credentialKindLabel } from '#universal/credentials-list.ts'
import { type AccountPackageApproveCapabilitiesLoaderData } from '#universal/loader-data.ts'

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
 * Set for a credential the package lets visitors use
 * (`ownerCredentialForVisitors`), null otherwise. Approving is what turns
 * that on, so it reads as its own line, not part of the summary.
 */
export function credentialVisitorsNote(entry: CapabilityEntry) {
	if (!entry.ownerCredentialForVisitors) return null
	return 'Visitors can use this credential through the app, whether they are signed out or signed in as someone else. They never see its value.'
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
