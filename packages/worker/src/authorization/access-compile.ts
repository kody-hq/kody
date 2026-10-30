/**
 * Compile effective permissions for one (org, actor) from memberships, team
 * memberships, and grants (Teams spec §4.3). The normalized tables are the
 * source of truth; access_cache is a derived write-through cache keyed by
 * access_epoch.
 */
import {
	isOrgPermission,
	orgPermissions,
	type OrgGrantResourceType,
	type OrgPermission,
} from '@kody-internal/shared/org-permissions.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	type OrgRole,
	type RequestContext,
} from '@kody-internal/shared/request-context.ts'
import {
	type GrantSubjectChoices,
	grantSubjectMatchSql,
} from '#worker/authorization/grant-subjects.ts'
import {
	defaultOrgMemberCreation,
	memberCreationFromRow,
	memberCreationGrants,
	type OrgMemberCreation,
} from '#worker/authorization/member-creation-permissions.ts'
import { memoizePerRequest } from '#worker/request-context.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

const allOrgPermissions: ReadonlySet<OrgPermission> = new Set(orgPermissions)

export const rolePresets: Record<OrgRole, ReadonlySet<OrgPermission>> = {
	owner: allOrgPermissions,
	member: new Set(['org:read', 'member:read', 'team:read', 'search:read']),
	billing: new Set([
		'org:read',
		'member:read',
		'search:read',
		'billing:read',
		'billing:write',
	]),
}

/** Outside collaborators always hold search:read so tokens can narrow to it. */
const outsideCollaboratorBasics: ReadonlySet<OrgPermission> = new Set([
	'search:read',
])

export type CompiledAccess = {
	orgId: OwnerId
	epoch: number
	/** True when the actor is a live Owner of the org. */
	isOwner: boolean
	/** Org-level permissions from role + grants on the org resource. */
	orgPermissions: ReadonlySet<OrgPermission>
	/**
	 * Resource grants keyed by `${resourceType}:${resourceId}`. Org-resource
	 * grants are folded into `orgPermissions` instead.
	 */
	resourcePermissions: ReadonlyMap<string, ReadonlySet<OrgPermission>>
	/**
	 * The earliest expiry among the grants this compile used (ISO), or null
	 * when none expires. The compile is stale from that moment.
	 */
	validUntil: string | null
}

/** True once `compiled` has passed its `validUntil`. */
export function compiledAccessExpired(
	compiled: Pick<CompiledAccess, 'validUntil'>,
	now: string = new Date().toISOString(),
) {
	return compiled.validUntil !== null && compiled.validUntil <= now
}

export function resourceGrantKey(
	resourceType: OrgGrantResourceType | 'org',
	resourceId: string,
) {
	return `${resourceType}:${resourceId}`
}

type GrantRow = {
	resource_type: string
	resource_id: string
	permission: string
	expires_at: string | null
}

type AccessCacheRow = {
	epoch: number
	compiled_json: string
	valid_until: string | null
}

function parseCompiledJson(
	json: string,
): Omit<CompiledAccess, 'orgId' | 'epoch' | 'validUntil'> | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(json)
	} catch {
		return null
	}
	if (!parsed || typeof parsed !== 'object') return null
	const record = parsed as {
		isOwner?: unknown
		orgPermissions?: unknown
		resourcePermissions?: unknown
	}
	if (typeof record.isOwner !== 'boolean') return null
	if (!Array.isArray(record.orgPermissions)) return null
	if (
		!record.resourcePermissions ||
		typeof record.resourcePermissions !== 'object'
	) {
		return null
	}
	const orgPerms = new Set<OrgPermission>()
	for (const value of record.orgPermissions) {
		if (!isOrgPermission(value)) return null
		orgPerms.add(value)
	}
	const resourcePermissions = new Map<string, ReadonlySet<OrgPermission>>()
	for (const [key, value] of Object.entries(record.resourcePermissions)) {
		if (!Array.isArray(value)) return null
		const set = new Set<OrgPermission>()
		for (const permission of value) {
			if (!isOrgPermission(permission)) return null
			set.add(permission)
		}
		resourcePermissions.set(key, set)
	}
	return {
		isOwner: record.isOwner,
		orgPermissions: orgPerms,
		resourcePermissions,
	}
}

