import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	recordCommittedOrgAuditEvent,
	type OrgAuditWriter,
} from '#worker/orgs/org-audit.ts'

/**
 * Org audit rows for package changes: publish (first or republish), the
 * settings people change on a package (visibility, internet visible, listing),
 * and delete. Rows name the changed fields; visibility also keeps its before
 * and after. Package grants are audited where they are written
 * (`grant.created`, `grant.updated`, `grant.revoked`).
 */
export const packageAuditActions = {
	published: 'package.published',
	updated: 'package.updated',
	deleted: 'package.deleted',
} as const

export type PackageAuditAction =
	(typeof packageAuditActions)[keyof typeof packageAuditActions]

export type PackageVisibility = 'public' | 'private'

export function packageVisibility(isPrivate: boolean): PackageVisibility {
	return isPrivate ? 'private' : 'public'
}

export async function recordPackageAudit(
	writer: OrgAuditWriter | null,
	input: {
		orgId: string
		packageId: string
		name: string
		action: PackageAuditAction
		details?: Record<string, unknown>
	},
) {
	return await recordCommittedOrgAuditEvent(writer, {
		orgId: input.orgId,
		action: input.action,
		resourceType: 'package',
		resourceId: input.packageId,
		details: { name: input.name, fields: [], ...input.details },
	})
}

type PackageSettingsRow = {
	name: string
	is_private: number
	is_internet_visible: number
	hidden: number
}

/** The settings a package audit compares, read before an update. */
export async function readPackageSettingsForAudit(
	db: D1Database,
	input: { userId: string; packageId: string },
) {
	return await db
		.prepare(
			`SELECT name, is_private, is_internet_visible, hidden
			 FROM saved_packages WHERE id = ? AND user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.packageId, input.userId)
		.first<PackageSettingsRow>()
}

/**
 * The audit details for a settings change, or null when nothing a person
 * would see changed.
 */
export function packageSettingsAuditDetails(
	before: PackageSettingsRow,
	after: { isPrivate?: boolean; isInternetVisible?: boolean; hidden?: boolean },
): Record<string, unknown> | null {
	const fields: Array<string> = []
	const details: Record<string, unknown> = {}
	const wasPrivate = Boolean(before.is_private)
	if (after.isPrivate !== undefined && after.isPrivate !== wasPrivate) {
		fields.push('visibility')
		details.visibility = {
			before: packageVisibility(wasPrivate),
			after: packageVisibility(after.isPrivate),
		}
	}
	if (
		after.isInternetVisible !== undefined &&
		after.isInternetVisible !== Boolean(before.is_internet_visible)
	) {
		fields.push('internet_visible')
		details.internetVisible = {
			before: Boolean(before.is_internet_visible),
			after: after.isInternetVisible,
		}
	}
	if (after.hidden !== undefined && after.hidden !== Boolean(before.hidden)) {
		fields.push('hidden')
	}
	if (fields.length === 0) return null
	return { ...details, fields }
}
