import {
	chunkArray,
	maxD1BoundParameters,
} from '@kody-internal/shared/chunk.ts'
import {
	ecpDefaultGrant,
	ecpMaxChainContexts,
	type EcpCapabilities,
	type EcpGrant,
	type Ed25519PublicJwk,
} from '@kody-internal/shared/execution-context-protocol/index.ts'
import {
	type GrantSubjectChoices,
	grantSubjectMatchSql,
} from '#worker/authorization/grant-subjects.ts'

/** D1 access for execution contexts (tables from migrations 0189 and 0190). */

export const executionContextIdPrefix = 'ec_'
export const executionContextCommandPermission = 'execution_context:command'
export const registrationChallengeTtlMs = 5 * 60_000
export const unutilizedNamedMax = 3
export const revokedVisibleMs = 30 * 24 * 60 * 60_000

export type ExecutionContextRow = {
	id: string
	org_id: string
	operator_user_id: string
	all_members: number
	name: string
	public_key_jwk: string
	thumbprint: string
	created_at: string
	revoked_at: string | null
	revoked_reason: string | null
	last_seen_at: string | null
	client_name: string | null
	client_version: string | null
	capabilities_json: string | null
	grant_json: string | null
	grant_version: number
	/** The box login (ADR 0096); null until recorded. */
	login_kind?: 'person' | 'profile' | null
	login_user_id?: string | null
	login_profile_id?: string | null
	login_token_id?: string | null
	login_checked_at?: string | null
	/** The team the operator says the box is for. */
	team_id?: string | null
	/** Server-side pause (migration 0254): routing skips the context. */
	paused_at?: string | null
	paused_by_user_id?: string | null
	pause_reason?: string | null
}

export type UnusableReason =
	| 'not_attached'
	| 'not_granted'
	| 'revoked'
	| 'not_opted_in'
	| 'credential_scope'
	| 'operator_left'

export type ContextAccess = {
	isOperator: boolean
	attached: boolean
	granted: boolean
	optedIn: boolean
	preset: 'use' | 'contribute' | 'manage' | null
	/**
	 * May run host commands (`execution_context:command`, ADR 0093): the
	 * operator only. Commands run as the machine's OS user with the machine's
	 * login and context key, so a grantee with them could act as the machine;
	 * command shares written before this rule confer nothing.
	 */
	canRunCommands: boolean
	usable: boolean
	unusableReason: UnusableReason | null
}

export function newExecutionContextId() {
	const bytes = crypto.getRandomValues(new Uint8Array(12))
	return `${executionContextIdPrefix}${Array.from(bytes, (b) =>
		b.toString(36).padStart(2, '0'),
	)
		.join('')
		.slice(0, 20)}`
}

export function parseGrant(row: Pick<ExecutionContextRow, 'grant_json'>) {
	if (!row.grant_json) return ecpDefaultGrant
	try {
		return { ...ecpDefaultGrant, ...(JSON.parse(row.grant_json) as EcpGrant) }
	} catch {
		return ecpDefaultGrant
	}
}

export function parseCapabilities(
	row: Pick<ExecutionContextRow, 'capabilities_json'>,
): EcpCapabilities {
	if (!row.capabilities_json) return {}
	try {
		return JSON.parse(row.capabilities_json) as EcpCapabilities
	} catch {
		return {}
	}
}

export function parsePublicKey(
	row: Pick<ExecutionContextRow, 'public_key_jwk'>,
) {
	return JSON.parse(row.public_key_jwk) as Ed25519PublicJwk
}

const contextColumns = `id, org_id, operator_user_id, all_members, name, public_key_jwk,
	thumbprint, created_at, revoked_at, revoked_reason, last_seen_at, client_name,
	client_version, capabilities_json, grant_json, grant_version, login_kind,
	login_user_id, login_profile_id, login_token_id, login_checked_at, team_id,
	paused_at, paused_by_user_id, pause_reason`

export async function getExecutionContext(db: D1Database, id: string) {
	return await db
		.prepare(`SELECT ${contextColumns} FROM execution_contexts WHERE id = ?`)
		.bind(id)
		.first<ExecutionContextRow>()
}