function serializeCompiled(
	compiled: Omit<CompiledAccess, 'orgId' | 'epoch' | 'validUntil'>,
): string {
	const resourcePermissions: Record<string, Array<string>> = {}
	for (const [key, set] of compiled.resourcePermissions) {
		resourcePermissions[key] = [...set].sort()
	}
	return JSON.stringify({
		isOwner: compiled.isOwner,
		orgPermissions: [...compiled.orgPermissions].sort(),
		resourcePermissions,
	})
}

function applyGrantRows(
	rows: ReadonlyArray<GrantRow>,
	orgId: string,
	orgPermissionsOut: Set<OrgPermission>,
	resourcePermissionsOut: Map<string, Set<OrgPermission>>,
) {
	for (const row of rows) {
		if (!isOrgPermission(row.permission)) continue
		if (row.resource_type === 'org') {
			if (row.resource_id !== orgId) continue
			orgPermissionsOut.add(row.permission)
			continue
		}
		const key = resourceGrantKey(
			row.resource_type as OrgGrantResourceType,
			row.resource_id,
		)
		let set = resourcePermissionsOut.get(key)
		if (!set) {
			set = new Set()
			resourcePermissionsOut.set(key, set)
		}
		set.add(row.permission)
	}
}

/** Ad-hoc rule: package:execute somewhere ⇒ org:execute for ad-hoc code. */
function applyAdHocRule(
	orgPermissionsOut: Set<OrgPermission>,
	resourcePermissions: ReadonlyMap<string, ReadonlySet<OrgPermission>>,
) {
	if (orgPermissionsOut.has('org:execute')) return
	for (const [key, permissions] of resourcePermissions) {
		if (!key.startsWith('package:')) continue
		if (permissions.has('package:execute')) {
			orgPermissionsOut.add('org:execute')
			return
		}
	}
}

/** Compiled access honors every subject type a grant can name. */
export const liveGrantRowSubjects = {
	user: 'include',
	team: 'include',
	org: 'include',
	profile: {
		exclude:
			'Profile grants narrow a profile; they never grant the person behind it.',
	},
} as const satisfies GrantSubjectChoices

async function loadLiveGrantRows(
	db: D1Database,
	orgId: string,
	userId: string,
	now: string,
): Promise<Array<GrantRow>> {
	const subjectMatch = grantSubjectMatchSql({
		subjects: liveGrantRowSubjects,
		personId: userId,
		boundOrgId: orgId,
		now,
	})
	const result = await db
		.prepare(
			`SELECT g.resource_type AS resource_type,
			        g.resource_id AS resource_id,
			        gp.permission AS permission,
			        g.expires_at AS expires_at
			 FROM grants g
			 INNER JOIN grant_permissions gp ON gp.grant_id = g.id
			 WHERE g.org_id = ?
			   AND g.deleted_at IS NULL
			   AND ${subjectMatch.sql}`,
		)
		.bind(orgId, ...subjectMatch.binds)
		.all<GrantRow>()
	return result.results ?? []
}

function dbCanPrepare(db: D1Database) {
	return typeof db?.prepare === 'function'
}

type OrgAccessRow = {
	epoch: number
	memberCreation: OrgMemberCreation
}

