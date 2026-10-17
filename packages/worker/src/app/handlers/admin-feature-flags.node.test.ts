import { type PermissionString, type RoleName } from '#universal/permissions.ts'
import type * as AuditLog from '#worker/audit-log.ts'
import { adminOperationOutcome } from '#worker/test-support/admin-operation-outcome.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		getRequestIp: () => '127.0.0.1',
		logAuditEvent: (...args: Parameters<typeof actual.logAuditEvent>) =>
			logAuditEventSpy(...args),
	}
})

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
}

function stableUserId(id: number) {
	return id.toString(16).padStart(64, '0')
}

function createAdminActor(roles: Array<RoleName>) {
	const permissions: Array<PermissionString> = roles.includes('admin')
		? ['read:user:any', 'update:user:any']
		: ['read:user:own']
	return {
		sessionUserId: '1',
		userId: 1,
		email: 'admin@example.com',
		username: 'admin-user',
		displayName: 'admin-user',
		roles,
		permissions,
		artifactOwnerIds: ['1'],
		mcpUser: {
			userId: stableUserId(1),
			email: 'admin@example.com',
			username: 'admin-user',
			displayName: 'admin-user',
		},
	}
}

function createFeatureFlagsTestEnv(
	input: {
		globals?: Array<GlobalRow>
		overrides?: Array<OverrideRow>
		users?: Array<UserRow>
	} = {},
) {
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
			{ ...row, stable_user_id: row.stable_user_id ?? stableUserId(row.id) },
		]),
	)
	let clock = 0

	function nextTimestamp() {
		clock += 1
		return `2026-07-19T00:00:${String(clock).padStart(2, '0')}.000Z`
	}

	function normalize(query: string) {
		return query.replace(/\s+/g, ' ').trim().toLowerCase()
	}

	function createStatement(query: string, params: Array<unknown> = []) {
		const normalized = normalize(query)
		return {
			bind(...nextParams: Array<unknown>) {
				return createStatement(query, nextParams)
			},
			async first<T>() {
				if (
					normalized.includes(
						'select id, stable_user_id from users where stable_user_id = ?',
					)
				) {
					const user = [...users.values()].find(
						(row) => row.stable_user_id === params[0],
					)
					return (
						user ? { id: user.id, stable_user_id: user.stable_user_id } : null
					) as T | null
				}
				if (
					normalized.includes(
						'select id, stable_user_id from users where username = ?',
					)
				) {
					const username = String(params[0])
					for (const user of users.values()) {
						if (user.username === username) {
							return {
								id: user.id,
								stable_user_id: user.stable_user_id,
							} as T
						}
					}
					return null
				}
				if (
					normalized.includes('from feature_flag_user_overrides') &&
					normalized.includes('where flag_key = ? and user_id = ?')
				) {
					const row = overrides.get(`${params[0]}:${params[1]}`)
					return (row ? { enabled: row.enabled } : null) as T | null
				}
				if (
					normalized.includes('from feature_flags') &&
					normalized.includes('where key = ?')
				) {
					const row = globals.get(String(params[0]))
					return (
						row
							? {
									enabled: row.enabled,
									rollout_percent: row.rollout_percent,
								}
							: null
					) as T | null
				}
				throw new Error(`Unsupported first query: ${query}`)
			},
			async all<T>() {
				if (
					normalized.includes('from feature_flags') &&
					!normalized.includes('where')
				) {
					return {
						results: [...globals.values()].map((row) => ({
							...row,
							updated_by_stable_user_id:
								users.get(row.updated_by ?? -1)?.stable_user_id ?? null,
						})),
						meta: { changes: 0 },
					} as { results: Array<T>; meta: { changes: number } }
				}
				if (
					normalized.includes('from feature_flag_user_overrides o') &&
					normalized.includes('join users u')
				) {
					const rows = [...overrides.values()]
						.map((row) => {
							const user = users.get(row.user_id)
							if (!user) return null
							return {
								flag_key: row.flag_key,
								user_id: row.user_id,
								enabled: row.enabled,
								updated_at: row.updated_at,
								username: user.username,
								stable_user_id: user.stable_user_id,
							}
						})
						.filter((row) => row !== null)
						.sort((left, right) => {
							const byKey = left.flag_key.localeCompare(right.flag_key)
							if (byKey !== 0) return byKey
							return left.username.localeCompare(right.username)
						})
					return {
						results: rows,
						meta: { changes: 0 },
					} as { results: Array<T>; meta: { changes: number } }
				}
				// Metric readout queries (D1 fallback path); no data in this test.
				if (
					normalized.includes('from feature_flag_exposure_rollups') ||
					normalized.includes('from usage_rollups') ||
					normalized.includes('from feature_flag_repo_overrides')
				) {
					return { results: [] as Array<T>, meta: { changes: 0 } }
				}
				throw new Error(`Unsupported all query: ${query}`)
			},
			async run() {
				if (
					normalized.startsWith('insert into feature_flags') &&
					normalized.includes('on conflict(key) do update')
				) {
					const key = String(params[0])
					const enabled = Number(params[1])
					const rolloutPercent =
						params[2] === null || params[2] === undefined
							? null
							: Number(params[2])
					const noteParam =
						params[3] === null || params[3] === undefined
							? null
							: String(params[3])
					const note = noteParam ?? globals.get(key)?.note ?? ''
					const exists = globals.has(key)
					const insertAudience =
						params[4] === null || params[4] === undefined
							? 'everyone'
							: String(params[4])
					const updateAudienceParam = params[7]
					const audience = exists
						? updateAudienceParam === null || updateAudienceParam === undefined
							? (globals.get(key)?.audience ?? 'everyone')
							: String(updateAudienceParam)
						: insertAudience
					const updatedBy = Number(params[5])
					const updatedAt = nextTimestamp()
					globals.set(key, {
						key,
						enabled,
						rollout_percent: rolloutPercent,
						audience,
						note,
						updated_by: updatedBy,
						updated_at: updatedAt,
					})
					return { meta: { changes: 1 } }
				}
				if (
					normalized.startsWith('insert into feature_flag_user_overrides') &&
					normalized.includes('on conflict(flag_key, user_id) do update')
				) {
					const flagKey = String(params[0])
					const userId = Number(params[1])
					const enabled = Number(params[2])
					const updatedBy = Number(params[3])
					const updatedAt = nextTimestamp()
					overrides.set(`${flagKey}:${userId}`, {
						flag_key: flagKey,
						user_id: userId,
						enabled,
						updated_by: updatedBy,
						updated_at: updatedAt,
					})
					return { meta: { changes: 1 } }
				}
				if (
					normalized.startsWith('delete from feature_flag_user_overrides') &&
					normalized.includes('where flag_key = ? and user_id = ?')
				) {
					const mapKey = `${params[0]}:${params[1]}`
					const existed = overrides.delete(mapKey)
					return { meta: { changes: existed ? 1 : 0 } }
				}
				if (
					normalized.startsWith('delete from feature_flag_user_overrides') &&
					normalized.includes('where flag_key = ?')
				) {
					const flagKey = String(params[0])
					let changes = 0
					// Snapshot keys so deletes during this loop do not skip entries.
					// oxlint-disable-next-line unicorn/no-useless-spread
					for (const mapKey of [...overrides.keys()]) {
						if (mapKey.startsWith(`${flagKey}:`)) {
							overrides.delete(mapKey)
							changes += 1
						}
					}
					return { meta: { changes } }
				}
				if (
					normalized.startsWith('delete from feature_flags') &&
					normalized.includes('where key = ?')
				) {
					const existed = globals.delete(String(params[0]))
					return { meta: { changes: existed ? 1 : 0 } }
				}
				if (normalized.startsWith('delete from feature_flag_repo_overrides')) {
					return { meta: { changes: 0 } }
				}
				throw new Error(`Unsupported run query: ${query}`)
			},
		}
	}

	return {
		COOKIE_SECRET: 'secret',
		APP_DB: {
			prepare(query: string) {
				return createStatement(query)
			},
			async batch(
				statements: Array<{
					run: () => Promise<{ meta: { changes: number } }>
				}>,
			) {
				const results = []
				for (const statement of statements) {
					results.push(await statement.run())
				}
				return results
			},
		} as unknown as D1Database,
	}
}

