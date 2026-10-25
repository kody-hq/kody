/**
 * Stored credential mappings (ADR 0068 amendment 2026-10-13): which
 * credentials one package need resolves to, per default layer (`org`, or one
 * person's `mine`) and per trigger instance (an enablement). Rows hold
 * credential ids only. A mapping grants nothing: resolution keeps only refs
 * the actor can Use right now.
 */
import { maxD1BoundParameters } from '@kody-internal/shared/chunk.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	bumpCredentialMappingGeneration,
	credentialMappingGenerationOf,
} from './credential-read-generation.ts'
import { type UsableCredential } from './credential-candidates.ts'

export { bumpCredentialMappingGeneration }

export type CredentialMappingRowTarget =
	| { target: 'org' }
	| { target: 'mine'; personId: string }
	| { target: 'enablement'; enablementId: string; personId: string }

export type CredentialMappingRow = {
	needKey: string
	target: CredentialMappingRowTarget
	/** Ordered; `[]` is "none on purpose". */
	credentialIds: Array<string>
	updatedByUserId: string | null
	updatedAt: string
}

type Row = {
	need_key: string
	target: string
	person_user_id: string
	enablement_id: string
	credential_ids_json: string
	updated_by_user_id: string | null
	updated_at: string
}

/**
 * Null when the stored JSON is not an array of ids: a corrupt row must not
 * read as `[]`, which means "none on purpose".
 */
function parseIds(json: string): Array<string> | null {
	try {
		const parsed: unknown = JSON.parse(json)
		if (
			Array.isArray(parsed) &&
			parsed.every((entry) => typeof entry === 'string')
		) {
			return parsed
		}
	} catch {
		// Reported by the caller with the row's identity.
	}
	return null
}

function toTarget(row: Row): CredentialMappingRowTarget | null {
	switch (row.target) {
		case 'org':
			return { target: 'org' }
		case 'mine':
			return { target: 'mine', personId: row.person_user_id }
		case 'enablement':
			return {
				target: 'enablement',
				enablementId: row.enablement_id,
				personId: row.person_user_id,
			}
		default:
			return null
	}
}

function targetColumns(target: CredentialMappingRowTarget) {
	switch (target.target) {
		case 'org':
			return { personUserId: '', enablementId: '' }
		case 'mine':
			return { personUserId: target.personId, enablementId: '' }
		case 'enablement':
			return {
				personUserId: target.personId,
				enablementId: target.enablementId,
			}
		default: {
			const exhaustive: never = target
			throw new Error(`Unhandled mapping target: ${JSON.stringify(exhaustive)}`)
		}
	}
}

type PendingCredentialMappingRequest = {
	orgId: string
	packageId: string
	personId: string | null
	enablementIds: ReadonlyArray<string>
	needKey: string | undefined
	resolve: (rows: Array<CredentialMappingRow>) => void
	reject: (error: unknown) => void
}

/**
 * Concurrent `loadCredentialMappings` calls against the same `APP_DB` in one
 * isolate turn share one read per (org, package, person, enablements) scope
 * (KODY-AZ). Package execute opens `credential(key)` for each need via
 * `Promise.all`, and each open previously issued its own
 * `need_key = ?` mapping SELECT; D1 still ran those as sequential spans. A
 * lone lookup still uses the single-key (or unfiltered) query.
 *
 * When a `request` is passed, the first load for a scope reads every mapping
 * row for that scope and keeps it for the request (KODY-BF). Sequential
 * `await credential(key)` on a queue consumer then filters in memory instead
 * of issuing another `need_key = ?` SELECT.
 */
const pendingCredentialMappingBatches = new WeakMap<
	D1Database,
	Array<PendingCredentialMappingRequest>
>()

const credentialMappingsByRequest = new WeakMap<
	RequestContext,
	Map<string, Promise<Array<CredentialMappingRow>>>
>()

function mappingScopeKey(input: {
	orgId: string
	packageId: string
	personId: string | null
	enablementIds: ReadonlyArray<string>
	generation: number
}) {
	return `${input.orgId}\0${input.packageId}\0${input.personId ?? ''}\0${[...input.enablementIds].join('\0')}\0${input.generation}`
}

function rowsForNeedKey(
	rows: ReadonlyArray<CredentialMappingRow>,
	needKey: string | undefined,
) {
	return needKey === undefined
		? [...rows]
		: rows.filter((row) => row.needKey === needKey)
}