async function readOrgEpoch(
	db: D1Database,
	orgId: string,
): Promise<OrgAccessRow | null> {
	if (!dbCanPrepare(db)) {
		throw new Error(
			`APP_DB cannot prepare statements while compiling access for org ${orgId}.`,
		)
	}
	try {
		const row = await db
			.prepare(
				`SELECT access_epoch, members_can_create_packages,
				        members_can_create_credentials
				 FROM orgs WHERE id = ?${andLiveDeletedAtSql()}`,
			)
			.bind(orgId)
			.first<{
				access_epoch: number
				members_can_create_packages: number | null
				members_can_create_credentials: number | null
			}>()
		if (!row) return null
		return {
			epoch: Number(row.access_epoch) || 0,
			memberCreation: memberCreationFromRow(row),
		}
	} catch (error) {
		// Incomplete test DBs may lack the orgs table; production always has it
		// after P3. Surface the error for non-owner callers instead.
		if (
			error instanceof Error &&
			/no such table:\s*orgs/i.test(error.message)
		) {
			return null
		}
		throw error
	}
}

async function readAccessCache(
	db: D1Database,
	orgId: string,
	userId: string,
	epoch: number,
	now: string,
): Promise<CompiledAccess | null> {
	const row = await db
		.prepare(
			`SELECT epoch, compiled_json, valid_until
			 FROM access_cache
			 WHERE org_id = ? AND user_id = ?`,
		)
		.bind(orgId, userId)
		.first<AccessCacheRow>()
	if (!row || Number(row.epoch) !== epoch) return null
	const validUntil = row.valid_until ?? null
	if (compiledAccessExpired({ validUntil }, now)) return null
	const parsed = parseCompiledJson(row.compiled_json)
	if (!parsed) return null
	return {
		orgId: orgId as OwnerId,
		epoch,
		...parsed,
		validUntil,
	}
}

async function writeAccessCache(
	db: D1Database,
	compiled: CompiledAccess,
	userId: string,
) {
	await db
		.prepare(
			`INSERT INTO access_cache (org_id, user_id, epoch, compiled_json, computed_at, valid_until)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(org_id, user_id) DO UPDATE SET
			   epoch = excluded.epoch,
			   compiled_json = excluded.compiled_json,
			   computed_at = excluded.computed_at,
			   valid_until = excluded.valid_until`,
		)
		.bind(
			compiled.orgId,
			userId,
			compiled.epoch,
			serializeCompiled(compiled),
			new Date().toISOString(),
			compiled.validUntil,
		)
		.run()
}

function compileFromRoleAndGrants(input: {
	orgId: OwnerId
	epoch: number
	role: OrgRole | null
	grantRows: ReadonlyArray<GrantRow>
	/** The org's member-creation settings; they add to the Member preset. */
	memberCreation?: OrgMemberCreation
}): CompiledAccess {
	const isOwner = input.role === 'owner'
	if (isOwner) {
		return {
			orgId: input.orgId,
			epoch: input.epoch,
			isOwner: true,
			orgPermissions: allOrgPermissions,
			resourcePermissions: new Map(),
			validUntil: null,
		}
	}

	const orgPerms = new Set<OrgPermission>(
		input.role ? rolePresets[input.role] : outsideCollaboratorBasics,
	)
	if (input.role === 'member') {
		for (const permission of memberCreationGrants(
			input.memberCreation ?? defaultOrgMemberCreation,
		)) {
			orgPerms.add(permission)
		}
	}
	const resourcePermissions = new Map<string, Set<OrgPermission>>()
	applyGrantRows(input.grantRows, input.orgId, orgPerms, resourcePermissions)
	applyAdHocRule(orgPerms, resourcePermissions)
	let validUntil: string | null = null
	for (const row of input.grantRows) {
		if (
			row.expires_at &&
			(validUntil === null || row.expires_at < validUntil)
		) {
			validUntil = row.expires_at
		}
	}
	return {
		orgId: input.orgId,
		epoch: input.epoch,
		isOwner: false,
		orgPermissions: orgPerms,
		resourcePermissions,
		validUntil,
	}
}

