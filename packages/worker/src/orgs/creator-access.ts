import { type OrgResourceType } from '@kody-internal/shared/org-permissions.ts'
import { type GrantResourceType, upsertGrant } from './access-writes.ts'
import { grantProfileCreatorAccess } from '#worker/profiles/creator-grants.ts'
import { orgAuditWriterForPerson, type OrgAuditWriter } from './org-audit.ts'

export type CreatedResource = {
	resourceType: Exclude<GrantResourceType, 'org'>
	resourceId: string
	/** A credential's permission family (`secret` or `integration`). */
	family?: OrgResourceType
}

/** A package and its app share one id; both get a creator grant. */
export function createdPackageResources(
	packageId: string,
): Array<CreatedResource> {
	return [
		{ resourceType: 'package', resourceId: packageId },
		{ resourceType: 'app', resourceId: packageId },
	]
}

/** `revoked` means only soft-deleted grants exist for this person. */
export type UserGrantState = 'live' | 'revoked' | 'none'

/**
 * Give a non-owner member `manage` on what they just created, so a member
 * with `package:create` (or `secret:create`, `integration:create`) can keep
 * using it. Owners already hold everything. An existing grant for the creator
 * is left alone. Idempotent: the backfill reuses it.
 */
export async function grantCreatorAccess(input: {
	env: Pick<Env, 'APP_DB'> & Partial<Env>
	orgId: string
	creatorUserId: string | null | undefined
	resources: ReadonlyArray<CreatedResource>
	/** The create's own audit writer; defaults to one for the creator. */
	audit?: OrgAuditWriter | null
	/** Also skip a resource whose grant for the creator was revoked (backfill). */
	neverRegrant?: boolean
	/**
	 * The profile the creator acted as (ADR 0092). It gets its own `manage`
	 * grant, even under an owner, since owner status does not reach a profile.
	 */
	creatorProfileId?: string | null
}): Promise<{ granted: number }> {
	const creatorUserId = input.creatorUserId
	if (!creatorUserId || input.resources.length === 0) return { granted: 0 }
	const profileGranted = input.creatorProfileId
		? (
				await grantProfileCreatorAccess({
					db: input.env.APP_DB,
					orgId: input.orgId,
					profileId: input.creatorProfileId,
					createdByUserId: creatorUserId,
					resources: input.resources,
				})
			).granted
		: 0
	const person = await grantPersonCreatorAccess({ ...input, creatorUserId })
	return { granted: person.granted + profileGranted }
}

async function grantPersonCreatorAccess(input: {
	env: Pick<Env, 'APP_DB'> & Partial<Env>
	orgId: string
	creatorUserId: string
	resources: ReadonlyArray<CreatedResource>
	audit?: OrgAuditWriter | null
	neverRegrant?: boolean
}): Promise<{ granted: number }> {
	const creatorUserId = input.creatorUserId
	const role = await findMemberRole(input.env.APP_DB, {
		orgId: input.orgId,
		userId: creatorUserId,
	})
	if (role == null || role === 'owner') return { granted: 0 }
	const audit =
		input.audit ??
		orgAuditWriterForPerson(input.env as Env, { userId: creatorUserId })
	let granted = 0
	for (const resource of input.resources) {
		const state = await findUserGrantState(input.env.APP_DB, {
			orgId: input.orgId,
			resource,
			userId: creatorUserId,
		})
		if (state === 'live' || (state === 'revoked' && input.neverRegrant)) {
			continue
		}
		try {
			await upsertGrant({
				db: input.env.APP_DB,
				orgId: input.orgId,
				resourceType: resource.resourceType,
				resourceId: resource.resourceId,
				...(resource.family ? { family: resource.family } : {}),
				subject: { type: 'user', id: creatorUserId },
				preset: 'manage',
				permissions: null,
				createdByUserId: creatorUserId,
				origin: 'created',
				audit,
			})
			granted += 1
		} catch (error) {
			// A concurrent write claimed the live (resource, subject) slot first.
			if (String(error).includes('UNIQUE constraint failed')) continue
			throw error
		}
	}
	return { granted }
}

export async function findMemberRole(
	db: D1Database,
	input: { orgId: string; userId: string },
) {
	const row = await db
		.prepare(
			`SELECT role FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(input.orgId, input.userId)
		.first<{ role: string }>()
	return row?.role ?? null
}

export async function findUserGrantState(
	db: D1Database,
	input: { orgId: string; resource: CreatedResource; userId: string },
): Promise<UserGrantState> {
	const row = await db
		.prepare(
			`SELECT MAX(deleted_at IS NULL) AS live FROM grants
			 WHERE org_id = ? AND resource_type = ? AND resource_id = ?
			   AND subject_type = 'user' AND subject_id = ?`,
		)
		.bind(
			input.orgId,
			input.resource.resourceType,
			input.resource.resourceId,
			input.userId,
		)
		.first<{ live: number | null }>()
	if (row?.live == null) return 'none'
	return row.live === 1 ? 'live' : 'revoked'
}
