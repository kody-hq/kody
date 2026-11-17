import { env, runInDurableObject } from 'cloudflare:test'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import * as Sentry from '@sentry/cloudflare'
import { applyAdminOrgLimitOverrideChanges } from '#worker/admin/org-limit-overrides.ts'
import { ensureCreditWalletTestSchema } from '#worker/billing/test-schema.ts'
import type { UserMeter } from '#worker/entitlements/user-meter-do.ts'
import { admitHostedExecuteCall } from '#mcp/execute-admission.ts'
import { toApiError } from '#worker/open-api/errors.ts'
import type { OrgAuditWriter } from '#worker/orgs/org-audit.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { userMeterDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import {
	walletGuardLimitFields,
	walletGuardPlanLimits,
	walletGuards,
	walletGuardUserLimit,
	walletGuardWindowMs,
	walletGuardNames,
	type WalletGuardLimitKey,
	type WalletGuardName,
	type WalletGuardScope,
	type WalletGuardWindow,
} from '#universal/wallet-guards.ts'
import {
	WalletGuardLimitError,
	enforceWalletGuard,
	walletGuardRateLimitedResponse,
} from './enforce.ts'

const now = new Date('2026-11-17T12:00:20.000Z')
const actorUserId = 'person-1'

async function seedOrg(label: string) {
	await ensureCreditWalletTestSchema(env.APP_DB)
	const email = `${label}-${crypto.randomUUID()}@example.com`
	const stableUserId = testStableUserIdFromEmail(email)
	const username = `${label}-${crypto.randomUUID().slice(0, 8)}`
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, stable_user_id
		) VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(
			username,
			email,
			'test-password-hash',
			now.toISOString(),
			stableUserId,
		)
		.run()
	await provisionPersonalOrg(env.APP_DB, {
		stableUserId,
		username,
		plan: 'free',
		stripeCustomerId: null,
		stripePlan: null,
		stripeCreditsEligible: 0,
		createdAt: now.toISOString(),
	})
	return { email, stableUserId, ownerId: ownerIdFromStored(stableUserId) }
}

type SeededOrg = Awaited<ReturnType<typeof seedOrg>>

/** Put a window at `count` without making that many calls. */
async function setWindow(
	org: SeededOrg,
	input: {
		scope: string
		key: WalletGuardLimitKey
		window: WalletGuardWindow
		count: number
	},
) {
	const stub = env.USER_METER.get(
		env.USER_METER.idFromName(userMeterDurableObjectName(org.ownerId)),
	)
	const windowMs = walletGuardWindowMs[input.window]
	await runInDurableObject(stub, async (_instance: UserMeter, state) => {
		state.storage.sql.exec(
			`INSERT INTO wallet_guard_windows (bucket, window_start, count)
			VALUES (?, ?, ?)
			ON CONFLICT(bucket) DO UPDATE SET
				window_start = excluded.window_start, count = excluded.count`,
			`${input.scope}:${input.key}`,
			Math.floor(now.getTime() / windowMs) * windowMs,
			input.count,
		)
	})
}

function enforce(org: SeededOrg, guard: WalletGuardName, actor = actorUserId) {
	return enforceWalletGuard({
		env,
		ownerId: org.ownerId,
		email: org.email,
		actorUserId: actor,
		guard,
		now,
	})
}

const everyLimit = walletGuardNames.flatMap((guard) =>
	walletGuards[guard].limits.flatMap(({ key, window }) =>
		(['user', 'org'] as const).map((scope) => ({ guard, key, window, scope })),
	),
)