const {
	setAdminGlobalFeatureFlag,
	setAdminFeatureFlagOverride,
	clearAdminFeatureFlagOverride,
	deleteAdminStaleFeatureFlag,
} = await import('#worker/admin/feature-flags-operations.ts')

function createFeatureFlagsClient(
	input: Parameters<typeof createFeatureFlagsTestEnv>[0] = {},
) {
	const env = createFeatureFlagsTestEnv(input) as unknown as Env
	const send = (body?: unknown) =>
		adminOperationOutcome(async () => {
			const url = new URL('https://example.com/admin/feature-flags.json')
			const request = new Request(url, {
				headers: { Accept: 'application/json' },
			})
			if (body !== undefined) {
				const { action, ...fields } = body as Record<string, unknown>
				switch (action) {
					case 'set_global':
						return setAdminGlobalFeatureFlag({
							env,
							request,
							fields: fields as Parameters<
								typeof setAdminGlobalFeatureFlag
							>[0]['fields'],
						})
					case 'set_user_override':
						return setAdminFeatureFlagOverride({
							env,
							request,
							fields: fields as Parameters<
								typeof setAdminFeatureFlagOverride
							>[0]['fields'],
						})
					case 'clear_user_override':
						return clearAdminFeatureFlagOverride({
							env,
							request,
							fields: fields as Parameters<
								typeof clearAdminFeatureFlagOverride
							>[0]['fields'],
						})
					case 'delete_stale':
						return deleteAdminStaleFeatureFlag({
							env,
							request,
							fields: fields as { key: string },
						})
					default:
						throw new Error('Unknown fixture operation')
				}
			}
			const { requireUserWithRole } = await import('#app/permissions-server.ts')
			await requireUserWithRole(request, env, 'admin')
			const { loadAdminFeatureFlagsData } =
				await import('#app/admin-feature-flags-data.ts')
			return loadAdminFeatureFlagsData(env)
		})
	return {
		get: () => send(),
		post: (body: Record<string, unknown>) => send(body),
		async expectFlag(
			response: Awaited<ReturnType<typeof adminOperationOutcome>>,
			flag: Record<string, unknown>,
		) {
			expect(response.status).toBe(200)
			const body = (await send()).data as {
				ok: boolean
				featureFlags: Array<{ key: string }>
			}
			expect(body).toMatchObject({ ok: true })
			expect(body.featureFlags).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ key: 'demo-indicator', ...flag }),
				]),
			)
		},
		async expectError(
			response: Awaited<ReturnType<typeof adminOperationOutcome>>,
			status: number,
		) {
			expect(response.status).toBe(status)
			await expect(Promise.resolve(response.data)).resolves.toMatchObject({
				ok: false,
				error: expect.any(String),
			})
		},
	}
}