function noCompiledAccess(orgId: OwnerId): CompiledAccess {
	return {
		orgId,
		epoch: 0,
		isOwner: false,
		orgPermissions: new Set(),
		resourcePermissions: new Map(),
		validUntil: null,
	}
}

function ownerCompiledAccess(orgId: OwnerId, epoch: number): CompiledAccess {
	return {
		orgId,
		epoch,
		isOwner: true,
		orgPermissions: allOrgPermissions,
		resourcePermissions: new Map(),
		validUntil: null,
	}
}

/**
 * Compile what `request`'s actor may do in `request.org`. Results are cached
 * in access_cache by epoch.
 *
 * Owners hold every permission without reading grants or access_epoch (the
 * role alone decides). Member, Billing, and outside collaborator paths load
 * grants and require a real APP_DB. A request with no person holds nothing:
 * every run acts as a real person (a trigger as its enabler).
 */
export async function compileAccessForRequest(input: {
	db: D1Database
	request: RequestContext
}): Promise<CompiledAccess> {
	const { request } = input
	if (!request.actor) return noCompiledAccess(request.org.id)
	return await compileAccessForActor({
		db: input.db,
		orgId: request.org.id,
		userId: request.actor.userId,
		role: request.membership?.role ?? null,
	})
}

/**
 * Same compile as {@link compileAccessForRequest} for a person who is not
 * the caller (for example, checking that an invite link's creator can still
 * share). `role` is their live membership role, or null for an outside
 * collaborator.
 */
export async function compileAccessForActor(input: {
	db: D1Database
	orgId: OwnerId
	userId: string
	role: OrgRole | null
}): Promise<CompiledAccess> {
	const { orgId, userId, role } = input
	if (role === 'owner') return ownerCompiledAccess(orgId, 0)

	// One HTTP request can derive many request contexts for the same person
	// (a page checking several package permissions), so share the compile
	// across the request. Every new request still reads access_epoch, and a
	// long run recompiles once a grant it used expires.
	return await memoizePerRequest({
		key: `compiled-access:${orgId}:${userId}:${role ?? 'none'}`,
		load: () => compileUncached(input.db, orgId, userId, role),
		isFresh: (compiled) => !compiledAccessExpired(compiled),
	})
}

async function compileUncached(
	db: D1Database,
	orgId: OwnerId,
	userId: string,
	role: OrgRole | null,
): Promise<CompiledAccess> {
	const orgRow = await readOrgEpoch(db, orgId)
	if (orgRow === null) {
		throw new Error(`Org ${orgId} was not found while compiling access.`)
	}
	const { epoch, memberCreation } = orgRow
	const now = new Date().toISOString()

	const cached = await readAccessCache(db, orgId, userId, epoch, now)
	if (cached) return cached

	const grantRows = await loadLiveGrantRows(db, orgId, userId, now)
	const compiled = compileFromRoleAndGrants({
		orgId,
		epoch,
		role,
		grantRows,
		memberCreation,
	})
	try {
		await writeAccessCache(db, compiled, userId)
	} catch {
		// Cache is derived; a write failure must not block the request.
	}
	return compiled
}

/**
 * Bump access_epoch so the next request recompiles. Same-batch with writers.
 * `onlyIfPreviousChanged` skips the bump when the statement right before it
 * in the batch changed no row (SQLite `changes()`), so a no-op write keeps the
 * org's cached access decisions.
 */
export function bumpAccessEpochStatement(
	db: D1Database,
	orgId: string,
	options: { onlyIfPreviousChanged?: boolean } = {},
) {
	const previousChangedSql = options.onlyIfPreviousChanged
		? ' AND changes() > 0'
		: ''
	return db
		.prepare(
			`UPDATE orgs
			 SET access_epoch = access_epoch + 1,
			     updated_at = ?
			 WHERE id = ?${andLiveDeletedAtSql()}${previousChangedSql}`,
		)
		.bind(new Date().toISOString(), orgId)
}

export { allOrgPermissions }