test.each(everyLimit)(
	'$key per $scope admits the last call under the limit and refuses the next',
	async ({ guard, key, window, scope }) => {
		consoleWarn.mockImplementation(() => {})
		const org = await seedOrg('wallet-guard-limit')
		const orgLimit = walletGuardPlanLimits[walletGuardLimitFields[key]]
		const limit = scope === 'org' ? orgLimit : walletGuardUserLimit(orgLimit)
		await setWindow(org, {
			scope: scope === 'org' ? 'org' : `user:${actorUserId}`,
			key,
			window,
			count: limit - 1,
		})

		await expect(enforce(org, guard)).resolves.toBeUndefined()
		const refusal = await enforce(org, guard).catch((error: unknown) => error)
		expect(refusal).toBeInstanceOf(WalletGuardLimitError)
		const windowMs = walletGuardWindowMs[window]
		expect((refusal as WalletGuardLimitError).details).toEqual({
			code: 'wallet_guard_limit',
			guard,
			limitKey: key,
			scope,
			window,
			windowSeconds: windowMs / 1000,
			limit,
			retryAfterSeconds: Math.ceil(
				(Math.floor(now.getTime() / windowMs) * windowMs +
					windowMs -
					now.getTime()) /
					1000,
			),
			support: 'support@kody.codes',
		})
		if (scope === 'user') {
			// Another person in the same org still has their own allowance.
			await expect(enforce(org, guard, 'person-2')).resolves.toBeUndefined()
		}
	},
)

async function refusedPublish(scope: WalletGuardScope = 'org') {
	const org = await seedOrg('wallet-guard-shape')
	const orgLimit = walletGuardPlanLimits.maxPublishesPerHour
	await setWindow(org, {
		scope: scope === 'org' ? 'org' : `user:${actorUserId}`,
		key: 'publishes_per_hour',
		window: 'hour',
		count: scope === 'org' ? orgLimit : walletGuardUserLimit(orgLimit),
	})
	const error = await enforce(org, 'publish').catch((caught: unknown) => caught)
	if (!(error instanceof WalletGuardLimitError)) {
		throw new Error('Expected the publish guard to refuse.')
	}
	return { org, error }
}

test('the error names the limit, the window, the wait, and support', async () => {
	consoleWarn.mockImplementation(() => {})
	const { error } = await refusedPublish()
	expect(error.message).toBe(
		'Rate limit reached (publishes_per_hour, per organization): 1,200 publishes per hour per organization. Retry in 3580s. This is a safety ceiling that normal use does not reach, so check for a loop. To get it raised, email support@kody.codes.',
	)
})

test('the Open API answers 429 with Retry-After and the limit details', async () => {
	consoleWarn.mockImplementation(() => {})
	const { error } = await refusedPublish('user')
	const apiError = toApiError(new Error('publish failed', { cause: error }))
	expect(apiError.status).toBe(429)
	expect(apiError.headers).toEqual({ 'Retry-After': '3580' })
	expect(apiError.toBody()).toEqual({
		error: {
			code: 'rate_limited',
			message: error.message,
			details: {
				code: 'wallet_guard_limit',
				guard: 'publish',
				limitKey: 'publishes_per_hour',
				scope: 'user',
				window: 'hour',
				windowSeconds: 3600,
				limit: 600,
				retryAfterSeconds: 3580,
				support: 'support@kody.codes',
			},
		},
	})
})

test('git smart HTTP answers a plain-text 429 with Retry-After', async () => {
	consoleWarn.mockImplementation(() => {})
	const { error } = await refusedPublish()
	const response = walletGuardRateLimitedResponse(error)
	expect(response.status).toBe(429)
	expect(response.headers.get('Retry-After')).toBe('3580')
	expect(await response.text()).toBe(`${error.message}\n`)
})

test('every hit is logged in structured form and reported to Sentry', async () => {
	consoleWarn.mockImplementation(() => {})
	const warn = consoleWarn
	const breadcrumb = vi.spyOn(Sentry, 'addBreadcrumb')
	const captureMessage = vi.spyOn(Sentry, 'captureMessage')
	const { org } = await refusedPublish()
	await expect(enforce(org, 'publish')).rejects.toBeInstanceOf(
		WalletGuardLimitError,
	)

	const logged = warn.mock.calls
		.map(([line]) => (typeof line === 'string' ? line : ''))
		.filter((line) => line.includes('wallet_guard_limit_hit'))
		.map((line) => JSON.parse(line) as Record<string, unknown>)
	expect(logged).toHaveLength(2)
	expect(logged[0]).toEqual({
		event: 'wallet_guard_limit_hit',
		guard: 'publish',
		limitKey: 'publishes_per_hour',
		scope: 'org',
		window: 'hour',
		windowSeconds: 3600,
		limit: 1200,
		retryAfterSeconds: 3580,
		orgId: org.stableUserId,
		actorUserId,
	})
	expect(breadcrumb).toHaveBeenCalledTimes(2)
	expect(breadcrumb).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'wallet_guard',
			message: 'Wallet guard limit hit: publishes_per_hour (per org)',
		}),
	)
	// The event is throttled per org and limit; the breadcrumb is not.
	expect(captureMessage).toHaveBeenCalledTimes(1)
	expect(captureMessage).toHaveBeenCalledWith(
		'Wallet guard limit hit: publishes_per_hour (per org)',
	)
})

