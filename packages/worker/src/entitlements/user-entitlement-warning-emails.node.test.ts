import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { type EntitlementResource } from '#universal/plans.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import type * as cloudflareEmail from '#app/email/cloudflare-email.ts'

const readAdminEntitlementConsumption = vi.fn()

vi.mock('#worker/admin/entitlement-consumption.ts', () => ({
	readAdminEntitlementConsumption: (...args: Array<unknown>) =>
		readAdminEntitlementConsumption(...args),
	entitlementWarningThreshold: 0.8,
}))

const sendCloudflareEmail = vi.fn<typeof cloudflareEmail.sendCloudflareEmail>(
	async () => ({ ok: true }),
)

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (
		...args: Parameters<typeof cloudflareEmail.sendCloudflareEmail>
	) => sendCloudflareEmail(...args),
}))

const {
	listUsersForEntitlementWarningSweep,
	sendEntitlementWarningNow,
	sendUserEntitlementWarningEmails,
	userEntitlementWarningDailyClaimTtlSeconds,
	userEntitlementWarningKvKey,
	userEntitlementWarningStockClaimTtlSeconds,
	userEntitlementWarningSweepLimit,
} = await import('#worker/entitlements/user-entitlement-warning-emails.ts')

const stableUserId = ownerIdFromStored('a').repeat(64)

function row(
	resource: EntitlementResource,
	current: number,
	limit: number,
	label = resource.replaceAll('_', ' '),
) {
	return {
		resource,
		label,
		current,
		limit,
		percentOfLimit: current / limit,
		overEightyPercent: current / limit > 0.8,
	}
}

function setConsumption(...rows: Array<ReturnType<typeof row>>) {
	readAdminEntitlementConsumption.mockResolvedValue(rows)
}

function createKv() {
	const store = new Map<string, string>()
	const puts: Array<{
		key: string
		value: string
		options?: { expirationTtl?: number }
	}> = []
	return {
		store,
		puts,
		kv: {
			async get(key: string) {
				return store.get(key) ?? null
			},
			async put(
				key: string,
				value: string,
				options?: { expirationTtl?: number },
			) {
				puts.push({ key, value, options })
				store.set(key, value)
			},
			async delete(key: string) {
				store.delete(key)
			},
		} as unknown as KVNamespace,
	}
}

type TestUser = {
	stable_user_id: string
	org_id: string
	email: string
	plan: string
	stripe_plan: string | null
	entitlement_ladder?: string | null
	stripe_credits_eligible?: number
}

function freeUser(email: string, id = stableUserId, orgId = id): TestUser {
	return {
		stable_user_id: id,
		org_id: orgId,
		email,
		plan: 'free',
		stripe_plan: null,
	}
}

function createDb(
	users: Array<TestUser>,
	rollups: Array<{ metric: string; event_count: number }> = [],
	options: {
		computeUwdUsers?: Array<TestUser>
		computeDorowsUsers?: Array<TestUser>
		activeUsers?: Array<TestUser>
		creditBalanceMicroUsd?: number
		usageWarningsEnabled?: boolean
	} = {},
) {
	let boundParams: Array<unknown> = []
	return {
		prepare(query: string) {
			const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					boundParams = params
					return this
				},
				async first<T>() {
					if (normalized.includes('select usage_warnings_enabled from orgs')) {
						return options.usageWarningsEnabled === false
							? ({ usage_warnings_enabled: 0 } as T)
							: null
					}
					if (normalized.includes('from credit_wallets')) {
						return {
							balance_micro_usd: options.creditBalanceMicroUsd ?? 0,
						} as T
					}
					if (
						normalized.includes('from users') &&
						(normalized.includes('stable_user_id = ?') ||
							normalized.includes('personal_org_id = ?'))
					) {
						const id = String(boundParams[0] ?? '')
						const user = users.find(
							(row) => row.stable_user_id === id || row.org_id === id,
						)
						return user ? ({ stable_user_id: user.stable_user_id } as T) : null
					}
					return null
				},
				async all<T>() {
					if (
						normalized.includes('from org_memberships') ||
						normalized.includes('join org_memberships')
					) {
						return { results: [] as Array<T> }
					}
					if (
						normalized.includes('from users') &&
						normalized.includes('stable_user_id in')
					) {
						const ids = new Set(boundParams.map((value) => String(value ?? '')))
						return {
							results: users
								.filter((row) => ids.has(row.stable_user_id))
								.map((row) => ({
									user_id: row.stable_user_id,
									email: row.email,
								})) as Array<T>,
						}
					}
					if (
						normalized.includes('from usage_rollups') &&
						normalized.includes('inner join users')
					) {
						if (normalized.includes("metric = 'dynamic_worker_day'")) {
							return {
								results: (options.computeUwdUsers ?? users) as Array<T>,
							}
						}
						if (normalized.includes("metric = 'durable_object_rows_read'")) {
							return {
								results: (options.computeDorowsUsers ?? users) as Array<T>,
							}
						}
						return {
							results: (options.activeUsers ?? users) as Array<T>,
						}
					}
					if (normalized.includes('from usage_rollups')) {
						return { results: rollups as Array<T> }
					}
					return { results: [] }
				},
			}
		},
	} as unknown as D1Database
}