/** Rows for the given ids; missing ids are omitted. */
export async function getExecutionContexts(
	db: D1Database,
	ids: ReadonlyArray<string>,
) {
	const byId = new Map<string, ExecutionContextRow>()
	if (ids.length === 0) return byId
	const result = await db
		.prepare(
			`SELECT ${contextColumns} FROM execution_contexts WHERE id IN (${ids.map(() => '?').join(', ')})`,
		)
		.bind(...ids)
		.all<ExecutionContextRow>()
	for (const row of result.results) byId.set(row.id, row)
	return byId
}

export async function getExecutionContextByThumbprint(
	db: D1Database,
	thumbprint: string,
) {
	return await db
		.prepare(
			`SELECT ${contextColumns} FROM execution_contexts WHERE thumbprint = ?`,
		)
		.bind(thumbprint)
		.first<ExecutionContextRow>()
}

/**
 * Contexts visible in `orgId`: owned by it or attached to it. Revoked rows
 * stay visible for 30 days.
 */
export async function listOrgExecutionContexts(
	db: D1Database,
	orgId: string,
	now = Date.now(),
) {
	const cutoff = new Date(now - revokedVisibleMs).toISOString()
	const result = await db
		.prepare(
			`SELECT ${contextColumns} FROM execution_contexts c
			 WHERE (c.org_id = ?1 OR EXISTS (
				SELECT 1 FROM execution_context_org_attachments a
				WHERE a.context_id = c.id AND a.org_id = ?1))
			   AND (c.revoked_at IS NULL OR c.revoked_at > ?2)
			 ORDER BY c.name`,
		)
		.bind(orgId, cutoff)
		.all<ExecutionContextRow>()
	return result.results
}

/** Resolves an `ec_` id or a name visible in the org. */
export async function resolveExecutionContextRef(
	db: D1Database,
	orgId: string,
	ref: string,
) {
	const trimmed = ref.trim()
	if (trimmed.startsWith(executionContextIdPrefix)) {
		const row = await getExecutionContext(db, trimmed)
		if (!row) return null
		if (row.org_id === orgId) return row
		const attached = await db
			.prepare(
				`SELECT 1 AS ok FROM execution_context_org_attachments WHERE context_id = ? AND org_id = ?`,
			)
			.bind(row.id, orgId)
			.first()
		return attached ? row : null
	}
	return (
		(await listOrgExecutionContexts(db, orgId)).find(
			(row) => row.name === trimmed && !row.revoked_at,
		) ?? null
	)
}

/**
 * Context grants reach a person directly or through a team. Everyone in the
 * org is the attachment's `all_members` flag instead: access-writes refuses an
 * `org` subject on resource_type execution_context.
 */
export const contextGrantSubjects = {
	user: 'include',
	team: 'include',
	org: {
		exclude:
			'access-writes refuses org subjects on execution_context; all_members covers everyone in the org.',
	},
	profile: {
		exclude:
			'Profile grants narrow a profile; they never grant the person behind it.',
	},
} as const satisfies GrantSubjectChoices

/**
 * Assemble {@link ContextAccess} from preloaded rows. Shared by the single-
 * and batched loaders so list paths cannot drift from one-context checks.
 */
export function assembleContextAccess(
	context: ExecutionContextRow,
	input: { userId: string; orgId: string },
	parts: {
		attachRow: { all_members: number } | undefined
		presets: Array<ContextAccess['preset']>
		isMember: boolean
		optedIn: boolean
		operatorLive: boolean
	},
): ContextAccess {
	const isOperator = context.operator_user_id === input.userId
	const attached = context.org_id === input.orgId || Boolean(parts.attachRow)
	const preset = strongestPreset(parts.presets)
	const allMembers =
		context.org_id === input.orgId
			? context.all_members === 1
			: parts.attachRow?.all_members === 1
	const granted =
		isOperator || preset !== null || (parts.isMember && allMembers === true)
	const optedIn = isOperator || parts.optedIn
	const operatorLive = isOperator || parts.operatorLive
	const unusableReason: UnusableReason | null = context.revoked_at
		? 'revoked'
		: !attached
			? 'not_attached'
			: !granted
				? 'not_granted'
				: !operatorLive
					? 'operator_left'
					: !optedIn
						? 'not_opted_in'
						: null
	return {
		isOperator,
		attached,
		granted,
		optedIn,
		preset: isOperator ? 'manage' : (preset ?? (granted ? 'use' : null)),
		canRunCommands: isOperator,
		usable: unusableReason === null,
		unusableReason,
	}
}