/**
 * Fresh D1 read of the package's mappings a viewer can see: the org layer,
 * the viewer's own `mine` layer, and overrides on the given enablements.
 * Optional `needKey` / `needKeys` narrow the SQL; callers that batch several
 * keys prefer one unfiltered (or `IN`) read and filter in memory.
 */
async function queryCredentialMappings(input: {
	db: D1Database
	orgId: string
	packageId: string
	personId: string | null
	enablementIds: ReadonlyArray<string>
	needKey?: string
	needKeys?: ReadonlyArray<string>
}): Promise<Array<CredentialMappingRow>> {
	const clauses = [`target = 'org'`]
	const binds: Array<string> = [input.orgId, input.packageId]
	if (input.personId) {
		clauses.push(`(target = 'mine' AND person_user_id = ?)`)
		binds.push(input.personId)
	}
	if (input.enablementIds.length > 0) {
		clauses.push(
			`(target = 'enablement' AND enablement_id IN (${input.enablementIds.map(() => '?').join(', ')}))`,
		)
		binds.push(...input.enablementIds)
	}
	let needFilter = ''
	const needKeys = input.needKeys
		? [...new Set(input.needKeys)]
		: input.needKey !== undefined
			? [input.needKey]
			: null
	if (needKeys && needKeys.length === 1) {
		needFilter = ' AND need_key = ?'
		binds.push(needKeys[0]!)
	} else if (needKeys && needKeys.length > 1) {
		needFilter = ` AND need_key IN (${needKeys.map(() => '?').join(', ')})`
		binds.push(...needKeys)
	}
	const result = await input.db
		.prepare(
			`SELECT need_key, target, person_user_id, enablement_id,
				credential_ids_json, updated_by_user_id, updated_at
			FROM credential_mappings
			WHERE org_id = ? AND package_id = ? AND (${clauses.join(' OR ')})${needFilter}
			ORDER BY need_key, target, enablement_id`,
		)
		.bind(...binds)
		.all<Row>()
	return (result.results ?? []).flatMap((row): Array<CredentialMappingRow> => {
		const target = toTarget(row)
		if (!target) return []
		const credentialIds = parseIds(row.credential_ids_json)
		if (!credentialIds) {
			console.error(
				JSON.stringify({
					message: 'credential mapping row has corrupt credential ids',
					orgId: input.orgId,
					packageId: input.packageId,
					needKey: row.need_key,
					target: row.target,
				}),
			)
			return []
		}
		return [
			{
				needKey: row.need_key,
				target,
				credentialIds,
				updatedByUserId: row.updated_by_user_id,
				updatedAt: row.updated_at,
			},
		]
	})
}

async function flushCredentialMappingBatch(db: D1Database) {
	const pending = pendingCredentialMappingBatches.get(db)
	pendingCredentialMappingBatches.delete(db)
	if (!pending || pending.length === 0) return

	const byScope = new Map<string, Array<PendingCredentialMappingRequest>>()
	for (const request of pending) {
		const key = mappingScopeKey({
			...request,
			generation: credentialMappingGenerationOf(db),
		})
		const group = byScope.get(key)
		if (group) group.push(request)
		else byScope.set(key, [request])
	}

	await Promise.all(
		[...byScope.values()].map(async (requests) => {
			const [first] = requests
			if (!first) return
			try {
				const needKeys = requests.map((request) => request.needKey)
				const wantsAll = needKeys.some((key) => key === undefined)
				const uniqueNeedKeys = [
					...new Set(
						needKeys.filter((key): key is string => key !== undefined),
					),
				]
				// orgId + packageId + optional personId + enablementIds + need keys.
				const fixedBinds =
					2 + (first.personId ? 1 : 0) + first.enablementIds.length
				const needKeyBindsFit =
					uniqueNeedKeys.length > 0 &&
					fixedBinds + uniqueNeedKeys.length <= maxD1BoundParameters
				const rows = await queryCredentialMappings({
					db,
					orgId: first.orgId,
					packageId: first.packageId,
					personId: first.personId,
					enablementIds: first.enablementIds,
					...(wantsAll || !needKeyBindsFit
						? {}
						: uniqueNeedKeys.length === 1
							? { needKey: uniqueNeedKeys[0] }
							: { needKeys: uniqueNeedKeys }),
				})
				for (const request of requests) {
					request.resolve(rowsForNeedKey(rows, request.needKey))
				}
			} catch (error) {
				// Isolate failures per scope so one D1 error does not reject
				// unrelated lookups that share the same microtask flush.
				for (const request of requests) request.reject(error)
			}
		}),
	)
}

