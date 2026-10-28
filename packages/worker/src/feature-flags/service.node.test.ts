import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	clearFeatureFlagUserOverride,
	deleteStaleFeatureFlag,
	getFeatureFlagEvaluationsForUser,
	getFeatureFlagsForUser,
	isFeatureEnabled,
	isFeatureGloballyEnabled,
	listFeatureFlagsForAdmin,
	setFeatureFlagGlobalState,
	setFeatureFlagUserOverride,
	setFeatureFlagUserOverrides,
} from './service.ts'

type GlobalRow = {
	key: string
	enabled: number
	rollout_percent: number | null
	audience: string
	note: string
	updated_by: number | null
	updated_at: string
}

type OverrideRow = {
	flag_key: string
	user_id: number
	enabled: number
	updated_by: number | null
	updated_at: string
}

type UserRow = {
	id: number
	username: string
	stable_user_id?: string
	experiments_opt_in?: number
}

type TestDb = D1Database & {
	globals: Map<string, GlobalRow>
	overrides: Map<string, OverrideRow>
	repoOverrides: Array<{ flag_key: string; source_id: string }>
}

type FlagKey = Parameters<typeof isFeatureEnabled>[1]

const orNull = (value: unknown) =>
	value === null || value === undefined ? null : value

const allResults = <T>(results: Array<unknown>) =>
	({ results, meta: { changes: 0 } }) as {
		results: Array<T>
		meta: { changes: number }
	}

