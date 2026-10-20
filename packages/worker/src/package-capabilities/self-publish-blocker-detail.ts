import {
	type PackageStorageMatch,
	type PackageStorageDetectionPattern,
} from './package-storage-use.ts'
import { type CapabilitySetEntry } from './capability-set.ts'

export type SelfPublishBlocker =
	| 'unpublished'
	| 'stale_dependencies'
	| 'declares_credentials'
	| 'declares_capabilities'
	| 'not_audited'
	| 'audit_concerns'
	| 'not_permitted'

/** Manifest fields that declare a capability beyond the package's storage. */
export const selfPublishCapabilityManifestFields = [
	'secretMounts',
	'secretProvider',
	'subscriptions',
	'emits',
	'jobs',
	'retrievers',
	'webhooks',
] as const

export type SelfPublishCapabilityManifestField =
	(typeof selfPublishCapabilityManifestFields)[number]

export type SelfPublishBlockerReason =
	| {
			kind: 'unpublished'
			sourceId: string
	  }
	| {
			kind: 'stale_dependencies'
			sourceId: string
			pinnedCommit: string
			livePublishedCommit: string | null
	  }
	| {
			kind: 'credential_entry'
			credentialId?: string
			name?: string
			via: Array<string>
	  }
	| {
			kind: 'storage_entry'
			storageId: string
			via: Array<string>
			/** Fail-closed: published source could not be read. */
			assumed?: true
			matches?: Array<PackageStorageMatch>
	  }
	| {
			kind: 'manifest_field'
			field: SelfPublishCapabilityManifestField
			sourceId: string
	  }
	| {
			kind: 'credential_needs'
			sourceId: string
			needCount: number
	  }
	| { kind: 'not_audited' }
	| { kind: 'audit_concerns' }
	| { kind: 'not_permitted' }

export type SelfPublishBlockerDetail = {
	blocker: SelfPublishBlocker
	reasons: Array<SelfPublishBlockerReason>
	/**
	 * One or two sentences for agents and the approval page. No em dashes.
	 * Includes the approval URL when provided.
	 */
	message: string
}

function patternLabel(pattern: PackageStorageDetectionPattern) {
	switch (pattern) {
		case 'packageStorage':
			return 'packageStorage'
		case 'storageQuery':
			return 'storageQuery'
		case 'storageExport':
			return 'storageExport'
		case 'kodyBracket':
			return 'kody[...]'
		case 'bracketKey':
			return 'bracket key'
		default: {
			const exhaustive: never = pattern
			return String(exhaustive)
		}
	}
}

function formatMatch(match: PackageStorageMatch) {
	return `${match.path}:${String(match.line)} (${patternLabel(match.pattern)})`
}

function formatReason(reason: SelfPublishBlockerReason): string {
	switch (reason.kind) {
		case 'unpublished':
			return `Source ${reason.sourceId} has no published commit.`
		case 'stale_dependencies':
			return `Source ${reason.sourceId} is pinned to ${reason.pinnedCommit} but its live published commit is ${reason.livePublishedCommit ?? 'missing'}; publish this package again.`
		case 'credential_entry': {
			const label = reason.name ?? reason.credentialId ?? 'a credential'
			const via =
				reason.via.length > 1 ? ` (via ${reason.via.slice(1).join(' → ')})` : ''
			return `Capability set lists credential ${label}${via}.`
		}
		case 'storage_entry': {
			const via =
				reason.via.length > 1 ? ` via ${reason.via.slice(1).join(' → ')}` : ''
			if (reason.assumed) {
				return `Package storage is assumed for ${reason.storageId}${via} because the published source could not be read.`
			}
			const matches = reason.matches ?? []
			if (matches.length === 0) {
				return `Capability set lists package storage for ${reason.storageId}${via}.`
			}
			const shown = matches.slice(0, 3).map(formatMatch).join('; ')
			const more =
				matches.length > 3 ? ` (+${String(matches.length - 3)} more)` : ''
			return `Package storage detected${via} at ${shown}${more}.`
		}
		case 'manifest_field':
			return `Published manifest for source ${reason.sourceId} declares kody.${reason.field}.`
		case 'credential_needs':
			return `Source ${reason.sourceId} has ${String(reason.needCount)} credential need(s) in its published closure.`
		case 'not_audited':
			return 'No security audit with verdict pass is recorded for the current published commit and capability fingerprint.'
		case 'audit_concerns':
			return 'The security audit for this version has verdict concerns.'
		case 'not_permitted':
			return 'The caller does not have package:publish on this package.'
		default: {
			const exhaustive: never = reason
			return String(exhaustive)
		}
	}
}

/**
 * Build the agent/owner-facing detail for a self-publish blocker. Reasons are
 * already collected by evaluateSelfPublish; this only formats them.
 */
export function buildSelfPublishBlockerDetail(input: {
	blocker: SelfPublishBlocker
	reasons: Array<SelfPublishBlockerReason>
	approvalUrl?: string
}): SelfPublishBlockerDetail {
	const reasonText =
		input.reasons.length > 0
			? input.reasons.map(formatReason).join(' ')
			: defaultBlockerSentence(input.blocker)
	const approval = input.approvalUrl
		? ` Owner approves at ${input.approvalUrl}.`
		: ''
	return {
		blocker: input.blocker,
		reasons: input.reasons,
		message: `${reasonText}${approval}`.trim(),
	}
}

function defaultBlockerSentence(blocker: SelfPublishBlocker) {
	switch (blocker) {
		case 'unpublished':
			return 'A package in the tree is unpublished.'
		case 'stale_dependencies':
			return 'A dependency republished since this package was published.'
		case 'declares_credentials':
			return 'The package or its tree declares credentials.'
		case 'declares_capabilities':
			return 'The package or its tree declares capabilities other than credentials.'
		case 'not_audited':
			return 'No passing security audit is recorded for this version.'
		case 'audit_concerns':
			return 'The security audit for this version has concerns.'
		case 'not_permitted':
			return 'The caller may not publish this package.'
		default: {
			const exhaustive: never = blocker
			return String(exhaustive)
		}
	}
}

export function credentialAndStorageReasonsFromEntries(
	entries: ReadonlyArray<CapabilitySetEntry>,
	storageMatchesByPackageId?: Map<
		string,
		Array<PackageStorageMatch> | 'assumed'
	>,
): {
	blocker: 'declares_credentials' | 'declares_capabilities'
	reasons: Array<SelfPublishBlockerReason>
} | null {
	if (entries.length === 0) return null
	const hasCredential = entries.some((entry) => entry.kind === 'credential')
	const reasons: Array<SelfPublishBlockerReason> = []
	for (const entry of entries) {
		if (entry.kind === 'credential') {
			reasons.push({
				kind: 'credential_entry',
				credentialId: entry.credentialId,
				name: entry.name,
				via: [...entry.via],
			})
			continue
		}
		const detection = entry.storageId
			? storageMatchesByPackageId?.get(entry.storageId)
			: undefined
		reasons.push({
			kind: 'storage_entry',
			storageId: entry.storageId ?? 'unknown',
			via: [...entry.via],
			...(detection === 'assumed'
				? { assumed: true as const }
				: detection && detection.length > 0
					? { matches: detection }
					: {}),
		})
	}
	return {
		blocker: hasCredential ? 'declares_credentials' : 'declares_capabilities',
		reasons,
	}
}
