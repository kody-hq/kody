import {
	chunkArray,
	maxD1BoundParameters,
} from '@kody-internal/shared/chunk.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'

/**
 * The codemod run filter that keeps a fleet run to packages the
 * credential-need enforcement can reach.
 */
export const credentialNeedEnforcementScope = 'credential-need-enforcement'

type ScopedPackage = Pick<SavedPackageRecord, 'id' | 'userId'> & {
	isInternetVisible: boolean
}

/**
 * The packages someone other than their author may run, so their credential
 * use is limited to what they declare: a team-org package, a personal-org
 * package in an org that grants anyone access, an unadopted community fork,
 * or an internet-visible package. Errs toward including a package; declaring
 * needs it did not have to is harmless.
 */
export async function selectCredentialNeedEnforcementScope<
	Package extends ScopedPackage,
>(db: D1Database, packages: ReadonlyArray<Package>): Promise<Array<Package>> {
	if (packages.length === 0) return []
	const orgIds = [...new Set(packages.map((entry) => entry.userId))]
	const packageIds = packages.map((entry) => entry.id)
	const [personalOrgIds, grantedOrgIds, unadoptedForkIds] = await Promise.all([
		Promise.all(
			orgIds.map(async (orgId) =>
				(await isPersonalOrg(db, orgId)) ? orgId : null,
			),
		).then((ids) => new Set(ids.filter((id) => id !== null))),
		selectIds(
			db,
			`SELECT DISTINCT org_id AS id FROM grants
			WHERE deleted_at IS NULL AND org_id IN`,
			orgIds,
		),
		selectIds(
			db,
			`SELECT forked_package_id AS id FROM community_forks
			WHERE adopted_at IS NULL AND forked_package_id IN`,
			packageIds,
		),
	])
	return packages.filter(
		(entry) =>
			entry.isInternetVisible ||
			!personalOrgIds.has(entry.userId) ||
			grantedOrgIds.has(entry.userId) ||
			unadoptedForkIds.has(entry.id),
	)
}

async function selectIds(
	db: D1Database,
	sqlPrefix: string,
	values: ReadonlyArray<string>,
) {
	const ids = new Set<string>()
	for (const chunk of chunkArray(values, maxD1BoundParameters)) {
		const placeholders = chunk.map(() => '?').join(', ')
		const { results } = await db
			.prepare(`${sqlPrefix} (${placeholders})`)
			.bind(...chunk)
			.all<{ id: string }>()
		for (const row of results) ids.add(String(row.id))
	}
	return ids
}