function createFeatureFlagsTestDb(
	input: {
		globals?: Array<GlobalRow>
		overrides?: Array<OverrideRow>
		users?: Array<UserRow>
		repoOverrides?: Array<{ flag_key: string; source_id: string }>
	} = {},
) {
	const repoOverrides = [...(input.repoOverrides ?? [])]
	const globals = new Map(
		(input.globals ?? []).map((row) => [row.key, { ...row }]),
	)
	const overrides = new Map(
		(input.overrides ?? []).map((row) => [
			`${row.flag_key}:${row.user_id}`,
			{ ...row },
		]),
	)
	const users = new Map(
		(input.users ?? []).map((row) => [
			row.id,
			{
				...row,
				stable_user_id: row.stable_user_id ?? `stable-${row.id}`,
				experiments_opt_in: row.experiments_opt_in ?? 0,
			},
		]),
	)
	let clock = 0
	const nextTimestamp = () =>
		`2026-07-19T00:00:${String(++clock).padStart(2, '0')}.000Z`

	function createStatement(query: string, params: Array<unknown> = []) {
		const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
		const has = (...parts: Array<string>) =>
			parts.every((part) => normalized.includes(part))
		const optInUser = () => {
			const row = users.get(Number(params[0]))
			return row ? { experiments_opt_in: row.experiments_opt_in } : null
		}
		return {
			query,
			bind(...nextParams: Array<unknown>) {
				return createStatement(query, nextParams)
			},
			async first<T>() {
				if (
					has(
						'from feature_flag_user_overrides',
						'where flag_key = ? and user_id = ?',
					)
				) {
					const row = overrides.get(`${params[0]}:${params[1]}`)
					return (row ? { enabled: row.enabled } : null) as T | null
				}
				if (has('from feature_flags', 'where key = ?')) {
					const row = globals.get(String(params[0]))
					return (
						row
							? {
									enabled: row.enabled,
									rollout_percent: row.rollout_percent,
									audience: row.audience,
								}
							: null
					) as T | null
				}
				if (has('from users', 'experiments_opt_in', 'where id = ?')) {
					return optInUser() as T | null
				}
				throw new Error(`Unsupported first query: ${query}`)
			},
			async all<T>() {
				if (has('from feature_flags') && !has('where')) {
					return allResults<T>(
						[...globals.values()].map((row) => ({
							...row,
							updated_by_stable_user_id:
								users.get(row.updated_by ?? -1)?.stable_user_id ?? null,
						})),
					)
				}
				if (has('from feature_flag_user_overrides', 'where user_id = ?')) {
					return allResults<T>(
						[...overrides.values()]
							.filter((row) => row.user_id === Number(params[0]))
							.map(({ flag_key, enabled }) => ({ flag_key, enabled })),
					)
				}
				if (has('from users', 'experiments_opt_in', 'where id = ?')) {
					const row = optInUser()
					return allResults<T>(row ? [row] : [])
				}
				if (has('from feature_flag_user_overrides o', 'join users u')) {
					return allResults<T>(
						[...overrides.values()]
							.flatMap((row) => {
								const user = users.get(row.user_id)
								if (!user) return []
								const { flag_key, user_id, enabled, updated_at } = row
								const { username, stable_user_id } = user
								return [
									{
										flag_key,
										user_id,
										enabled,
										updated_at,
										username,
										stable_user_id,
									},
								]
							})
							.sort(
								(left, right) =>
									left.flag_key.localeCompare(right.flag_key) ||
									left.username.localeCompare(right.username),
							),
					)
				}
				if (has('from feature_flag_org_overrides')) {
					return allResults<T>([])
				}
				if (has('select distinct flag_key from feature_flag_repo_overrides')) {
					return allResults<T>(
						[...new Set(repoOverrides.map((row) => row.flag_key))].map(
							(flag_key) => ({ flag_key }),
						),
					)
				}
				throw new Error(`Unsupported all query: ${query}`)
			},
			async run() {
				if (
					normalized.startsWith('insert into feature_flags') &&
					has('on conflict(key) do update')
				) {
					const key = String(params[0])
					const existing = globals.get(key)
					const rolloutPercent = orNull(params[2])
					// Emulates COALESCE(?, '') on insert / COALESCE(?, note) on update.
					const note = orNull(params[3])
					const audience = existing
						? orNull(params[7])
						: (orNull(params[4]) ?? 'everyone')
					globals.set(key, {
						key,
						enabled: Number(params[1]),
						rollout_percent:
							rolloutPercent === null ? null : Number(rolloutPercent),
						audience:
							audience === null
								? (existing?.audience ?? 'everyone')
								: String(audience),
						note: note === null ? (existing?.note ?? '') : String(note),
						updated_by: Number(params[5]),
						updated_at: nextTimestamp(),
					})
					return { meta: { changes: 1 } }
				}
				if (
					normalized.startsWith('insert into feature_flag_user_overrides') &&
					has('on conflict(flag_key, user_id) do update')
				) {
					overrides.set(`${params[0]}:${params[1]}`, {
						flag_key: String(params[0]),
						user_id: Number(params[1]),
						enabled: Number(params[2]),
						updated_by: Number(params[3]),
						updated_at: nextTimestamp(),
					})
					return { meta: { changes: 1 } }
				}
				if (normalized.startsWith('delete from feature_flag_user_overrides')) {
					if (has('where flag_key = ? and user_id = ?')) {
						const existed = overrides.delete(`${params[0]}:${params[1]}`)
						return { meta: { changes: existed ? 1 : 0 } }
					}
					if (has('where flag_key = ?')) {
						const keys = [...overrides.keys()].filter((mapKey) =>
							mapKey.startsWith(`${params[0]}:`),
						)
						for (const mapKey of keys) overrides.delete(mapKey)
						return { meta: { changes: keys.length } }
					}
				}
				if (
					normalized.startsWith('delete from feature_flags') &&
					has('where key = ?')
				) {
					const existed = globals.delete(String(params[0]))
					return { meta: { changes: existed ? 1 : 0 } }
				}
				if (
					normalized.startsWith('delete from feature_flag_repo_overrides') &&
					has('where flag_key = ?')
				) {
					const before = repoOverrides.length
					for (let index = repoOverrides.length - 1; index >= 0; index -= 1) {
						if (repoOverrides[index]!.flag_key === params[0]) {
							repoOverrides.splice(index, 1)
						}
					}
					return { meta: { changes: before - repoOverrides.length } }
				}
				if (normalized.startsWith('delete from feature_flag_org_overrides')) {
					return { meta: { changes: 0 } }
				}
				throw new Error(`Unsupported run query: ${query}`)
			},
		}
	}

	return {
		prepare: (query: string) => createStatement(query),
		async batch(
			statements: Array<{
				query?: string
				all?: () => Promise<unknown>
				run?: () => Promise<{ meta: { changes: number } }>
			}>,
		) {
			const globalsSnapshot = new Map(
				[...globals.entries()].map(([key, row]) => [key, { ...row }]),
			)
			const overridesSnapshot = new Map(
				[...overrides.entries()].map(([key, row]) => [key, { ...row }]),
			)
			const results = []
			try {
				for (const statement of statements) {
					const isSelect = /^\s*select\b/i.test(statement.query ?? '')
					if (isSelect && typeof statement.all === 'function') {
						results.push(await statement.all())
					} else if (typeof statement.run === 'function') {
						results.push(await statement.run())
					} else {
						results.push({ meta: { changes: 0 } })
					}
				}
				return results
			} catch (error) {
				globals.clear()
				for (const [key, row] of globalsSnapshot) globals.set(key, row)
				overrides.clear()
				for (const [key, row] of overridesSnapshot) overrides.set(key, row)
				throw error
			}
		},
		globals,
		overrides,
		repoOverrides,
	} as unknown as TestDb
}

