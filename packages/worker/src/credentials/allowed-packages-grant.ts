/**
 * The one write path that adds a package to a user credential's non-empty
 * `allowed_packages` list on behalf of issue #4129 grandfathering: the admin
 * backfill and the enforcement safety window both use it.
 */
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import {
	credentialAuditActions,
	listDelta,
	recordCredentialAudit,
} from '#worker/credentials/credential-audit.ts'
import {
	parseAllowedPackages,
	stringifyAllowedPackages,
} from '#mcp/secrets/allowed-packages.ts'
import { type OrgAuditWriter } from '#worker/orgs/org-audit.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export const allowedPackagesGrandfatherReason = 'grandfathered for #4129'

export type AllowedPackagesGrandfatherSource =
	| 'static'
	| 'log'
	| 'static+log'
	| 'safety_window'

/** D1 `CURRENT_TIMESTAMP` rows have no `T`/`Z`; compare as instants. */
export function isBefore(timestamp: string, instant: string) {
	const normalized = timestamp.includes('T')
		? timestamp
		: `${timestamp.replace(' ', 'T')}Z`
	const time = Date.parse(normalized)
	return Number.isFinite(time) && time < Date.parse(instant)
}

export type GrantOutcome =
	| 'granted'
	| 'already_allowed'
	| 'missing'
	| 'conflict'
	| 'not_eligible'

/**
 * Add one package to a user credential's non-empty allowed list, guarded on
 * the list read so a concurrent edit is never overwritten. Audits with the
 * #4129 reason and source. Never notifies the owner.
 */
export async function grantGrandfatheredPackageAccess(input: {
	db: D1Database
	audit: OrgAuditWriter | null
	ownerId: string
	credentialId: string
	packageId: string
	source: AllowedPackagesGrandfatherSource
	/** Safety window: refuse credentials created at or after this instant. */
	credentialCreatedBefore?: string
}): Promise<GrantOutcome> {
	const row = await input.db
		.prepare(
			`SELECT e.id AS id, e.name AS name, e.allowed_packages AS allowed_packages,
				e.created_at AS created_at
			 FROM secret_entries e
			 JOIN secret_buckets b ON b.id = e.bucket_id
			 WHERE e.id = ? AND b.user_id = ? AND b.scope = 'user'${andLiveDeletedAtSql('e')}${andLiveDeletedAtSql('b')}`,
		)
		.bind(input.credentialId, input.ownerId)
		.first<{
			id: string
			name: string
			allowed_packages: string
			created_at: string
		}>()
	if (!row) return 'missing'
	if (
		input.credentialCreatedBefore &&
		!isBefore(row.created_at, input.credentialCreatedBefore)
	) {
		return 'not_eligible'
	}
	const before = parseAllowedPackages(row.allowed_packages)
	if (before.length === 0 || before.includes(input.packageId)) {
		return 'already_allowed'
	}
	const after = parseAllowedPackages(
		stringifyAllowedPackages([...before, input.packageId]),
	)
	const now = new Date().toISOString()
	const update = await input.db
		.prepare(
			`UPDATE secret_entries SET allowed_packages = ?, updated_at = ?
			 WHERE id = ? AND allowed_packages = ? AND deleted_at IS NULL`,
		)
		.bind(stringifyAllowedPackages(after), now, row.id, row.allowed_packages)
		.run()
	if (!update.meta?.changes) return 'conflict'
	await recordCredentialAudit(input.audit, {
		orgId: ownerIdFromStored(input.ownerId),
		credential: { id: row.id, kind: 'secret', name: row.name },
		action: credentialAuditActions.allowedPackagesUpdated,
		details: {
			packages: listDelta(before, after),
			fields: ['allowed_packages'],
			reason: allowedPackagesGrandfatherReason,
			source: input.source,
		},
	})
	return 'granted'
}
