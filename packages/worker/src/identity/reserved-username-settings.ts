import { dnsSafeUsernamePattern } from '@kody-internal/shared/public-urls.ts'
import {
	builtInReservedUsernameList,
	computeEffectiveReservedUsernames,
	isBuiltInReservedUsername,
	isPermanentlyReservedUsername,
	isReservedUsername,
	isUsernameEffectivelyReserved,
	normalizeReservedUsername,
	usernameCollidesWithReservedNames,
} from '#worker/identity/reserved-usernames.ts'

import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
export const reservedUsernamesKvKey = 'platform-settings:v1:reserved-usernames'
const reservedUsernamesCacheTtlMs = 30_000
export const reservedUsernamesKvReadFailedLogKey =
	'reserved-usernames-kv-read-failed'

export type ReservedUsernamesRecord = {
	added: Array<string>
	removed: Array<string>
	updatedAt: string | null
	updatedBy: string | null
}

export type ReservedUsernameConflict = {
	username: string
	stableUserId: string
}

type ReservedUsernamesEnv = Pick<Env, 'BUNDLE_ARTIFACTS_KV'>

type ReservedUsernamesWriteEnv = Pick<Env, 'BUNDLE_ARTIFACTS_KV'>

const cacheGeneration = 0
const memos = new WeakMap<
	object,
	{
		expiresAt: number
		pending: Promise<ReservedUsernamesRecord>
		generation: number
	}
>()

function uniqueSorted(names: Iterable<string>) {
	return [...new Set(names)].sort((left, right) => left.localeCompare(right))
}

function parseNameList(value: unknown) {
	if (!Array.isArray(value)) return []
	const names: Array<string> = []
	for (const entry of value) {
		if (typeof entry !== 'string') continue
		const normalized = normalizeReservedUsername(entry)
		if (!normalized) continue
		names.push(normalized)
	}
	return uniqueSorted(names)
}

function parseReservedUsernamesRecord(
	value: unknown,
): ReservedUsernamesRecord | null {
	if (!value || typeof value !== 'object') return null
	const record = value as Record<string, unknown>
	if (!Array.isArray(record.added) || !Array.isArray(record.removed)) {
		return null
	}
	if (typeof record.updatedAt !== 'string' || record.updatedAt.length === 0) {
		return null
	}
	if (typeof record.updatedBy !== 'string' || record.updatedBy.length === 0) {
		return null
	}
	return {
		added: parseNameList(record.added),
		removed: parseNameList(record.removed).filter(
			(name) => !isPermanentlyReservedUsername(name),
		),
		updatedAt: record.updatedAt,
		updatedBy: record.updatedBy,
	}
}

function emptyRecord(): ReservedUsernamesRecord {
	return {
		added: [],
		removed: [],
		updatedAt: null,
		updatedBy: null,
	}
}

async function loadReservedUsernameRecordUncached(
	env: ReservedUsernamesEnv,
): Promise<ReservedUsernamesRecord> {
	const kv = env.BUNDLE_ARTIFACTS_KV
	if (!kv) return emptyRecord()
	try {
		const parsed = parseReservedUsernamesRecord(
			await kv.get(reservedUsernamesKvKey, 'json'),
		)
		return parsed ?? emptyRecord()
	} catch (error) {
		console.warn(reservedUsernamesKvReadFailedLogKey, error)
		return emptyRecord()
	}
}

export async function loadReservedUsernameRecord(
	env: ReservedUsernamesEnv,
): Promise<ReservedUsernamesRecord> {
	const now = Date.now()
	const cached = memos.get(env)
	if (
		cached &&
		cached.generation === cacheGeneration &&
		cached.expiresAt > now
	) {
		return cached.pending
	}
	const pending = loadReservedUsernameRecordUncached(env)
	memos.set(env, {
		expiresAt: now + reservedUsernamesCacheTtlMs,
		pending,
		generation: cacheGeneration,
	})
	pending.catch(() => {
		if (memos.get(env)?.pending === pending) memos.delete(env)
	})
	return pending
}

export async function isEffectivelyReservedUsername(
	username: string,
	env?: ReservedUsernamesEnv,
) {
	if (!env) return isReservedUsername(username)
	const record = await loadReservedUsernameRecord(env)
	return isUsernameEffectivelyReserved(username, record)
}

export async function getEffectiveReservedUsernameError(
	username: string,
	env?: ReservedUsernamesEnv,
) {
	if (await isEffectivelyReservedUsername(username, env)) {
		return 'This username is reserved.'
	}
	return null
}

export function parseReservedUsernameInputs(values: Iterable<string>) {
	const names: Array<string> = []
	const invalid: Array<string> = []
	for (const value of values) {
		for (const piece of value.split(/[\s,]+/)) {
			const normalized = normalizeReservedUsername(piece)
			if (!normalized) continue
			if (!dnsSafeUsernamePattern.test(normalized)) {
				invalid.push(normalized)
				continue
			}
			names.push(normalized)
		}
	}
	return {
		usernames: uniqueSorted(names),
		invalid: uniqueSorted(invalid),
	}
}

export class PermanentlyReservedUsernameError extends Error {
	readonly usernames: Array<string>