const registryKeys = [
	'demo-indicator',
	'connection-profiles',
	'mcp-skills-extension',
	'mcp-events-extension',
	'package-credential-suppliers',
	'repo-push-queue',
	'execution-contexts',
	'credential-need-enforcement',
] as const

function everyFlag<T>(value: T, overrides: Partial<Record<FlagKey, T>> = {}) {
	return {
		...Object.fromEntries(registryKeys.map((key) => [key, value])),
		...overrides,
	}
}

function setGlobal(
	db: TestDb,
	enabled: boolean,
	extra: Partial<Parameters<typeof setFeatureFlagGlobalState>[1]> = {},
) {
	return setFeatureFlagGlobalState(db, {
		key: 'demo-indicator',
		enabled,
		rolloutPercent: null,
		updatedBy: 1,
		...extra,
	})
}

function setOverride(db: TestDb, userId: number, enabled: boolean) {
	return setFeatureFlagUserOverride(db, {
		key: 'demo-indicator',
		userId,
		enabled,
		updatedBy: 1,
	})
}

function enabledFor(
	db: TestDb,
	userIds: Array<number | null>,
	key: FlagKey = 'demo-indicator',
) {
	return Promise.all(userIds.map((userId) => isFeatureEnabled(db, key, userId)))
}

async function userInBucket(db: TestDb, inRollout: boolean) {
	for (let userId = 1; userId < 10_000; userId += 1) {
		const enabled = await isFeatureEnabled(db, 'demo-indicator', userId)
		if (enabled === inRollout) {
			return userId
		}
	}
	throw new Error('No user found for rollout bucket')
}

test('isFeatureEnabled falls back to registry default when no DB state exists', async () => {
	const db = createFeatureFlagsTestDb()
	expect(await enabledFor(db, [1, null])).toEqual([false, false])
	await expect(getFeatureFlagsForUser(db, 1)).resolves.toEqual(everyFlag(false))
})

test('global on/off and percentage rollout evaluation', async () => {
	const db = createFeatureFlagsTestDb()

	await setGlobal(db, false)
	expect(await enabledFor(db, [1])).toEqual([false])

	await setGlobal(db, true, { note: 'fully on' })
	expect(await enabledFor(db, [1, null])).toEqual([true, true])
	await expect(isFeatureGloballyEnabled(db, 'demo-indicator')).resolves.toBe(
		true,
	)

	await setGlobal(db, true, { rolloutPercent: 50 })
	expect(
		await enabledFor(db, [
			await userInBucket(db, true),
			await userInBucket(db, false),
			null,
		]),
	).toEqual([true, false, false])
	await expect(isFeatureGloballyEnabled(db, 'demo-indicator')).resolves.toBe(
		true,
	)

	const invalidInputs: Array<
		[Partial<Parameters<typeof setFeatureFlagGlobalState>[1]>, RegExp]
	> = [
		[{ rolloutPercent: 101 }, /rolloutPercent/],
		[{ rolloutPercent: 12.5 }, /rolloutPercent/],
		[{ note: 42 }, /note must be a string/],
		[{ note: 'x'.repeat(501) }, /note must be at most 500 characters/],
	]
	for (const [extra, message] of invalidInputs) {
		await expect(setGlobal(db, true, extra)).rejects.toThrow(message)
	}

	await setGlobal(db, true, { note: 'keep me' })
	await setGlobal(db, false)
	expect(db.globals.get('demo-indicator')?.note).toBe('keep me')
	await setGlobal(db, false, { note: '' })
	expect(db.globals.get('demo-indicator')?.note).toBe('')
})