function createEnv(input: {
	users: Array<TestUser>
	kv?: KVNamespace
	rollups?: Array<{ metric: string; event_count: number }>
	creditBalanceMicroUsd?: number
}) {
	return {
		APP_DB: createDb(input.users, input.rollups, {
			creditBalanceMicroUsd: input.creditBalanceMicroUsd,
		}),
		APP_BASE_URL: 'https://kody.codes/',
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token',
		BUNDLE_ARTIFACTS_KV: input.kv,
	} as unknown as Env
}

function instanceKey(
	kind: 'approaching' | 'reached',
	resource: EntitlementResource,
	now?: Date,
) {
	return userEntitlementWarningKvKey({
		userId: stableUserId,
		kind,
		resource,
		day: now ? utcDayKey(now) : undefined,
	})
}

function computeKey(month: string) {
	return userEntitlementWarningKvKey({
		userId: stableUserId,
		kind: 'approaching',
		resource: 'durable_object_rows_read',
		month,
	})
}

function notified(emailsSent: number, warnedResources: number, users = 1) {
	return {
		status: 'notified',
		emailedUsers: users,
		emailsSent,
		warnedResources,
	}
}

async function sendAt(env: Env, iso: string) {
	sendCloudflareEmail.mockClear()
	return await sendUserEntitlementWarningEmails({ env, now: new Date(iso) })
}

const at = (iso: string) => String(new Date(iso).getTime())

