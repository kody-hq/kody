import { normalizeHandle } from '@kody-internal/shared/handle-rules.ts'

/** How long an admin account-deletion approval link stays usable. */
export const adminAccountDeletionApprovalTtlMs = 24 * 60 * 60 * 1000

export const adminAccountDeletionAcknowledgementReasons = [
	'packages',
	'sole_owner',
	'paid_billing',
] as const

export type AdminAccountDeletionAcknowledgementReason =
	(typeof adminAccountDeletionAcknowledgementReasons)[number]

type AdminAccountDeletionSoleOrg = {
	slug: string
	otherMemberCount: number
}

type AdminAccountDeletionCounts = {
	packages: number
	jobs: number
	credentials: number
	connections: number
	sessions: number
	orgMemberships: number
	memories: number
	webhooks: number
	usage: number
}

/**
 * What an admin reviews before a hard delete. Raw account ids stay off this
 * shape so the page and the modal can render it directly.
 */
export type AdminAccountDeletionSummary = {
	handle: string
	email: string
	createdAt: string
	plan: string
	counts: AdminAccountDeletionCounts
	creditBalanceMicroUsd: number
	acknowledgementRequired: boolean
	acknowledgementReasons: Array<AdminAccountDeletionAcknowledgementReason>
	soleOwnedNonPersonalOrgs: Array<AdminAccountDeletionSoleOrg>
	/** Set when deletion must not proceed (the last remaining admin). */
	deletionBlocked: string | null
}

export type AdminAccountDeletionApprovalState =
	| { status: 'missing' }
	| { status: 'expired' }
	| { status: 'consumed' }
	| {
			status: 'pending'
			summary: AdminAccountDeletionSummary
	  }

export function adminAccountDeletionHandleMatches(
	handle: string,
	typed: string,
) {
	const expected = normalizeHandle(handle)
	const given = normalizeHandle(typed)
	return expected.length > 0 && expected === given
}

export function describeAdminAccountDeletionAcknowledgement(
	summary: Pick<
		AdminAccountDeletionSummary,
		'counts' | 'plan' | 'acknowledgementReasons' | 'soleOwnedNonPersonalOrgs'
	>,
	reason: AdminAccountDeletionAcknowledgementReason,
) {
	switch (reason) {
		case 'packages': {
			const count = summary.counts.packages
			return `Owns ${count} package${count === 1 ? '' : 's'}. Deleting the account removes them.`
		}
		case 'sole_owner': {
			const names = summary.soleOwnedNonPersonalOrgs
				.map((org) => `@${org.slug}`)
				.join(', ')
			return `Sole owner of ${names || 'a non-personal organization'}. Those organizations will be deleted. Other members of them lose that organization; their own accounts stay.`
		}
		case 'paid_billing':
			return `Paid billing (${summary.plan}). The subscription will be canceled.`
		default: {
			const exhaustive: never = reason
			return exhaustive
		}
	}
}

export function canConfirmAdminAccountDeletion(input: {
	handle: string
	typedHandle: string
	acknowledgementRequired: boolean
	acknowledged: boolean
	pending: boolean
}) {
	if (input.pending) return false
	if (!adminAccountDeletionHandleMatches(input.handle, input.typedHandle)) {
		return false
	}
	if (input.acknowledgementRequired && !input.acknowledged) return false
	return true
}

export function canApproveAdminAccountDeletion(input: {
	acknowledgementRequired: boolean
	acknowledged: boolean
	pending: boolean
	deletionBlocked: string | null
}) {
	if (input.pending || input.deletionBlocked) return false
	if (input.acknowledgementRequired && !input.acknowledged) return false
	return true
}