/**
 * The package's mappings a viewer can see: the org layer, the viewer's own
 * `mine` layer, and overrides on the given enablements.
 *
 * Pass `request` on credential open / package execute so sequential need-key
 * lookups share one unfiltered scope read for the execution.
 */
export async function loadCredentialMappings(input: {
	db: D1Database
	orgId: string
	packageId: string
	personId: string | null
	enablementIds?: ReadonlyArray<string>
	needKey?: string
	request?: RequestContext | null
}): Promise<Array<CredentialMappingRow>> {
	const enablementIds = input.enablementIds ?? []
	const scope = {
		orgId: input.orgId,
		packageId: input.packageId,
		personId: input.personId,
		enablementIds,
	}
	if (input.request) {
		const scopeKey = mappingScopeKey({
			...scope,
			generation: credentialMappingGenerationOf(input.db),
		})
		let byScope = credentialMappingsByRequest.get(input.request)
		if (!byScope) {
			byScope = new Map()
			credentialMappingsByRequest.set(input.request, byScope)
		}
		let allRows = byScope.get(scopeKey)
		if (!allRows) {
			allRows = queryCredentialMappings({
				db: input.db,
				...scope,
			})
			byScope.set(scopeKey, allRows)
			allRows.catch(() => {
				if (byScope.get(scopeKey) === allRows) byScope.delete(scopeKey)
			})
		}
		return rowsForNeedKey(await allRows, input.needKey)
	}
	const db = input.db
	return await new Promise<Array<CredentialMappingRow>>((resolve, reject) => {
		const pending = pendingCredentialMappingBatches.get(db)
		const request: PendingCredentialMappingRequest = {
			orgId: input.orgId,
			packageId: input.packageId,
			personId: input.personId,
			enablementIds,
			needKey: input.needKey,
			resolve,
			reject,
		}
		if (pending) {
			pending.push(request)
			return
		}
		pendingCredentialMappingBatches.set(db, [request])
		queueMicrotask(() => {
			void flushCredentialMappingBatch(db)
		})
	})
}

/**
 * Every stored mapping on the package, on every target (org default, each
 * member's default, each trigger override). For listing what the package can
 * reach, not for resolving one actor's run.
 */
export async function loadAllCredentialMappingsForPackage(input: {
	db: D1Database
	orgId: string
	packageId: string
}): Promise<Array<CredentialMappingRow>> {
	const result = await input.db
		.prepare(
			`SELECT need_key, target, person_user_id, enablement_id,
				credential_ids_json, updated_by_user_id, updated_at
			FROM credential_mappings
			WHERE org_id = ? AND package_id = ?
			ORDER BY need_key, target, person_user_id, enablement_id`,
		)
		.bind(input.orgId, input.packageId)
		.all<Row>()
	return (result.results ?? []).flatMap((row): Array<CredentialMappingRow> => {
		const target = toTarget(row)
		const credentialIds = parseIds(row.credential_ids_json)
		if (!target || !credentialIds) return []
		return [
			{
				needKey: row.need_key,
				target,
				credentialIds,
				updatedByUserId: row.updated_by_user_id,
				updatedAt: row.updated_at,
			},
		]
	})
}

/** Sets one need's mapping on one target; `null` clears it (inherit). */
export function buildWriteCredentialMappingStatement(input: {
	db: D1Database
	orgId: string
	packageId: string
	needKey: string
	target: CredentialMappingRowTarget
	credentialIds: ReadonlyArray<string> | null
	updatedByUserId: string
	now: string
}): D1PreparedStatement {
	// Bump before the statement runs so a later open on the same request
	// cannot keep a pre-write request-scoped snapshot (KODY-BF).
	bumpCredentialMappingGeneration(input.db)
	const { personUserId, enablementId } = targetColumns(input.target)
	if (input.credentialIds === null) {
		return input.db
			.prepare(
				`DELETE FROM credential_mappings
				WHERE org_id = ? AND package_id = ? AND target = ?
					AND person_user_id = ? AND enablement_id = ? AND need_key = ?`,
			)
			.bind(
				input.orgId,
				input.packageId,
				input.target.target,
				personUserId,
				enablementId,
				input.needKey,
			)
	}
	return input.db
		.prepare(
			`INSERT INTO credential_mappings (
				id, org_id, package_id, need_key, target, person_user_id,
				enablement_id, credential_ids_json, updated_by_user_id, created_at,
				updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (org_id, package_id, target, person_user_id, enablement_id, need_key)
			DO UPDATE SET credential_ids_json = excluded.credential_ids_json,
				updated_by_user_id = excluded.updated_by_user_id,
				updated_at = excluded.updated_at`,
		)
		.bind(
			crypto.randomUUID(),
			input.orgId,
			input.packageId,
			input.needKey,
			input.target.target,
			personUserId,
			enablementId,
			JSON.stringify(input.credentialIds),
			input.updatedByUserId,
			input.now,
			input.now,
		)
}