test('user entitlement warnings mail once per entitlement crossing through lifecycle transitions', async () => {
	const now = new Date('2026-07-25T12:00:00.000Z')
	const { kv, store, puts } = createKv()
	const env = createEnv({ users: [freeUser('jelias@example.com')], kv })

	// Daily resources claim per UTC day; stock resources (saved packages) claim
	// without a day and expire on the stock TTL.
	setConsumption(
		row('execute_unique_workers_per_day', 200, 250),
		row('saved_packages', 9, 10),
		row('secrets', 4, 25),
	)
	expect(await sendAt(env, now.toISOString())).toEqual(notified(1, 2))
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
	const approachingPayload = sendCloudflareEmail.mock.calls[0]?.[1] as {
		to: string
		from: string
		html: string
		text: string
	}
	expect(approachingPayload.to).toBe('jelias@example.com')
	expect(approachingPayload.from).toBe('kody@kody.codes')
	expect(approachingPayload.html).toContain(
		'https://kody.codes/account/usage#credits',
	)
	expect(approachingPayload.text).toContain('https://kody.codes/account/usage')
	expect(
		store.get(
			instanceKey('approaching', 'execute_unique_workers_per_day', now),
		),
	).toBe(String(now.getTime()))
	expect(store.get(instanceKey('approaching', 'saved_packages'))).toBe(
		String(now.getTime()),
	)
	expect(
		store.get(instanceKey('reached', 'execute_unique_workers_per_day', now)),
	).toBeUndefined()

	expect(await sendAt(env, '2026-07-25T13:00:00.000Z')).toEqual({
		status: 'no_warnings',
	})
	expect(sendCloudflareEmail).not.toHaveBeenCalled()

	setConsumption(
		row('execute_unique_workers_per_day', 10, 250),
		row('saved_packages', 9, 10),
	)
	expect(await sendAt(env, '2026-07-26T01:00:00.000Z')).toEqual({
		status: 'no_warnings',
	})
	expect(sendCloudflareEmail).not.toHaveBeenCalled()

	const reachedAt = new Date('2026-07-26T03:00:00.000Z')
	setConsumption(
		row('execute_unique_workers_per_day', 250, 250),
		row('outbound_fetches_per_day', 500, 500),
		row('saved_packages', 9, 10),
	)
	expect(await sendAt(env, reachedAt.toISOString())).toEqual(notified(1, 2))
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
	for (const [kind, resource] of [
		['reached', 'execute_unique_workers_per_day'],
		['approaching', 'execute_unique_workers_per_day'],
		['reached', 'outbound_fetches_per_day'],
	] as const) {
		expect(store.get(instanceKey(kind, resource, reachedAt))).toBe(
			String(reachedAt.getTime()),
		)
	}

	expect(await sendAt(env, '2026-07-26T04:00:00.000Z')).toEqual({
		status: 'no_warnings',
	})
	expect(sendCloudflareEmail).not.toHaveBeenCalled()

	const nextUtcDay = new Date('2026-07-27T02:00:00.000Z')
	setConsumption(
		row('execute_unique_workers_per_day', 200, 250),
		row('outbound_fetches_per_day', 500, 500),
		row('saved_packages', 9, 10),
	)
	expect(await sendAt(env, nextUtcDay.toISOString())).toEqual(notified(2, 2))
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(2)
	expect(
		store.get(instanceKey('reached', 'outbound_fetches_per_day', nextUtcDay)),
	).toBe(String(nextUtcDay.getTime()))
	expect(
		store.get(
			instanceKey('approaching', 'execute_unique_workers_per_day', nextUtcDay),
		),
	).toBe(String(nextUtcDay.getTime()))
	expect(
		store.get(
			instanceKey('reached', 'execute_unique_workers_per_day', nextUtcDay),
		),
	).toBeUndefined()

	// Dropping below the threshold clears the claims.
	const clearedAt = new Date('2026-07-27T04:00:00.000Z')
	setConsumption(
		row('execute_unique_workers_per_day', 10, 250),
		row('outbound_fetches_per_day', 0, 500),
		row('saved_packages', 2, 10),
	)
	await sendAt(env, clearedAt.toISOString())
	expect(
		[
			instanceKey('approaching', 'execute_unique_workers_per_day', clearedAt),
			instanceKey('approaching', 'saved_packages'),
			instanceKey('reached', 'outbound_fetches_per_day', clearedAt),
		].filter((key) => store.has(key)),
	).toEqual([])

	// Jumping straight to the limit claims both kinds with one email.
	const jumpedToLimit = '2026-07-27T05:00:00.000Z'
	setConsumption(row('saved_packages', 10, 10))
	expect(await sendAt(env, jumpedToLimit)).toEqual(notified(1, 1))
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
	expect(store.get(instanceKey('reached', 'saved_packages'))).toBe(
		at(jumpedToLimit),
	)
	expect(store.get(instanceKey('approaching', 'saved_packages'))).toBe(
		at(jumpedToLimit),
	)
	expect(
		puts.find((put) => put.key === instanceKey('reached', 'saved_packages'))
			?.options?.expirationTtl,
	).toBe(userEntitlementWarningStockClaimTtlSeconds)
	expect(
		puts.find(
			(put) =>
				put.key ===
				instanceKey('approaching', 'execute_unique_workers_per_day', now),
		)?.options?.expirationTtl,
	).toBe(userEntitlementWarningDailyClaimTtlSeconds)

	setConsumption(row('saved_packages', 9, 10))
	expect(await sendAt(env, '2026-07-27T06:00:00.000Z')).toEqual({
		status: 'no_warnings',
	})
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
})

