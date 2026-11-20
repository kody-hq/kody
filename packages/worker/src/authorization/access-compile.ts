/**
 * Compile effective org permissions for a person from roles and grants.
 *
 * Use `compileAccessForRequest` for one request or
 * `compileAccessForRequests` to batch reads across orgs. Grant-based compiles
 * use the derived access_cache keyed by access_epoch.
 */
import {
	chunkArray,
	maxD1BoundParameters,
} from '@kody-internal/shared/chunk.ts'
import { permissionsForGrantPreset } from '@kody-internal/shared/grant-presets.ts'
import {
	isOrgPermission,
	orgPermissions,
	type OrgGrantResourceType,
	type OrgPermission,
} from '@kody-internal/shared/org-permissions.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import type {
	OrgRole,
	RequestContext,
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

/**
 * Admin holds every Owner permission except deleting the org. The Owner-only
 * membership rules (no changing, removing, or promoting to Owner) live in the
 * membership writes, since they depend on the target, not on a permission.
 */
const adminOrgPermissions: ReadonlySet<OrgPermission> = new Set(
	orgPermissions.filter((permission) => permission !== 'org:delete'),
)

export const rolePresets: Record<OrgRole, ReadonlySet<OrgPermission>> = {
	owner: allOrgPermissions,
	admin: adminOrgPermissions,
	member: new Set([
		'org:read',
		'member:read',
		'team:read',
		'search:read',
		'profile:manage',
	]),
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
	/** True when the actor is a live Admin: Owner authority without `org:delete`. */
	isAdmin?: boolean
	/** Org-level permissions from role + grants on the org resource. */
	orgPermissions: ReadonlySet<OrgPermission>
	/**
	 * Resource grants keyed by `${resourceType}:${resourceId}`. Org-resource
	 * grants are folded into `orgPermissions` instead.
	 */
	resourcePermissions: ReadonlyMap<string, ReadonlySet<OrgPermission>>
	/**
	 * Resource keys where one of the actor's grants allows changes despite
	 * unmappable credentials. Absent on caches written before the column.
	 */
	unmappableChangesAllowed?: ReadonlySet<string>
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
	allow_unmappable_credential_changes?: number | null
}

type AccessCacheRow = {
	epoch: number
	compiled_json: string
	valid_until: string | null
}

/**
 * Bumped when a compile starts deriving permissions an older cache row lacks,
 * so those rows recompile instead of serving stale access. 2: Use on
 * execution contexts shared with all members.
 */