/**
 * Execute authority (protocol 8.5): the operator, a live grant on this
 * context in the run's org (directly or through a team), or a live member
 * when `all_members` is set. Compiled access and org roles never confer it.
 * Fails closed with `operator_left` for everyone else once the operator is no
 * longer a live member of the run's org: their machine must not keep taking
 * other members' runs.
 *
 * Prefer {@link loadContextsAccess} when formatting many contexts in one
 * request (list / chain): it uses set-based queries instead of one D1 batch
 * per row (Sentry KODY-E6).
 */
export async function loadContextAccess(
	db: D1Database,
	context: ExecutionContextRow,
	input: { userId: string; orgId: string },
): Promise<ContextAccess> {
	const subjectMatch = grantSubjectMatchSql({
		subjects: contextGrantSubjects,
		personId: input.userId,
		boundOrgId: input.orgId,
	})
	const [attachment, grant, membership, optIn, operatorMembership] =
		await db.batch<Record<string, unknown>>([
			db
				.prepare(
					`SELECT all_members FROM execution_context_org_attachments WHERE context_id = ? AND org_id = ?`,
				)
				.bind(context.id, input.orgId),
			db
				.prepare(
					`SELECT g.preset AS preset
				 FROM grants g
				 WHERE g.resource_type = 'execution_context' AND g.resource_id = ?
				   AND g.org_id = ? AND g.deleted_at IS NULL
				   AND (g.expires_at IS NULL OR g.expires_at > ?)
				   AND ${subjectMatch.sql}`,
				)
				.bind(
					context.id,
					input.orgId,
					new Date().toISOString(),
					...subjectMatch.binds,
				),
			db
				.prepare(
					`SELECT role FROM org_memberships WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
				)
				.bind(input.orgId, input.userId),
			db
				.prepare(
					`SELECT 1 AS ok FROM execution_context_opt_ins WHERE context_id = ? AND user_id = ? AND org_id = ?`,
				)
				.bind(context.id, input.userId, input.orgId),
			db
				.prepare(
					`SELECT 1 AS ok FROM org_memberships WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
				)
				.bind(input.orgId, context.operator_user_id),
		])
	return assembleContextAccess(context, input, {
		attachRow: attachment?.results[0] as { all_members: number } | undefined,
		presets: (grant?.results ?? []).map(
			(row) => (row as { preset: ContextAccess['preset'] }).preset,
		),
		isMember: (membership?.results.length ?? 0) > 0,
		optedIn: (optIn?.results.length ?? 0) > 0,
		operatorLive: (operatorMembership?.results.length ?? 0) > 0,
	})
}

/**
 * Same semantics as {@link loadContextAccess}, for every context via
 * set-based queries (attachments / grants / opt-ins / memberships).
 * Context-id lists are chunked so each statement stays within D1's
 * {@link maxD1BoundParameters} cap (the grant query is the tightest).
 */