test('user entitlement warning infra edges: missing bindings, TTL refresh, KV fail-open', async () => {
	setConsumption(row('execute_unique_workers_per_day', 200, 250))
	const noKv = await sendAt(
		createEnv({ users: [freeUser('user@example.com')] }),
		'2026-08-24T00:00:00.000Z',
	)
	expect(noKv).toEqual({ status: 'skipped', reason: 'no_kv' })
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
	const noConfig = await sendUserEntitlementWarningEmails({
		env: {
			APP_DB: createDb([]),
			BUNDLE_ARTIFACTS_KV: createKv().kv,
		} as unknown as Env,
	})
	expect(noConfig).toEqual({ status: 'skipped', reason: 'no_email_config' })

	// Staying over a stock limit refreshes only the stock claims' TTL.
	const ttl = createKv()
	const ttlEnv = createEnv({
		users: [freeUser('maciek@example.com')],
		kv: ttl.kv,
	})
	setConsumption(
		row('saved_packages', 10, 10),
		row('execute_unique_workers_per_day', 250, 250),
	)
	const ttlNow = '2026-08-24T02:00:00.000Z'
	expect(await sendAt(ttlEnv, ttlNow)).toEqual(notified(1, 2))
	expect(ttl.store.get(instanceKey('reached', 'saved_packages'))).toBe(
		at(ttlNow),
	)
	ttl.puts.length = 0
	const later = '2026-08-24T03:00:00.000Z'
	expect(await sendAt(ttlEnv, later)).toEqual({ status: 'no_warnings' })
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
	expect(ttl.store.get(instanceKey('reached', 'saved_packages'))).toBe(
		at(later),
	)
	expect(ttl.store.get(instanceKey('approaching', 'saved_packages'))).toBe(
		at(later),
	)
	expect(
		ttl.puts.filter(
			(put) => put.key === instanceKey('reached', 'saved_packages'),
		),
	).toEqual([
		{
			key: instanceKey('reached', 'saved_packages'),
			value: at(later),
			options: { expirationTtl: userEntitlementWarningStockClaimTtlSeconds },
		},
	])
	expect(
		ttl.puts.some((put) => put.key.includes('execute_unique_workers_per_day')),
	).toBe(false)

	// A failed claim write still mails that user (fail open) and does not
	// block other users' claims.
	consoleWarn.mockImplementation(() => {})
	const otherUserId = 'b'.repeat(64)
	const fail = createKv()
	const originalPut = fail.kv.put.bind(fail.kv)
	fail.kv.put = async (
		key: string,
		value: string,
		options?: { expirationTtl?: number },
	) => {
		if (key.includes(stableUserId) && key.includes('saved_packages')) {
			throw new Error('kv write failed')
		}
		return originalPut(key, value, options)
	}
	setConsumption(row('saved_packages', 10, 10))
	const failEnv = createEnv({
		users: [
			freeUser('first@example.com'),
			freeUser('second@example.com', otherUserId),
		],
		kv: fail.kv,
	})
	const failOpenAt = '2026-08-24T04:00:00.000Z'
	expect(await sendAt(failEnv, failOpenAt)).toEqual(notified(2, 2, 2))
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(2)
	expect(
		fail.store.get(instanceKey('reached', 'saved_packages')),
	).toBeUndefined()
	expect(
		fail.store.get(
			userEntitlementWarningKvKey({
				userId: otherUserId,
				kind: 'reached',
				resource: 'saved_packages',
			}),
		),
	).toBe(at(failOpenAt))
	expect(consoleWarn).toHaveBeenCalledWith(
		'user-entitlement-warning-claim-failed',
		expect.objectContaining({ kind: 'reached', resource: 'saved_packages' }),
	)
})

const emptyWalletProUser = {
	stable_user_id: stableUserId,
	org_id: stableUserId,
	email: 'compute@example.com',
	plan: 'free',
	stripe_plan: 'pro',
	entitlement_ladder: 'public',
	stripe_credits_eligible: 1,
} satisfies TestUser