function expectSetGlobalAudit(reason: string) {
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'feature_flag_set_global',
			result: 'success',
			reason,
		}),
	)
}

test('admin feature flags operations lifecycle: auth, list, set_global, and validation errors', async () => {
	const { get, post, expectFlag, expectError } = createFeatureFlagsClient()

	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['user']),
	)
	expect((await get()).status).toBe(403)

	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	await expectFlag(await get(), {
		stale: false,
		defaultEnabled: false,
		global: null,
		overrides: [],
	})

	const setGlobal = (body: Record<string, unknown>) =>
		post({ action: 'set_global', key: 'demo-indicator', ...body })
	await expectFlag(
		await setGlobal({ enabled: true, rolloutPercent: 25, note: 'canary' }),
		{
			global: expect.objectContaining({
				enabled: true,
				rolloutPercent: 25,
				audience: 'everyone',
				note: 'canary',
				updatedByStableUserId: null,
			}),
		},
	)
	expectSetGlobalAudit('key=demo-indicator;enabled=true;rollout_percent=25')

	logAuditEventSpy.mockClear()
	await expectFlag(
		await setGlobal({
			enabled: false,
			rolloutPercent: null,
			audience: 'experiments_opt_in',
			note: 'opt-in canary',
		}),
		{
			global: expect.objectContaining({
				enabled: false,
				rolloutPercent: null,
				audience: 'experiments_opt_in',
				note: 'opt-in canary',
			}),
		},
	)
	expectSetGlobalAudit(
		'key=demo-indicator;enabled=false;rollout_percent=null;audience=experiments_opt_in',
	)

	await expectError(
		await post({
			action: 'set_global',
			key: 'not-a-real-flag',
			enabled: true,
			rolloutPercent: null,
		}),
		400,
	)
	await expectError(
		await post({ action: 'delete_stale', key: 'demo-indicator' }),
		400,
	)
})