/** The invalid JSON a failed unchanged-guard evaluates. */
const credentialMappingChangedMarker = 'credential mapping changed'

/**
 * A batch guard: fails the statement (and so the whole D1 batch) unless the
 * row still holds `credentialIds` (null: no row). SQLite has no RAISE outside
 * triggers, so a mismatch evaluates `json()` on invalid text.
 */
export function buildCredentialMappingUnchangedStatement(input: {
	db: D1Database
	orgId: string
	packageId: string
	needKey: string
	target: CredentialMappingRowTarget
	credentialIds: ReadonlyArray<string> | null
}): D1PreparedStatement {
	const { personUserId, enablementId } = targetColumns(input.target)
	return input.db
		.prepare(
			`SELECT CASE WHEN (
				SELECT credential_ids_json FROM credential_mappings
				WHERE org_id = ? AND package_id = ? AND target = ?
					AND person_user_id = ? AND enablement_id = ? AND need_key = ?
			) IS ? THEN 1 ELSE json(?) END AS unchanged`,
		)
		.bind(
			input.orgId,
			input.packageId,
			input.target.target,
			personUserId,
			enablementId,
			input.needKey,
			input.credentialIds === null ? null : JSON.stringify(input.credentialIds),
			credentialMappingChangedMarker,
		)
}

/** Deleting a package drops every mapping for its needs. */
export async function deleteCredentialMappingsForPackage(input: {
	db: D1Database
	orgId: string
	packageId: string
}) {
	const result = await input.db
		.prepare(
			`DELETE FROM credential_mappings WHERE org_id = ? AND package_id = ?`,
		)
		.bind(input.orgId, input.packageId)
		.run()
	bumpCredentialMappingGeneration(input.db)
	return result.meta?.changes ?? 0
}

/** A member leaving an org takes their own defaults and trigger overrides with them. */
export async function deleteCredentialMappingsForMember(input: {
	db: D1Database
	orgId: string
	personId: string
}) {
	const result = await input.db
		.prepare(
			`DELETE FROM credential_mappings WHERE org_id = ? AND person_user_id = ?`,
		)
		.bind(input.orgId, input.personId)
		.run()
	bumpCredentialMappingGeneration(input.db)
	return result.meta?.changes ?? 0
}

export type StoredMappingResolution =
	| {
			source: 'trigger' | 'mine' | 'org'
			status: 'ready'
			credentials: Array<UsableCredential>
	  }
	| { source: 'trigger' | 'mine' | 'org'; status: 'none' }
	| { source: 'trigger'; status: 'unusable'; unusableIds: Array<string> }

/**
 * The first stored layer that yields a mapping: the trigger override, then
 * `mine`, then `org`. A trigger override naming a credential the actor cannot
 * Use (or one `accepts` rejects) is `unusable` and never falls through; a default
 * layer keeps only usable refs and counts as absent when none are left. Null
 * means nothing stored applies, so the caller auto-resolves.
 */
export function resolveStoredMapping(input: {
	trigger: ReadonlyArray<string> | null
	mine: ReadonlyArray<string> | null
	org: ReadonlyArray<string> | null
	usable: ReadonlyArray<UsableCredential>
	/** Whether a usable credential still fits the need (kind and provider). */
	accepts: (credential: UsableCredential) => boolean
}): StoredMappingResolution | null {
	const usableById = new Map(
		input.usable
			.filter(input.accepts)
			.map((credential) => [credential.id, credential]),
	)
	if (input.trigger) {
		if (input.trigger.length === 0) return { source: 'trigger', status: 'none' }
		const unusableIds = input.trigger.filter((id) => !usableById.has(id))
		if (unusableIds.length > 0) {
			return { source: 'trigger', status: 'unusable', unusableIds }
		}
		return {
			source: 'trigger',
			status: 'ready',
			credentials: input.trigger.map((id) => usableById.get(id)!),
		}
	}
	for (const source of ['mine', 'org'] as const) {
		const ids = input[source]
		if (!ids) continue
		if (ids.length === 0) return { source, status: 'none' }
		const credentials = ids.flatMap((id) => {
			const credential = usableById.get(id)
			return credential ? [credential] : []
		})
		if (credentials.length > 0) return { source, status: 'ready', credentials }
	}
	return null
}