test('percentage rollout is deterministic per user and both outcomes appear', async () => {
	const db = createFeatureFlagsTestDb()
	await setGlobal(db, true, { rolloutPercent: 50 })

	const results = await enabledFor(
		db,
		Array.from({ length: 200 }, (_, index) => index + 1),
	)
	expect(results).toContain(true)
	expect(results).toContain(false)

	const sampleUserId = 42
	const first = await isFeatureEnabled(db, 'demo-indicator', sampleUserId)
	const second = await isFeatureEnabled(db, 'demo-indicator', sampleUserId)
	expect(first).toBe(second)
})

test('user override wins over global off and global on; clear restores evaluation', async () => {
	const db = createFeatureFlagsTestDb()

	await setGlobal(db, false)
	await setOverride(db, 7, true)
	expect(await enabledFor(db, [7, 8])).toEqual([true, false])
	await expect(getFeatureFlagsForUser(db, 7)).resolves.toEqual(
		everyFlag(false, { 'demo-indicator': true }),
	)

	await setGlobal(db, true)
	await setOverride(db, 7, false)
	expect(await enabledFor(db, [7, 8])).toEqual([false, true])

	const clear = () =>
		clearFeatureFlagUserOverride(db, { key: 'demo-indicator', userId: 7 })
	await expect(clear()).resolves.toBe(true)
	expect(await enabledFor(db, [7])).toEqual([true])
	await expect(clear()).resolves.toBe(false)
})

test('setFeatureFlagUserOverrides writes paired keys atomically', async () => {
	const db = createFeatureFlagsTestDb()
	await setFeatureFlagUserOverrides(db, [
		{
			key: 'mcp-skills-extension',
			userId: 7,
			enabled: true,
			updatedBy: 7,
		},
		{
			key: 'connection-profiles',
			userId: 7,
			enabled: true,
			updatedBy: 7,
		},
	])
	expect(await enabledFor(db, [7], 'mcp-skills-extension')).toEqual([true])
	expect(await enabledFor(db, [7], 'connection-profiles')).toEqual([true])

	const originalPrepare = db.prepare.bind(db)
	let overrideRuns = 0
	db.prepare = ((query: string) => {
		const statement = originalPrepare(query)
		return {
			...statement,
			bind(...params: Array<unknown>) {
				const bound = statement.bind(...params)
				return {
					...bound,
					async run() {
						overrideRuns += 1
						if (overrideRuns === 2) {
							throw new Error('second override write failed')
						}
						return bound.run()
					},
				}
			},
		}
	}) as typeof db.prepare

	await expect(
		setFeatureFlagUserOverrides(db, [
			{
				key: 'demo-indicator',
				userId: 7,
				enabled: true,
				updatedBy: 7,
			},
			{
				key: 'mcp-skills-extension',
				userId: 7,
				enabled: true,
				updatedBy: 7,
			},
		]),
	).rejects.toThrow('second override write failed')
	expect(db.overrides.has('demo-indicator:7')).toBe(false)
	expect(db.overrides.has('mcp-skills-extension:7')).toBe(true)
	expect(await enabledFor(db, [7], 'mcp-skills-extension')).toEqual([true])
	expect(await enabledFor(db, [7], 'connection-profiles')).toEqual([true])
})