const compiledCacheFormat = 2

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
		format?: unknown
		isOwner?: unknown
		orgPermissions?: unknown
		resourcePermissions?: unknown
		unmappableChangesAllowed?: unknown
	}
	if (record.format !== compiledCacheFormat) return null
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
	const unmappableChangesAllowed = new Set<string>()
	if (Array.isArray(record.unmappableChangesAllowed)) {
		for (const key of record.unmappableChangesAllowed) {
			if (typeof key === 'string') unmappableChangesAllowed.add(key)
		}
	}
	return {
		isOwner: record.isOwner,
		orgPermissions: orgPerms,
		resourcePermissions,
		unmappableChangesAllowed,
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
		format: compiledCacheFormat,
		isOwner: compiled.isOwner,
		orgPermissions: [...compiled.orgPermissions].sort(),
		resourcePermissions,
		unmappableChangesAllowed: [
			...(compiled.unmappableChangesAllowed ?? []),
		].sort(),
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

/** Ad-hoc rule: package:execute somewhere (or org-wide) ⇒ org:execute for ad-hoc code. */
function applyAdHocRule(
	orgPermissionsOut: Set<OrgPermission>,
	resourcePermissions: ReadonlyMap<string, ReadonlySet<OrgPermission>>,
) {
	if (orgPermissionsOut.has('org:execute')) return
	if (orgPermissionsOut.has('package:execute')) {
		orgPermissionsOut.add('org:execute')
		return
	}
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

/** Live grant rows reaching `userId` in each of `orgIds`, keyed by org id. */
async function loadLiveGrantRows(
	db: D1Database,
	orgIds: ReadonlyArray<string>,
	userId: string,
	now: string,
): Promise<Map<string, Array<GrantRow>>> {
	const rowsByOrg = new Map<string, Array<GrantRow>>()
	const subjectMatch = grantSubjectMatchSql({
		subjects: liveGrantRowSubjects,
		personId: userId,
		now,
	})
	const chunkSize = maxD1BoundParameters - subjectMatch.binds.length
	for (const chunk of chunkArray(orgIds, chunkSize)) {
		const result = await db
			.prepare(
				`SELECT g.org_id AS org_id,
				        g.resource_type AS resource_type,
				        g.resource_id AS resource_id,
				        gp.permission AS permission,
				        g.expires_at AS expires_at,
				        g.allow_unmappable_credential_changes AS allow_unmappable_credential_changes
				 FROM grants g
				 INNER JOIN grant_permissions gp ON gp.grant_id = g.id
				 WHERE g.org_id IN (${chunk.map(() => '?').join(', ')})
				   AND g.deleted_at IS NULL
				   AND ${subjectMatch.sql}`,
			)
			.bind(...chunk, ...subjectMatch.binds)
			.all<GrantRow & { org_id: string }>()
		for (const { org_id, ...row } of result.results ?? []) {
			pushRow(rowsByOrg, org_id, row)
		}
	}
	return rowsByOrg
}

function pushRow<Row>(map: Map<string, Array<Row>>, key: string, row: Row) {
	const rows = map.get(key)
	if (rows) rows.push(row)
	else map.set(key, [row])
}

const allMembersContextPermissions = permissionsForGrantPreset(
	'execution_context',
	'use',
)

/**
 * Use on every execution context shared with all members of the org (the
 * `all_members` flag on the owning org's context or on its attachment). The
 * flag stands in for an `org`-subject grant, which access-writes refuses on
 * execution_context, so a Member holds `execution_context:read` and
 * `:execute` on those contexts like any other Use share. Only live members:
 * callers skip it for outside collaborators.
 */
async function loadAllMembersContextGrantRows(
	db: D1Database,
	orgIds: ReadonlyArray<string>,
): Promise<Map<string, Array<GrantRow>>> {
	const rowsByOrg = new Map<string, Array<GrantRow>>()
	try {
		for (const chunk of chunkArray(
			orgIds,
			Math.floor(maxD1BoundParameters / 2),
		)) {
			const placeholders = chunk.map(() => '?').join(', ')
			const result = await db
				.prepare(
					`SELECT org_id, id AS context_id FROM execution_contexts
					 WHERE org_id IN (${placeholders}) AND all_members = 1
					 UNION
					 SELECT org_id, context_id FROM execution_context_org_attachments
					 WHERE org_id IN (${placeholders}) AND all_members = 1`,
				)
				.bind(...chunk, ...chunk)
				.all<{ org_id: string; context_id: string }>()
			for (const row of result.results ?? []) {
				for (const permission of allMembersContextPermissions) {
					pushRow(rowsByOrg, row.org_id, {
						resource_type: 'execution_context',
						resource_id: row.context_id,
						permission,
						expires_at: null,
					})
				}
			}
		}
	} catch (error) {
		// Incomplete test DBs may lack the execution context tables (0189);
		// production always has them.
		if (
			error instanceof Error &&
			/no such table:\s*execution_context/i.test(error.message)
		) {
			return new Map()
		}
		throw error
	}
	return rowsByOrg
}

function dbCanPrepare(db: D1Database) {
	return typeof db?.prepare === 'function'
}

type OrgAccessRow = {
	epoch: number
	memberCreation: OrgMemberCreation
}

/** Epoch and member-creation settings for each live org in `orgIds`. */
async function readOrgEpochs(
	db: D1Database,
	orgIds: ReadonlyArray<string>,
): Promise<Map<string, OrgAccessRow>> {
	if (!dbCanPrepare(db)) {
		throw new Error(
			`APP_DB cannot prepare statements while compiling access for org ${orgIds.join(', ')}.`,
		)
	}
	const rows = new Map<string, OrgAccessRow>()
	try {
		for (const chunk of chunkArray(orgIds, maxD1BoundParameters)) {
			const result = await db
				.prepare(
					`SELECT id, access_epoch, members_can_create_packages,
					        members_can_create_credentials
					 FROM orgs
					 WHERE id IN (${chunk.map(() => '?').join(', ')})${andLiveDeletedAtSql()}`,
				)
				.bind(...chunk)
				.all<{
					id: string
					access_epoch: number
					members_can_create_packages: number | null
					members_can_create_credentials: number | null
				}>()
			for (const row of result.results ?? []) {
				rows.set(row.id, {
					epoch: Number(row.access_epoch) || 0,
					memberCreation: memberCreationFromRow(row),
				})
			}
		}
	} catch (error) {
		// Incomplete test DBs may lack the orgs table; production always has it
		// after P3. Surface the error for non-owner callers instead.
		if (
			error instanceof Error &&
			/no such table:\s*orgs/i.test(error.message)
		) {
			return rows
		}
		throw error
	}
	return rows
}

/** Fresh access_cache rows for `userId` at each org's current epoch. */
async function readAccessCaches(
	db: D1Database,
	userId: string,
	epochs: ReadonlyMap<string, number>,
	now: string,
): Promise<Map<string, CompiledAccess>> {
	const cached = new Map<string, CompiledAccess>()
	for (const chunk of chunkArray(
		[...epochs.keys()],
		maxD1BoundParameters - 1,
	)) {
		const result = await db
			.prepare(
				`SELECT org_id, epoch, compiled_json, valid_until
				 FROM access_cache
				 WHERE user_id = ? AND org_id IN (${chunk.map(() => '?').join(', ')})`,
			)
			.bind(userId, ...chunk)
			.all<AccessCacheRow & { org_id: string }>()
		for (const row of result.results ?? []) {
			const epoch = epochs.get(row.org_id)
			if (epoch === undefined || Number(row.epoch) !== epoch) continue
			const validUntil = row.valid_until ?? null
			if (compiledAccessExpired({ validUntil }, now)) continue
			const parsed = parseCompiledJson(row.compiled_json)
			if (!parsed) continue
			cached.set(row.org_id, {
				orgId: row.org_id as OwnerId,
				epoch,
				...parsed,
				validUntil,
			})
		}
	}
	return cached
}

async function writeAccessCaches(
	db: D1Database,
	compiled: ReadonlyArray<CompiledAccess>,
	userId: string,
) {
	const computedAt = new Date().toISOString()
	const columnsPerRow = 6
	for (const chunk of chunkArray(
		compiled,
		Math.floor(maxD1BoundParameters / columnsPerRow),
	)) {
		await db
			.prepare(
				`INSERT INTO access_cache (org_id, user_id, epoch, compiled_json, computed_at, valid_until)
				 VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}
				 ON CONFLICT(org_id, user_id) DO UPDATE SET
				   epoch = excluded.epoch,
				   compiled_json = excluded.compiled_json,
				   computed_at = excluded.computed_at,
				   valid_until = excluded.valid_until`,
			)
			.bind(
				...chunk.flatMap((entry) => [
					entry.orgId,
					userId,
					entry.epoch,
					serializeCompiled(entry),
					computedAt,
					entry.validUntil,
				]),
			)
			.run()
	}
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
	const unmappableChangesAllowed = new Set<string>()
	for (const row of input.grantRows) {
		if (row.allow_unmappable_credential_changes !== 1) continue
		if (row.resource_type === 'org') continue
		unmappableChangesAllowed.add(
			resourceGrantKey(
				row.resource_type as OrgGrantResourceType,
				row.resource_id,
			),
		)
	}
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
		unmappableChangesAllowed,
		validUntil,
	}
}

function adminCompiledAccess(orgId: OwnerId, epoch: number): CompiledAccess {
	return {
		orgId,
		epoch,
		isOwner: false,
		isAdmin: true,
		orgPermissions: adminOrgPermissions,
		resourcePermissions: new Map(),
		validUntil: null,
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
 * Owners and Admins hold their role's permissions without reading grants or
 * access_epoch (the role alone decides). Member, Billing, and outside
 * collaborator paths load grants and require a real APP_DB. A request with no person holds nothing:
 * every run acts as a real person (a trigger as its enabler).
 */
export async function compileAccessForRequest(input: {
	db: D1Database
	request: RequestContext
}): Promise<CompiledAccess> {
	const [compiled] = await compileAccessForRequests({
		db: input.db,
		requests: [input.request],
	})
	if (!compiled) throw new Error(`No compile for org ${input.request.org.id}.`)
	return compiled
}

/**
 * {@link compileAccessForRequest} for many requests, in input order, with
 * one set of reads per actor (see {@link compileAccessForActorInOrgs}). A page
 * that checks one person in each of their orgs calls this first, so the
 * per-org `computeEffectivePermissions` calls after it reuse the memo.
 */
export async function compileAccessForRequests(input: {
	db: D1Database
	requests: ReadonlyArray<RequestContext>
}): Promise<Array<CompiledAccess>> {
	const results: Array<CompiledAccess | undefined> = input.requests.map(
		(request) => (request.actor ? undefined : noCompiledAccess(request.org.id)),
	)
	const byActor = new Map<
		string,
		Array<{ index: number; orgId: OwnerId; role: OrgRole | null }>
	>()
	input.requests.forEach((request, index) => {
		if (!request.actor) return
		const entry = {
			index,
			orgId: request.org.id,
			role: request.membership?.role ?? null,
		}
		const entries = byActor.get(request.actor.userId)
		if (entries) entries.push(entry)
		else byActor.set(request.actor.userId, [entry])
	})
	await Promise.all(
		[...byActor].map(async ([userId, entries]) => {
			const compiled = await compileAccessForActorInOrgs({
				db: input.db,
				userId,
				orgs: entries,
			})
			entries.forEach((entry, position) => {
				results[entry.index] = compiled[position]
			})
		}),
	)
	return results.map((compiled, index) => {
		if (!compiled) {
			throw new Error(
				`No compile for org ${input.requests[index]?.org.id ?? 'unknown'}.`,
			)
		}
		return compiled
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
	const [compiled] = await compileAccessForActorInOrgs({
		db: input.db,
		userId: input.userId,
		orgs: [{ orgId: input.orgId, role: input.role }],
	})
	if (!compiled) throw new Error(`No compile for org ${input.orgId}.`)
	return compiled
}

/**
 * {@link compileAccessForActor} for one person in many orgs, in input order.
 * The orgs that need a compile share one set of reads instead of paying
 * them per org, and every result joins the per-request memo, so a later
 * `computeEffectivePermissions` in one of these orgs reads nothing.
 */
export async function compileAccessForActorInOrgs(input: {
	db: D1Database
	userId: string
	orgs: ReadonlyArray<{ orgId: OwnerId; role: OrgRole | null }>
}): Promise<Array<CompiledAccess>> {
	const { db, userId } = input
	let queued: Array<{ orgId: OwnerId; role: OrgRole | null }> = []
	let batch: Promise<Map<string, CompiledAccess | Error>> | null = null
	const load = async (org: { orgId: OwnerId; role: OrgRole | null }) => {
		queued.push(org)
		// Every memo miss in this call queues before the microtask runs, so
		// they compile together. A reload after a stale value starts a new one.
		batch ??= Promise.resolve().then(() => {
			const orgs = queued
			queued = []
			batch = null
			return compileUncached(db, userId, orgs)
		})
		const result = (await batch).get(org.orgId)
		if (!result) throw new Error(`No compile for org ${org.orgId}.`)
		if (result instanceof Error) throw result
		return result
	}
	// One HTTP request can derive many request contexts for the same person
	// (a page checking several package permissions), so share the compile
	// across the request. Every new request still reads access_epoch, and a
	// long run recompiles once a grant it used expires.
	return await Promise.all(
		input.orgs.map(async (org) => {
			if (org.role === 'owner') return ownerCompiledAccess(org.orgId, 0)
			if (org.role === 'admin') return adminCompiledAccess(org.orgId, 0)
			return await memoizePerRequest({
				key: `compiled-access:${org.orgId}:${userId}:${org.role ?? 'none'}`,
				load: () => load(org),
				isFresh: (compiled) => !compiledAccessExpired(compiled),
			})
		}),
	)
}

/** Compile each org for `userId`, or the error that org's compile hit. */
async function compileUncached(
	db: D1Database,
	userId: string,
	orgs: ReadonlyArray<{ orgId: OwnerId; role: OrgRole | null }>,
): Promise<Map<string, CompiledAccess | Error>> {
	const roles = new Map(orgs.map((org) => [org.orgId, org.role]))
	const orgIds = [...roles.keys()]
	const results = new Map<string, CompiledAccess | Error>()
	const orgRows = await readOrgEpochs(db, orgIds)
	for (const orgId of orgIds) {
		if (!orgRows.has(orgId)) {
			results.set(
				orgId,
				new Error(`Org ${orgId} was not found while compiling access.`),
			)
		}
	}
	const epochs = new Map([...orgRows].map(([orgId, row]) => [orgId, row.epoch]))
	if (epochs.size === 0) return results
	const now = new Date().toISOString()
	const cached = await readAccessCaches(db, userId, epochs, now)
	for (const [orgId, compiled] of cached) results.set(orgId, compiled)
	const misses = [...epochs.keys()].filter((orgId) => !cached.has(orgId))
	if (misses.length === 0) return results

	const [liveGrantRows, allMembersRows] = await Promise.all([
		loadLiveGrantRows(db, misses, userId, now),
		loadAllMembersContextGrantRows(
			db,
			misses.filter((orgId) => roles.get(orgId as OwnerId)),
		),
	])
	const compiled = misses.map((orgId) =>
		compileFromRoleAndGrants({
			orgId: orgId as OwnerId,
			epoch: epochs.get(orgId) ?? 0,
			role: roles.get(orgId as OwnerId) ?? null,
			grantRows: [
				...(liveGrantRows.get(orgId) ?? []),
				...(allMembersRows.get(orgId) ?? []),
			],
			memberCreation: orgRows.get(orgId)?.memberCreation,
		}),
	)
	for (const entry of compiled) results.set(entry.orgId, entry)
	try {
		await writeAccessCaches(db, compiled, userId)
	} catch {
		// Cache is derived; a write failure must not block the request.
	}
	return results
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