test('automation counts against the org and not against a person', async () => {
	consoleWarn.mockImplementation(() => {})
	const org = await seedOrg('wallet-guard-automation')
	await setWindow(org, {
		scope: 'org',
		key: 'package_checks_per_day',
		window: 'day',
		count: walletGuardPlanLimits.maxPackageChecksPerDay - 1,
	})
	const automation = () =>
		enforceWalletGuard({
			env,
			ownerId: org.ownerId,
			email: null,
			actorUserId: null,
			guard: 'check',
			now,
		})
	await expect(automation()).resolves.toBeUndefined()
	await expect(automation()).rejects.toMatchObject({
		details: { limitKey: 'package_checks_per_day', scope: 'org' },
	})
})

test('an admin limit override raises the org and per-person ceilings without a deploy', async () => {
	consoleWarn.mockImplementation(() => {})
	const org = await seedOrg('wallet-guard-override')
	const orgLimit = walletGuardPlanLimits.maxGitOperationsPer5Minutes
	await setWindow(org, {
		scope: 'org',
		key: 'git_operations_per_5_minutes',
		window: 'five_minutes',
		count: orgLimit,
	})
	await expect(enforce(org, 'git')).rejects.toBeInstanceOf(
		WalletGuardLimitError,
	)

	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS org_audit_events (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	actor_user_id TEXT,
	actor_username TEXT,
	credential_kind TEXT,
	credential_id TEXT,
	action TEXT NOT NULL,
	resource_type TEXT,
	resource_id TEXT,
	target_user_id TEXT,
	result TEXT NOT NULL CHECK (result IN ('success', 'failure', 'denied')),
	details_json TEXT,
	ip_hash TEXT,
	created_at TEXT NOT NULL
)`,
	).run()
	const audit: OrgAuditWriter = {
		appDb: env.APP_DB,
		db: env.APP_DB,
		actorUserId: testStableUserIdFromEmail('wallet-guard-admin@example.com'),
		actorUsername: 'wallet-guard-admin',
		credentialKind: null,
		credentialId: null,
	}
	await applyAdminOrgLimitOverrideChanges({
		db: env.APP_DB,
		target: { orgId: org.stableUserId },
		changes: [{ key: 'git_operations_per_5_minutes', value: orgLimit * 4 }],
		reason: 'wallet guard override test',
		audit,
		now,
	})

	await expect(enforce(org, 'git')).resolves.toBeUndefined()
	await setWindow(org, {
		scope: `user:${actorUserId}`,
		key: 'git_operations_per_5_minutes',
		window: 'five_minutes',
		count: orgLimit * 2,
	})
	await expect(enforce(org, 'git')).rejects.toMatchObject({
		details: { scope: 'user', limit: orgLimit * 2 },
	})
})

test('hosted execute is refused once the daily execute ceiling is reached', async () => {
	consoleWarn.mockImplementation(() => {})
	const org = await seedOrg('wallet-guard-execute')
	await setWindow(org, {
		scope: 'org',
		key: 'execute_calls_per_day',
		window: 'day',
		count: walletGuardPlanLimits.maxExecuteCallsPerDay - 1,
	})
	const admit = () =>
		admitHostedExecuteCall({
			env,
			ownerId: org.ownerId,
			email: org.email,
			actorUserId,
			now,
		})
	await expect(admit()).resolves.toBeUndefined()
	await expect(admit()).rejects.toMatchObject({
		name: 'WalletGuardLimitError',
		details: {
			limitKey: 'execute_calls_per_day',
			scope: 'org',
			limit: 120_000,
		},
	})
})