test('getFeatureFlagEvaluationsForUser reports assignment sources', async () => {
	const db = createFeatureFlagsTestDb()
	const demoFor = async (userId: number | null) =>
		(await getFeatureFlagEvaluationsForUser(db, userId))['demo-indicator']

	await expect(getFeatureFlagEvaluationsForUser(db, 7)).resolves.toEqual(
		everyFlag({ enabled: false, source: 'default' }),
	)

	await setGlobal(db, true)
	expect(await demoFor(7)).toEqual({ enabled: true, source: 'global' })

	await setGlobal(db, true, { rolloutPercent: 50 })
	const rolloutEval = await demoFor(7)
	expect(rolloutEval.source).toBe('rollout')
	expect(typeof rolloutEval.enabled).toBe('boolean')
	expect(await demoFor(7)).toEqual(rolloutEval)
	// Anonymous users are excluded from percentage rollouts but the
	// assignment is still rollout-sourced.
	expect(await demoFor(null)).toEqual({ enabled: false, source: 'rollout' })

	await setOverride(db, 7, false)
	expect(await demoFor(7)).toEqual({ enabled: false, source: 'override' })
})

test('listFeatureFlagsForAdmin includes registry flags and stale DB-only keys', async () => {
	const db = createFeatureFlagsTestDb({
		users: [
			{ id: 3, username: 'alice' },
			{ id: 4, username: 'bob' },
		],
		globals: [
			{
				key: 'demo-indicator',
				enabled: 1,
				rollout_percent: 25,
				audience: 'everyone',
				note: 'rolling out',
				updated_by: 1,
				updated_at: '2026-07-01T00:00:00.000Z',
			},
			{
				key: 'retired-flag',
				enabled: 0,
				rollout_percent: null,
				audience: 'everyone',
				note: 'leftover',
				updated_by: null,
				updated_at: '2026-06-01T00:00:00.000Z',
			},
		],
		repoOverrides: [
			{ flag_key: 'repo-push-queue', source_id: 'repo-a' },
			{ flag_key: 'retired-repo-flag', source_id: 'repo-b' },
		],
		overrides: [
			{
				flag_key: 'demo-indicator',
				user_id: 4,
				enabled: 1,
				updated_by: 1,
				updated_at: '2026-07-02T00:00:00.000Z',
			},
			{
				flag_key: 'orphan-override',
				user_id: 3,
				enabled: 0,
				updated_by: 1,
				updated_at: '2026-07-03T00:00:00.000Z',
			},
		],
	})

	const listed = await listFeatureFlagsForAdmin(db)
	const byKey = (key: string) => listed.find((flag) => flag.key === key)
	const executeMetric = {
		eventType: 'execute',
		measure: 'event_count',
		goal: 'increase',
	}
	const registryExpectations: Array<[string, Record<string, unknown>]> = [
		[
			'connection-profiles',
			{ defaultAudience: 'experiments_opt_in', successMetric: executeMetric },
		],
		[
			'demo-indicator',
			{
				successMetric: null,
				global: {
					enabled: true,
					rolloutPercent: 25,
					audience: 'everyone',
					note: 'rolling out',
					updatedByStableUserId: null,
				},
				overrides: [
					{
						stableUserId: ownerIdFromStored('stable-4'),
						username: 'bob',
						enabled: true,
					},
				],
			},
		],
	]
	expect(registryExpectations.map(([key]) => byKey(key))).toMatchObject(
		registryExpectations.map(([key, fields]) => ({
			key,
			stale: false,
			defaultEnabled: false,
			...fields,
		})),
	)

	const staleShape = {
		description: null,
		defaultEnabled: null,
		defaultAudience: null,
		stale: true,
		successMetric: null,
	}
	expect(byKey('retired-flag')).toEqual({
		key: 'retired-flag',
		...staleShape,
		global: {
			enabled: false,
			rolloutPercent: null,
			audience: 'everyone',
			note: 'leftover',
			updatedByStableUserId: null,
			updatedAt: '2026-06-01T00:00:00.000Z',
		},
		orgOverrides: [],
		overrides: [],
	})
	expect(byKey('retired-repo-flag')).toEqual({
		key: 'retired-repo-flag',
		...staleShape,
		global: null,
		orgOverrides: [],
		overrides: [],
	})
	expect(byKey('repo-push-queue')?.stale).toBe(false)
	expect(byKey('orphan-override')).toEqual({
		key: 'orphan-override',
		...staleShape,
		global: null,
		orgOverrides: [],
		overrides: [
			{
				stableUserId: ownerIdFromStored('stable-3'),
				username: 'alice',
				enabled: false,
				updatedAt: '2026-07-03T00:00:00.000Z',
			},
		],
	})
})