test('compute include crossings mail an empty Pro wallet per UTC month, worded as include used (never >100%)', async () => {
	setConsumption()
	const { kv, store } = createKv()
	const rowsReadEnv = createEnv({
		users: [emptyWalletProUser],
		kv,
		rollups: [
			{ metric: 'durable_object_rows_read', event_count: 4_500_000_000 },
		],
	})

	const july = '2026-07-25T12:00:00.000Z'
	expect(await sendAt(rowsReadEnv, july)).toEqual(notified(1, 1))
	const approaching = sendCloudflareEmail.mock.calls[0]?.[1] as {
		text: string
	}
	expect(approaching.text).toContain(
		"Rows read — 90% of this month's include (4,500,000,000 of 5,000,000,000 rows read).",
	)
	expect(store.get(computeKey('2026-07'))).toBe(at(july))

	await sendAt(
		createEnv({
			users: [emptyWalletProUser],
			kv,
			rollups: [{ metric: 'dynamic_worker_day', event_count: 3_600 }],
		}),
		'2026-07-25T13:00:00.000Z',
	)
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
	const reached = sendCloudflareEmail.mock.calls[0]?.[1] as {
		text: string
		html: string
	}
	expect(reached.text).toContain(
		"Worker compute — this month's include is used up (3,600 of 350 worker-compute days).",
	)
	expect(reached.text).toContain(
		'With no credits left, usage past the include stops.',
	)
	for (const body of [reached.text, reached.html]) {
		expect(body).not.toMatch(/\b(?:1(?:0[1-9]|[1-9]\d)|[2-9]\d\d|\d{4,})%/)
	}

	// Compute claims are scoped to the UTC month: August warns again.
	expect(await sendAt(rowsReadEnv, '2026-08-02T12:00:00.000Z')).toEqual(
		notified(1, 1),
	)
	expect(store.has(computeKey('2026-08'))).toBe(true)
})

test('Free, funded, and wallet-less plans never get Worker compute or Rows read include emails; Free still gets execute-limit emails', async () => {
	setConsumption()
	const now = '2026-07-25T12:00:00.000Z'
	const rollups = [
		{ metric: 'dynamic_worker_day', event_count: 517 },
		{ metric: 'durable_object_rows_read', event_count: 900_000_000_000 },
	]
	for (const [user, creditBalanceMicroUsd] of [
		[freeUser('danj@example.com'), 0],
		[{ ...emptyWalletProUser, email: 'funded@example.com' }, 20_000_000],
		[
			{
				stable_user_id: stableUserId,
				org_id: stableUserId,
				email: 'retired@example.com',
				plan: 'standard',
				stripe_plan: 'standard',
				entitlement_ladder: 'legacy',
			},
			0,
		],
	] as const) {
		const { kv, store } = createKv()
		const result = await sendAt(
			createEnv({ users: [user], kv, rollups, creditBalanceMicroUsd }),
			now,
		)
		expect({ email: user.email, result }).toEqual({
			email: user.email,
			result: { status: 'no_warnings' },
		})
		expect(sendCloudflareEmail).not.toHaveBeenCalled()
		expect([...store.keys()]).toEqual([])
	}

	setConsumption(
		row('execute_unique_workers_per_day', 150, 150, 'Execute calls'),
	)
	const result = await sendAt(
		createEnv({
			users: [freeUser('free-execute@example.com')],
			kv: createKv().kv,
			rollups: [{ metric: 'dynamic_worker_day', event_count: 517 }],
		}),
		now,
	)
	expect(result).toMatchObject({ status: 'notified', warnedResources: 1 })
	const payload = sendCloudflareEmail.mock.calls[0]?.[1] as { text: string }
	expect(payload.text).toContain('Execute calls — 150 of 150 (100%).')
	expect(payload.text).not.toContain('Worker compute')
})