	constructor(usernames: Array<string>) {
		super(`These usernames cannot be unreserved: ${usernames.join(', ')}.`)
		this.name = 'PermanentlyReservedUsernameError'
		this.usernames = usernames
	}
}

export class InvalidReservedUsernameError extends Error {
	readonly usernames: Array<string>

	constructor(usernames: Array<string>) {
		super(`These usernames are not valid DNS labels: ${usernames.join(', ')}.`)
		this.name = 'InvalidReservedUsernameError'
		this.usernames = usernames
	}
}

async function writeReservedUsernameRecord(input: {
	env: ReservedUsernamesWriteEnv
	added: Array<string>
	removed: Array<string>
	updatedBy: string
}) {
	const kv = input.env.BUNDLE_ARTIFACTS_KV
	if (!kv) {
		throw new Error(
			'BUNDLE_ARTIFACTS_KV is required to persist reserved usernames.',
		)
	}
	const updatedAt = new Date().toISOString()
	const record = {
		added: uniqueSorted(input.added),
		removed: uniqueSorted(input.removed),
		updatedAt,
		updatedBy: input.updatedBy,
	}
	await kv.put(reservedUsernamesKvKey, JSON.stringify(record))
	memos.delete(input.env)
	return record satisfies {
		added: Array<string>
		removed: Array<string>
		updatedAt: string
		updatedBy: string
	}
}

export async function addReservedUsernames(input: {
	env: ReservedUsernamesWriteEnv
	usernames: Iterable<string>
	updatedBy: string
}) {
	const parsed = parseReservedUsernameInputs(input.usernames)
	if (parsed.invalid.length > 0) {
		throw new InvalidReservedUsernameError(parsed.invalid)
	}
	if (parsed.usernames.length === 0) {
		throw new Error('Provide at least one username.')
	}
	const current = await loadReservedUsernameRecordUncached(input.env)
	const added = new Set(current.added)
	const removed = new Set(current.removed)
	for (const name of parsed.usernames) {
		removed.delete(name)
		if (!isBuiltInReservedUsername(name)) {
			added.add(name)
		}
	}
	return writeReservedUsernameRecord({
		env: input.env,
		added: [...added],
		removed: [...removed],
		updatedBy: input.updatedBy,
	})
}

export async function removeReservedUsernames(input: {
	env: ReservedUsernamesWriteEnv
	usernames: Iterable<string>
	updatedBy: string
}) {
	const parsed = parseReservedUsernameInputs(input.usernames)
	if (parsed.invalid.length > 0) {
		throw new InvalidReservedUsernameError(parsed.invalid)
	}
	if (parsed.usernames.length === 0) {
		throw new Error('Provide at least one username.')
	}
	const permanentlyReserved = parsed.usernames.filter((name) =>
		isPermanentlyReservedUsername(name),
	)
	if (permanentlyReserved.length > 0) {
		throw new PermanentlyReservedUsernameError(permanentlyReserved)
	}
	const current = await loadReservedUsernameRecordUncached(input.env)
	const added = new Set(current.added)
	const removed = new Set(current.removed)
	for (const name of parsed.usernames) {
		if (added.has(name)) {
			added.delete(name)
			continue
		}
		if (isBuiltInReservedUsername(name)) {
			removed.add(name)
		}
	}
	return writeReservedUsernameRecord({
		env: input.env,
		added: [...added],
		removed: [...removed],
		updatedBy: input.updatedBy,
	})
}

const conflictQueryPageSize = 200

export async function findReservedUsernameConflicts(
	db: D1Database,
	effectiveUsernames: ReadonlySet<string>,
	added?: Iterable<string>,
) {
	const conflicts: Array<ReservedUsernameConflict> = []
	let offset = 0
	for (;;) {
		const result = await db
			.prepare(
				`SELECT username, stable_user_id
				 FROM users
				 WHERE 1 = 1${andLiveDeletedAtSql()}
				 ORDER BY username ASC
				 LIMIT ? OFFSET ?`,
			)
			.bind(conflictQueryPageSize, offset)
			.all<{ username: string; stable_user_id: string }>()
		const rows = result.results ?? []
		for (const row of rows) {
			if (
				!usernameCollidesWithReservedNames(row.username, effectiveUsernames, {
					added,
				})
			) {
				continue
			}
			conflicts.push({
				username: row.username,
				stableUserId: row.stable_user_id,
			})
		}
		if (rows.length < conflictQueryPageSize) break
		offset += conflictQueryPageSize
	}
	return conflicts
}

export async function loadReservedUsernameAdminSnapshot(env: Env) {
	// Admin reads confirm writes across request env identities. The public
	// username-validation memo can be stale for its TTL after another request.
	const record = await loadReservedUsernameRecordUncached(env)
	const effective = computeEffectiveReservedUsernames(record)
	const conflicts = await findReservedUsernameConflicts(
		env.APP_DB,
		effective,
		record.added,
	)
	return {
		builtIn: [...builtInReservedUsernameList],
		added: record.added,
		removed: record.removed,
		conflicts,
		updatedAt: record.updatedAt,
		updatedBy: record.updatedBy,
	}
}