test('deleteStaleFeatureFlag refuses registry keys and removes stale rows', async () => {
	const globalRow = (key: string) => ({
		key,
		enabled: 1,
		rollout_percent: null,
		audience: 'everyone',
		note: '',
		updated_by: 1,
		updated_at: '2026-07-01T00:00:00.000Z',
	})
	const db = createFeatureFlagsTestDb({
		users: [{ id: 3, username: 'alice' }],
		globals: [globalRow('demo-indicator'), globalRow('retired-flag')],
		repoOverrides: [
			{ flag_key: 'retired-flag', source_id: 'repo-a' },
			{ flag_key: 'retired-repo-only', source_id: 'repo-b' },
		],
		overrides: [
			{
				flag_key: 'retired-flag',
				user_id: 3,
				enabled: 1,
				updated_by: 1,
				updated_at: '2026-07-01T00:00:00.000Z',
			},
		],
	})

	await expect(deleteStaleFeatureFlag(db, 'demo-indicator')).rejects.toThrow(
		/Cannot delete registry feature flag/,
	)
	expect(db.globals.has('demo-indicator')).toBe(true)

	await expect(deleteStaleFeatureFlag(db, 'retired-flag')).resolves.toBe(true)
	expect(db.globals.has('retired-flag')).toBe(false)
	expect(db.overrides.size).toBe(0)
	expect(db.repoOverrides).toEqual([
		{ flag_key: 'retired-repo-only', source_id: 'repo-b' },
	])
	await expect(deleteStaleFeatureFlag(db, 'retired-flag')).resolves.toBe(false)
	await expect(deleteStaleFeatureFlag(db, 'retired-repo-only')).resolves.toBe(
		true,
	)
	expect(db.repoOverrides).toEqual([])
})

test('experiments_opt_in audience requires users.experiments_opt_in; overrides still win', async () => {
	const db = createFeatureFlagsTestDb({
		users: [
			{ id: 7, username: 'opted', experiments_opt_in: 1 },
			{ id: 8, username: 'plain', experiments_opt_in: 0 },
			{ id: 9, username: 'plain-two', experiments_opt_in: 0 },
		],
	})

	await setGlobal(db, true, { audience: 'experiments_opt_in' })
	expect(await enabledFor(db, [7, 8, 9, null])).toEqual([
		true,
		false,
		false,
		false,
	])

	await setOverride(db, 8, true)
	expect(await enabledFor(db, [8])).toEqual([true])

	await setGlobal(db, true)
	expect(await enabledFor(db, [9])).toEqual([false])

	await setGlobal(db, true, { audience: 'everyone' })
	expect(await enabledFor(db, [8, 9])).toEqual([true, true])

	await expect(
		setGlobal(db, true, { audience: 'not-a-real-audience' }),
	).rejects.toThrow(/audience must be one of/)
})

test('connection-profiles first insert without audience uses registry defaultAudience', async () => {
	const db = createFeatureFlagsTestDb({
		users: [
			{ id: 7, username: 'opted', experiments_opt_in: 1 },
			{ id: 8, username: 'plain', experiments_opt_in: 0 },
		],
	})

	await setGlobal(db, true, { key: 'connection-profiles' })
	expect(db.globals.get('connection-profiles')?.audience).toBe(
		'experiments_opt_in',
	)
	expect(await enabledFor(db, [7, 8], 'connection-profiles')).toEqual([
		true,
		false,
	])
})