test('warning sweep consumption uses personal org id when distinct from person id', async () => {
	const personId = ownerIdFromStored('person-distinct').repeat(4).slice(0, 64)
	const orgId = ownerIdFromStored('org-distinct').repeat(4).slice(0, 64)
	expect(personId).not.toBe(orgId)
	setConsumption(row('saved_packages', 9, 10))
	const { kv } = createKv()
	const result = await sendUserEntitlementWarningEmails({
		env: createEnv({
			users: [freeUser('distinct@example.com', personId, orgId)],
			kv,
			rollups: [{ metric: 'execute', event_count: 10 }],
		}),
		now: new Date('2026-07-25T12:00:00.000Z'),
	})
	expect(result).toMatchObject({ status: 'notified' })
	expect(readAdminEntitlementConsumption.mock.calls[0]?.[0]).toMatchObject({
		usageUserId: orgId,
	})
})

test('compute warning sweep ranks Worker compute and Rows read separately and reserves compute candidates before the global cap', async () => {
	const sweepUser = (id: string, email: string) => {
		const stable = `${id}:${'x'.repeat(64)}`.slice(0, 64)
		return {
			stable_user_id: stable,
			org_id: stable,
			email,
			plan: 'free',
			stripe_plan: null,
			entitlement_ladder: 'public',
		}
	}
	const now = new Date('2026-08-02T12:00:00.000Z')

	const separate = await listUsersForEntitlementWarningSweep(
		createDb([], [], {
			activeUsers: [],
			computeUwdUsers: [sweepUser('worker', 'worker@example.com')],
			computeDorowsUsers: [sweepUser('dorows', 'dorows@example.com')],
		}),
		now,
	)
	expect(separate.map((user) => user.email).sort()).toEqual([
		'dorows@example.com',
		'worker@example.com',
	])

	const capped = await listUsersForEntitlementWarningSweep(
		createDb([], [], {
			activeUsers: Array.from(
				{ length: userEntitlementWarningSweepLimit },
				(_, index) =>
					sweepUser(`active-${index}`, `active-${index}@example.com`),
			),
			computeUwdUsers: [sweepUser('compute', 'compute-reserved@example.com')],
			computeDorowsUsers: [],
		}),
		now,
	)
	expect(capped).toHaveLength(userEntitlementWarningSweepLimit)
	expect(
		capped.some((user) => user.email === 'compute-reserved@example.com'),
	).toBe(true)
})

test('an immediate execute warning mails once and the hourly sweep then skips the same crossing', async () => {
	const now = new Date('2026-07-25T12:00:00.000Z')
	const { kv, store } = createKv()
	const env = createEnv({ users: [freeUser('jelias@example.com')], kv })
	const warning = row('execute_unique_workers_per_day', 120, 150)
	sendCloudflareEmail.mockClear()
	const sendNow = () =>
		sendEntitlementWarningNow({
			env,
			ownerId: ownerIdFromStored(stableUserId),
			kind: 'approaching',
			warning,
			now,
		})
	expect(await sendNow()).toBe(true)
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
	expect(
		store.has(
			instanceKey('approaching', 'execute_unique_workers_per_day', now),
		),
	).toBe(true)
	expect(await sendNow()).toBe(false)

	setConsumption(warning)
	expect(await sendAt(env, now.toISOString())).toEqual({
		status: 'no_warnings',
	})
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
})

test('an org that turned usage warnings off gets no warning email', async () => {
	const now = new Date('2026-07-25T12:00:00.000Z')
	const { kv, store } = createKv()
	const env = {
		...createEnv({ users: [freeUser('jelias@example.com')], kv }),
	} as Env
	env.APP_DB = createDb([freeUser('jelias@example.com')], [], {
		usageWarningsEnabled: false,
	})
	sendCloudflareEmail.mockClear()
	expect(
		await sendEntitlementWarningNow({
			env,
			ownerId: ownerIdFromStored(stableUserId),
			kind: 'approaching',
			warning: row('execute_unique_workers_per_day', 120, 150),
			now,
		}),
	).toBe(false)
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
	expect(
		store.has(
			instanceKey('approaching', 'execute_unique_workers_per_day', now),
		),
	).toBe(false)
})