export async function loadContextsAccess(
	db: D1Database,
	contexts: ReadonlyArray<ExecutionContextRow>,
	input: { userId: string; orgId: string },
): Promise<Map<string, ContextAccess>> {
	const access = new Map<string, ContextAccess>()
	if (contexts.length === 0) return access

	const contextIds = contexts.map((context) => context.id)
	const operatorIds = [
		...new Set(contexts.map((context) => context.operator_user_id)),
	]
	const subjectMatch = grantSubjectMatchSql({
		subjects: contextGrantSubjects,
		personId: input.userId,
		boundOrgId: input.orgId,
	})
	const now = new Date().toISOString()
	// Grant binds: resource ids + org + expiry + subjectMatch binds.
	const grantFixedBinds = 2 + subjectMatch.binds.length
	const contextIdChunkSize = Math.max(
		1,
		Math.min(
			maxD1BoundParameters - 1, // attachments: org + ids
			maxD1BoundParameters - 2, // opt-ins: user + org + ids
			maxD1BoundParameters - grantFixedBinds,
		),
	)
	const operatorChunkSize = Math.max(1, maxD1BoundParameters - 1)

	const statements: Array<D1PreparedStatement> = [
		db
			.prepare(
				`SELECT role FROM org_memberships WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
			)
			.bind(input.orgId, input.userId),
	]
	const attachmentChunkIndexes: Array<number> = []
	const grantChunkIndexes: Array<number> = []
	const optInChunkIndexes: Array<number> = []
	const operatorChunkIndexes: Array<number> = []

	for (const ids of chunkArray(contextIds, contextIdChunkSize)) {
		const placeholders = ids.map(() => '?').join(', ')
		attachmentChunkIndexes.push(statements.length)
		statements.push(
			db
				.prepare(
					`SELECT context_id, all_members FROM execution_context_org_attachments
					 WHERE org_id = ? AND context_id IN (${placeholders})`,
				)
				.bind(input.orgId, ...ids),
		)
		grantChunkIndexes.push(statements.length)
		statements.push(
			db
				.prepare(
					`SELECT g.resource_id AS resource_id, g.preset AS preset
					 FROM grants g
					 WHERE g.resource_type = 'execution_context'
					   AND g.resource_id IN (${placeholders})
					   AND g.org_id = ? AND g.deleted_at IS NULL
					   AND (g.expires_at IS NULL OR g.expires_at > ?)
					   AND ${subjectMatch.sql}`,
				)
				.bind(...ids, input.orgId, now, ...subjectMatch.binds),
		)
		optInChunkIndexes.push(statements.length)
		statements.push(
			db
				.prepare(
					`SELECT context_id FROM execution_context_opt_ins
					 WHERE user_id = ? AND org_id = ? AND context_id IN (${placeholders})`,
				)
				.bind(input.userId, input.orgId, ...ids),
		)
	}
	for (const ids of chunkArray(operatorIds, operatorChunkSize)) {
		operatorChunkIndexes.push(statements.length)
		statements.push(
			db
				.prepare(
					`SELECT user_id FROM org_memberships
					 WHERE org_id = ? AND user_id IN (${ids.map(() => '?').join(', ')}) AND deleted_at IS NULL`,
				)
				.bind(input.orgId, ...ids),
		)
	}

	const results = await db.batch<Record<string, unknown>>(statements)
	const membership = results[0]
	const attachByContext = new Map<string, { all_members: number }>()
	for (const index of attachmentChunkIndexes) {
		for (const row of results[index]?.results ?? []) {
			const typed = row as { context_id: string; all_members: number }
			attachByContext.set(typed.context_id, {
				all_members: typed.all_members,
			})
		}
	}
	const presetsByContext = new Map<string, Array<ContextAccess['preset']>>()
	for (const index of grantChunkIndexes) {
		for (const row of results[index]?.results ?? []) {
			const typed = row as {
				resource_id: string
				preset: ContextAccess['preset']
			}
			const list = presetsByContext.get(typed.resource_id) ?? []
			list.push(typed.preset)
			presetsByContext.set(typed.resource_id, list)
		}
	}
	const optedInIds = new Set<string>()
	for (const index of optInChunkIndexes) {
		for (const row of results[index]?.results ?? []) {
			optedInIds.add((row as { context_id: string }).context_id)
		}
	}
	const liveOperators = new Set<string>()
	for (const index of operatorChunkIndexes) {
		for (const row of results[index]?.results ?? []) {
			liveOperators.add((row as { user_id: string }).user_id)
		}
	}
	const isMember = (membership?.results.length ?? 0) > 0

	for (const context of contexts) {
		access.set(
			context.id,
			assembleContextAccess(context, input, {
				attachRow: attachByContext.get(context.id),
				presets: presetsByContext.get(context.id) ?? [],
				isMember,
				optedIn: optedInIds.has(context.id),
				operatorLive: liveOperators.has(context.operator_user_id),
			}),
		)
	}
	return access
}

function strongestPreset(presets: Array<ContextAccess['preset']>) {
	for (const level of ['manage', 'contribute', 'use'] as const) {
		if (presets.includes(level)) return level
	}
	return presets.length > 0 ? 'use' : null
}

export function canManageContext(access: ContextAccess) {
	return access.isOperator || access.preset === 'manage'
}

export function canWriteContext(access: ContextAccess) {
	return canManageContext(access) || access.preset === 'contribute'
}

export async function createRegistrationChallenge(
	db: D1Database,
	input: { challengeHash: string; userId: string; orgId: string; now: number },
) {
	await db.batch([
		db
			.prepare(
				`DELETE FROM execution_context_registration_challenges WHERE expires_at <= ?`,
			)
			.bind(new Date(input.now).toISOString()),
		db
			.prepare(
				`INSERT INTO execution_context_registration_challenges (challenge_hash, user_id, org_id, expires_at)
				 VALUES (?, ?, ?, ?)`,
			)
			.bind(
				input.challengeHash,
				input.userId,
				input.orgId,
				new Date(input.now + registrationChallengeTtlMs).toISOString(),
			),
	])
}

export async function consumeRegistrationChallenge(
	db: D1Database,
	input: { challengeHash: string; now: number },
) {
	return await db
		.prepare(
			`DELETE FROM execution_context_registration_challenges
			 WHERE challenge_hash = ? AND expires_at > ?
			 RETURNING user_id, org_id`,
		)
		.bind(input.challengeHash, new Date(input.now).toISOString())
		.first<{ user_id: string; org_id: string }>()
}

export async function insertExecutionContext(
	db: D1Database,
	row: Omit<
		ExecutionContextRow,
		'revoked_at' | 'revoked_reason' | 'last_seen_at' | 'all_members'
	>,
) {
	await db
		.prepare(
			`INSERT INTO execution_contexts (id, org_id, operator_user_id, all_members, name,
				public_key_jwk, thumbprint, created_at, client_name, client_version,
				capabilities_json, grant_json, grant_version, login_kind, login_user_id,
				login_profile_id, login_token_id, login_checked_at)
			 VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.org_id,
			row.operator_user_id,
			row.name,
			row.public_key_jwk,
			row.thumbprint,
			row.created_at,
			row.client_name,
			row.client_version,
			row.capabilities_json,
			row.grant_json,
			row.grant_version,
			row.login_kind ?? null,
			row.login_user_id ?? null,
			row.login_profile_id ?? null,
			row.login_token_id ?? null,
			row.login_checked_at ?? null,
		)
		.run()
}

export type ChainEntry = { kind: 'context'; id: string } | { kind: 'cloud' }

export type StoredChain = {
	entries: Array<ChainEntry>
	strict: boolean
	version: number
	updatedAt: string | null
	updatedBy: { kind: 'user' | 'agent'; label: string | null } | null
}

export async function getChain(
	db: D1Database,
	input: { orgId: string; userId: string },
): Promise<StoredChain> {
	const [head, entries] = await db.batch<Record<string, unknown>>([
		db
			.prepare(
				`SELECT strict, version, updated_at, updated_by_kind, updated_by_label
				 FROM execution_context_chains WHERE org_id = ? AND user_id = ?`,
			)
			.bind(input.orgId, input.userId),
		db
			.prepare(
				`SELECT context_id FROM execution_context_chain_entries
				 WHERE org_id = ? AND user_id = ? ORDER BY position`,
			)
			.bind(input.orgId, input.userId),
	])
	const row = head?.results[0] as
		| {
				strict: number
				version: number
				updated_at: string
				updated_by_kind: 'user' | 'agent'
				updated_by_label: string | null
		  }
		| undefined
	if (!row) {
		return {
			entries: [{ kind: 'cloud' }],
			strict: false,
			version: 0,
			updatedAt: null,
			updatedBy: null,
		}
	}
	return {
		entries: (entries?.results ?? []).map((entry) => {
			const contextId = (entry as { context_id: string | null }).context_id
			return contextId ? { kind: 'context', id: contextId } : { kind: 'cloud' }
		}),
		strict: row.strict === 1,
		version: row.version,
		updatedAt: row.updated_at,
		updatedBy: { kind: row.updated_by_kind, label: row.updated_by_label },
	}
}

export class ChainConflictError extends Error {
	constructor() {
		super('chain_changed')
	}
}

export function contextEntryCount(entries: ReadonlyArray<ChainEntry>) {
	return entries.filter((entry) => entry.kind === 'context').length
}

export function chainIsTooLong(entries: ReadonlyArray<ChainEntry>) {
	return contextEntryCount(entries) > ecpMaxChainContexts
}

/**
 * Rewrites the chain when `expectedVersion` still matches, in one batch.
 * Throws {@link ChainConflictError} on a concurrent change.
 */
export async function writeChain(
	db: D1Database,
	input: {
		orgId: string
		userId: string
		entries: ReadonlyArray<ChainEntry>
		expectedVersion: number
		updatedBy: { kind: 'user' | 'agent'; label: string | null }
		now: string
	},
) {
	const strict = input.entries.some((entry) => entry.kind === 'cloud') ? 0 : 1
	const nextVersion = input.expectedVersion + 1
	const statements = [
		input.expectedVersion === 0
			? db
					.prepare(
						`INSERT INTO execution_context_chains (org_id, user_id, strict, version, updated_at, updated_by_kind, updated_by_label)
						 VALUES (?, ?, ?, ?, ?, ?, ?)
						 ON CONFLICT (org_id, user_id) DO NOTHING`,
					)
					.bind(
						input.orgId,
						input.userId,
						strict,
						nextVersion,
						input.now,
						input.updatedBy.kind,
						input.updatedBy.label,
					)
			: db
					.prepare(
						`UPDATE execution_context_chains
						 SET strict = ?, version = ?, updated_at = ?, updated_by_kind = ?, updated_by_label = ?
						 WHERE org_id = ? AND user_id = ? AND version = ?`,
					)
					.bind(
						strict,
						nextVersion,
						input.now,
						input.updatedBy.kind,
						input.updatedBy.label,
						input.orgId,
						input.userId,
						input.expectedVersion,
					),
	]
	const [head] = await db.batch([statements[0]!])
	if ((head?.meta.changes ?? 0) === 0) throw new ChainConflictError()
	await db.batch([
		db
			.prepare(
				`DELETE FROM execution_context_chain_entries WHERE org_id = ? AND user_id = ?`,
			)
			.bind(input.orgId, input.userId),
		...input.entries.map((entry, position) =>
			db
				.prepare(
					`INSERT INTO execution_context_chain_entries (org_id, user_id, position, context_id) VALUES (?, ?, ?, ?)`,
				)
				.bind(
					input.orgId,
					input.userId,
					position,
					entry.kind === 'context' ? entry.id : null,
				),
		),
	])
	return nextVersion
}

/** How many chains (any person, any org) hold each context. */
export async function chainCounts(db: D1Database, ids: ReadonlyArray<string>) {
	const counts = new Map<string, number>()
	if (ids.length === 0) return counts
	const result = await db
		.prepare(
			`SELECT context_id, COUNT(*) AS n FROM execution_context_chain_entries
			 WHERE context_id IN (${ids.map(() => '?').join(', ')}) GROUP BY context_id`,
		)
		.bind(...ids)
		.all<{ context_id: string; n: number }>()
	for (const row of result.results) counts.set(row.context_id, row.n)
	return counts
}

export async function setOptIn(
	db: D1Database,
	input: { contextId: string; userId: string; orgId: string; now: string },
) {
	await db
		.prepare(
			`INSERT INTO execution_context_opt_ins (context_id, user_id, org_id, created_at)
			 VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
		)
		.bind(input.contextId, input.userId, input.orgId, input.now)
		.run()
}

export async function removeOptIn(
	db: D1Database,
	input: { contextId: string; userId: string; orgId: string },
) {
	await db
		.prepare(
			`DELETE FROM execution_context_opt_ins WHERE context_id = ? AND user_id = ? AND org_id = ?`,
		)
		.bind(input.contextId, input.userId, input.orgId)
		.run()
}

export function sessionStub(env: Env, ecid: string) {
	return env.EXECUTION_CONTEXT_SESSION.get(
		env.EXECUTION_CONTEXT_SESSION.idFromName(ecid),
	)
}