test('admin feature flags set_user_override validates user identity and existence', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	const { post, expectFlag, expectError } = createFeatureFlagsClient({
		users: [
			{ id: 1, username: 'admin-user' },
			{ id: 2, username: 'jane' },
		],
	})
	const setOverride = (identity: Record<string, unknown>) =>
		post({
			action: 'set_user_override',
			key: 'demo-indicator',
			enabled: true,
			...identity,
		})

	await expectError(await setOverride({}), 400)
	await expectError(
		await setOverride({ stableUserId: stableUserId(2), username: 'jane' }),
		400,
	)
	await expectError(await setOverride({ stableUserId: stableUserId(404) }), 404)

	await expectFlag(await setOverride({ username: 'jane' }), {
		overrides: [
			expect.objectContaining({
				stableUserId: stableUserId(2),
				username: 'jane',
				enabled: true,
			}),
		],
	})
})

test('admin feature flags clear_user_override accepts the same identity as set', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	const { post, expectFlag, expectError } = createFeatureFlagsClient({
		users: [
			{ id: 1, username: 'admin-user' },
			{ id: 2, username: 'jane' },
		],
	})
	const setOverride = () =>
		post({
			action: 'set_user_override',
			key: 'demo-indicator',
			enabled: true,
			username: 'jane',
		})
	const clearOverride = (identity: Record<string, unknown>) =>
		post({
			action: 'clear_user_override',
			key: 'demo-indicator',
			...identity,
		})

	await setOverride()
	await expectError(await clearOverride({}), 400)
	await expectError(
		await clearOverride({ stableUserId: stableUserId(2), username: 'jane' }),
		400,
	)
	await expectError(await clearOverride({ username: 'missing-user' }), 404)

	await expectFlag(await clearOverride({ username: 'jane' }), {
		overrides: [],
	})

	await setOverride()
	await expectFlag(await clearOverride({ stableUserId: stableUserId(2) }), {
		overrides: [],
	})
})

test('each feature flag mutation independently requires admin before resolving targets or changing data', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['user']),
	)
	const { post, expectError } = createFeatureFlagsClient()
	for (const body of [
		{ action: 'set_global', key: 'demo-indicator', enabled: true },
		{
			action: 'set_user_override',
			key: 'demo-indicator',
			username: 'jane',
			enabled: true,
		},
		{ action: 'clear_user_override', key: 'demo-indicator', username: 'jane' },
		{ action: 'delete_stale', key: 'stale-flag' },
	])
		await expectError(await post(body), 403)
})

test('reserved username operations independently require admin before writing', async () => {
	const { addAdminReservedUsernames, removeAdminReservedUsernames } =
		await import('#worker/admin/reserved-usernames-operations.ts')
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['user']),
	)
	const env = createFeatureFlagsTestEnv() as unknown as Env
	const request = new Request('https://example.com/_serverFn/admin')
	for (const operation of [
		addAdminReservedUsernames,
		removeAdminReservedUsernames,
	]) {
		await expect(
			operation({ env, request, usernames: ['example'] }),
		).rejects.toMatchObject({ status: 403 })
	}
})
