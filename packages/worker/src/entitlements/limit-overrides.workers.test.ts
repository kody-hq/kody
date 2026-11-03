import { env } from 'cloudflare:test'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	applyAdminOrgLimitOverrideChanges,
	loadAdminOrgLimits,
	orgLimitOverrideAuditActions,
} from '#worker/admin/org-limit-overrides.ts'
import { ensureCreditWalletTestSchema } from '#worker/billing/test-schema.ts'
import {
	isComputeOverageLimitError,
	isEntitlementLimitError,
} from '#worker/entitlements/errors.ts'
import {
	consumeDailyEntitlement,
	consumeExecuteUniqueWorkerDay,
	getCachedUserEntitlement,
	readDailyEntitlementResourceUsage,
	readExecuteUniqueWorkerUsage,
} from '#worker/entitlements/service.ts'
import { assertCallerCanAccessCapability } from '#mcp/capabilities/access-control.ts'
import { adminOrgLimitOverridesSetCapability } from '#mcp/capabilities/admin/admin-org-limit-overrides-set.ts'
import { adminOrgLimitsGetCapability } from '#mcp/capabilities/admin/admin-org-limits-get.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { buildExecuteUsageReport } from '#mcp/execute-admission.ts'
import type { OrgAuditWriter } from '#worker/orgs/org-audit.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { planLimits, unlimitedLimit } from '#universal/plans.ts'

const now = new Date('2026-10-10T12:00:00.000Z')
const freeSendsPerDay = planLimits.free.maxEmailSendsPerDay

type SeededOrg = { email: string; stableUserId: string; username: string }

async function seedOrg(input: {
	label: string
	plan?: string
	stripePlan?: string | null
	creditsEligible?: boolean
}): Promise<SeededOrg> {
	await ensureCreditWalletTestSchema(env.APP_DB)
	const email = `${input.label}-${crypto.randomUUID()}@example.com`
	const stableUserId = testStableUserIdFromEmail(email)
	const username = `${input.label}-${crypto.randomUUID().slice(0, 8)}`
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
		plan: input.plan ?? 'free',
		stripeCustomerId: null,
		stripePlan: input.stripePlan ?? null,
		stripeCreditsEligible: input.creditsEligible ? 1 : 0,
		createdAt: now.toISOString(),
	})
	return { email, stableUserId, username }
}

async function ensureOrgAuditTable() {
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
}

const adminId = testStableUserIdFromEmail('limits-admin@example.com')

async function adminAudit(): Promise<OrgAuditWriter> {
	await ensureOrgAuditTable()
	return {
		appDb: env.APP_DB,
		db: env.APP_DB,
		actorUserId: adminId,
		actorUsername: 'limits-admin',
		credentialKind: null,
		credentialId: null,
	}
}

async function readAuditEvents(orgId: string) {
	const { results } = await env.APP_DB.prepare(
		`SELECT action, actor_user_id, resource_type, resource_id, details_json
		 FROM org_audit_events WHERE org_id = ? ORDER BY created_at, rowid`,
	)
		.bind(orgId)
		.all<{
			action: string
			actor_user_id: string
			resource_type: string
			resource_id: string
			details_json: string
		}>()
	return results.map((row) => ({
		action: row.action,
		actorUserId: row.actor_user_id,
		resourceType: row.resource_type,
		resourceId: row.resource_id,
		details: JSON.parse(row.details_json) as Record<string, unknown>,
	}))
}

function sendEmail(org: SeededOrg, at = now) {
	return consumeDailyEntitlement({
		db: env.APP_DB,
		env,
		userId: ownerIdFromStored(org.stableUserId),
		email: org.email,
		resource: 'email_sends_per_day',
		now: at,
	})
}

async function sendEmails(org: SeededOrg, times: number, at = now) {
	for (let index = 0; index < times; index += 1) await sendEmail(org, at)
}

async function expectDenied(promise: Promise<unknown>, limit: number) {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught,
	)
	expect(isEntitlementLimitError(error)).toBe(true)
	if (!isEntitlementLimitError(error)) return
	expect(error.details).toMatchObject({
		resource: 'email_sends_per_day',
		limit,
	})
}

function sentToday(org: SeededOrg, at = now) {
	return readDailyEntitlementResourceUsage({
		env,
		userId: ownerIdFromStored(org.stableUserId),
		resource: 'email_sends_per_day',
		now: at,
	})
}

async function setOverrides(
	org: SeededOrg,
	changes: Parameters<typeof applyAdminOrgLimitOverrideChanges>[0]['changes'],
	at = now,
) {
	return applyAdminOrgLimitOverrideChanges({
		db: env.APP_DB,
		audit: await adminAudit(),
		target: { orgId: org.stableUserId },
		changes,
		reason: 'limit override test',
		now: at,
	})
}

test('no override: the plan cap is enforced through UserMeter', async () => {
	const org = await seedOrg({ label: 'override-none' })
	await sendEmails(org, freeSendsPerDay)
	await expectDenied(sendEmail(org), freeSendsPerDay)
	expect(await sentToday(org)).toBe(freeSendsPerDay)

	const limits = await loadAdminOrgLimits({
		db: env.APP_DB,
		target: { orgId: org.stableUserId },
		now,
	})
	expect(
		limits.limits.find((row) => row.key === 'email_sends_per_day'),
	).toEqual(
		expect.objectContaining({
			planLimit: freeSendsPerDay,
			effectiveLimit: freeSendsPerDay,
			override: null,
		}),
	)
})

test('a raised cap applies on the next counted check, even with a warm entitlement cache', async () => {
	const org = await seedOrg({ label: 'override-raised' })
	const context = { userId: org.stableUserId, email: org.email }
	// Warm this isolate's entitlement cache before the write.
	expect(
		(await getCachedUserEntitlement(env.APP_DB, context)).limitOverrides,
	).toEqual([])
	await sendEmails(org, freeSendsPerDay)
	await expectDenied(sendEmail(org), freeSendsPerDay)

	const raised = freeSendsPerDay + 3
	const result = await setOverrides(org, [
		{ key: 'email_sends_per_day', value: raised },
	])
	expect(result.changedKeys).toEqual(['email_sends_per_day'])

	// The writer isolate's cache was dropped on write.
	expect(
		(await getCachedUserEntitlement(env.APP_DB, context)).limitOverrides,
	).toEqual([{ key: 'email_sends_per_day', value: raised, expiresAt: null }])
	await sendEmails(org, 3)
	await expectDenied(sendEmail(org), raised)
	expect(await sentToday(org)).toBe(raised)

	// An override below the plan limit never lowers it.
	await setOverrides(org, [{ key: 'email_receives_per_day', value: 1 }])
	const limits = await loadAdminOrgLimits({
		db: env.APP_DB,
		target: { orgId: org.stableUserId },
		now,
	})
	expect(
		limits.limits.find((row) => row.key === 'email_receives_per_day'),
	).toMatchObject({
		planLimit: planLimits.free.maxEmailReceivesPerDay,
		effectiveLimit: planLimits.free.maxEmailReceivesPerDay,
	})
})

test('a cache warmed in another isolate still sees the override: counted checks read it live', async () => {
	const org = await seedOrg({ label: 'override-live' })
	const context = { userId: org.stableUserId, email: org.email }
	await getCachedUserEntitlement(env.APP_DB, context)
	await sendEmails(org, freeSendsPerDay)
	// Written straight to D1 with no cache invalidation, as another
	// isolate's write would look from here.
	await env.APP_DB.prepare(
		`INSERT INTO org_limit_overrides (
			org_id, limit_key, limit_value, reason, expires_at, set_by_user_id,
			created_at, updated_at
		) VALUES (?, 'email_sends_per_day', NULL, 'other isolate', NULL, ?, ?, ?)`,
	)
		.bind(org.stableUserId, adminId, now.toISOString(), now.toISOString())
		.run()
	expect(
		(await getCachedUserEntitlement(env.APP_DB, context)).limitOverrides,
	).toEqual([])
	await sendEmails(org, 2)
	expect(await sentToday(org)).toBe(freeSendsPerDay + 2)
})

test('the execute usage readout reads overrides live, like the counted check', async () => {
	const org = await seedOrg({ label: 'override-execute-readout' })
	const context = { userId: org.stableUserId, email: org.email }
	await getCachedUserEntitlement(env.APP_DB, context)
	await env.APP_DB.prepare(
		`INSERT INTO org_limit_overrides (
			org_id, limit_key, limit_value, reason, expires_at, set_by_user_id,
			created_at, updated_at
		) VALUES (?, 'execute_unique_workers_per_day', 400, 'other isolate', NULL, ?, ?, ?)`,
	)
		.bind(org.stableUserId, adminId, now.toISOString(), now.toISOString())
		.run()
	const usage = await readExecuteUniqueWorkerUsage({
		db: env.APP_DB,
		env,
		userId: ownerIdFromStored(org.stableUserId),
		email: org.email,
		now,
	})
	// Execute responses build structuredContent.usage from this readout, so
	// limit and remaining must be the effective override, not the plan cap.
	expect(usage).toMatchObject({ used: 0, limit: 400 })
	expect(buildExecuteUsageReport(usage, now).day).toEqual({
		used: 0,
		limit: 400,
		remaining: 400,
		resetsAt: '2026-10-11T00:00:00.000Z',
	})
})

test('unlimited lifts the cap; removing it restores the plan cap', async () => {
	const org = await seedOrg({ label: 'override-unlimited' })
	await setOverrides(org, [{ key: 'email_sends_per_day', value: 'unlimited' }])
	await sendEmails(org, freeSendsPerDay * 2)
	expect(await sentToday(org)).toBe(freeSendsPerDay * 2)

	const limits = await loadAdminOrgLimits({
		db: env.APP_DB,
		target: { orgId: org.stableUserId },
		now,
	})
	expect(
		limits.limits.find((row) => row.key === 'email_sends_per_day'),
	).toMatchObject({
		planLimit: freeSendsPerDay,
		effectiveLimit: unlimitedLimit,
		override: expect.objectContaining({
			value: 'unlimited',
			reason: 'limit override test',
			setByUserId: adminId,
			active: true,
		}),
	})

	const removed = await setOverrides(org, [
		{ key: 'email_sends_per_day', value: null },
	])
	expect(removed.changedKeys).toEqual(['email_sends_per_day'])
	await expectDenied(sendEmail(org), freeSendsPerDay)
})

test('an expired override stops applying', async () => {
	const org = await seedOrg({ label: 'override-expired' })
	const expiresAt = new Date(now.getTime() + 60 * 60 * 1000)
	await setOverrides(
		org,
		[
			{
				key: 'email_sends_per_day',
				value: freeSendsPerDay + 5,
				expiresAt: expiresAt.toISOString(),
			},
		],
		now,
	)
	await sendEmails(org, freeSendsPerDay + 1, now)

	const afterExpiry = new Date(expiresAt.getTime() + 1)
	await expectDenied(sendEmail(org, afterExpiry), freeSendsPerDay)
	const limits = await loadAdminOrgLimits({
		db: env.APP_DB,
		target: { orgId: org.stableUserId },
		now: afterExpiry,
	})
	expect(
		limits.limits.find((row) => row.key === 'email_sends_per_day'),
	).toMatchObject({
		effectiveLimit: freeSendsPerDay,
		override: expect.objectContaining({ active: false }),
	})
})

test('every set, change, and remove writes an org audit event with the admin, old and new values, and the reason', async () => {
	const org = await seedOrg({ label: 'override-audit' })
	await setOverrides(org, [{ key: 'job_runs_per_day', value: 500 }])
	// Unchanged entries are skipped and write no event.
	const unchanged = await setOverrides(org, [
		{ key: 'job_runs_per_day', value: 500 },
	])
	expect(unchanged.changedKeys).toEqual([])
	await setOverrides(org, [{ key: 'job_runs_per_day', value: 'unlimited' }])
	await setOverrides(org, [{ key: 'job_runs_per_day', value: null }])

	const next = (value: number | 'unlimited') => ({
		value,
		expiresAt: null,
		reason: 'limit override test',
		setByUserId: adminId,
	})
	expect(await readAuditEvents(org.stableUserId)).toEqual([
		{
			action: orgLimitOverrideAuditActions.set,
			actorUserId: adminId,
			resourceType: 'limit_override',
			resourceId: 'job_runs_per_day',
			details: {
				limitKey: 'job_runs_per_day',
				previous: null,
				next: next(500),
				reason: 'limit override test',
			},
		},
		{
			action: orgLimitOverrideAuditActions.changed,
			actorUserId: adminId,
			resourceType: 'limit_override',
			resourceId: 'job_runs_per_day',
			details: {
				limitKey: 'job_runs_per_day',
				previous: next(500),
				next: next('unlimited'),
				reason: 'limit override test',
			},
		},
		{
			action: orgLimitOverrideAuditActions.removed,
			actorUserId: adminId,
			resourceType: 'limit_override',
			resourceId: 'job_runs_per_day',
			details: {
				limitKey: 'job_runs_per_day',
				previous: next('unlimited'),
				next: null,
				reason: 'limit override test',
			},
		},
	])

	await expect(
		applyAdminOrgLimitOverrideChanges({
			db: env.APP_DB,
			audit: await adminAudit(),
			target: { orgId: org.stableUserId },
			changes: [{ key: 'job_runs_per_day', value: 10 }],
			reason: '   ',
			now,
		}),
	).rejects.toThrow('A reason is required.')
	await expect(
		setOverrides(org, [
			{
				key: 'job_runs_per_day',
				value: 10,
				expiresAt: new Date(now.getTime() - 1).toISOString(),
			},
		]),
	).rejects.toThrow('expiresAt must be in the future.')
})

test('a monthly override moves the $0 past-include stop; it does not touch the daily cap', async () => {
	const org = await seedOrg({
		label: 'override-monthly',
		stripePlan: 'pro',
		creditsEligible: true,
	})
	const month = now.toISOString().slice(0, 7)
	await env.APP_DB.prepare(
		`INSERT INTO usage_rollups (user_id, metric, month, event_count)
		 VALUES (?, 'dynamic_worker_day', ?, 351)`,
	)
		.bind(org.stableUserId, month)
		.run()
	const claim = () =>
		consumeExecuteUniqueWorkerDay({
			db: env.APP_DB,
			env,
			userId: ownerIdFromStored(org.stableUserId),
			email: org.email,
			workerId: `kody-${crypto.randomUUID()}`,
			now,
		})
	const stopped = await claim().then(
		() => null,
		(caught: unknown) => caught,
	)
	expect(isComputeOverageLimitError(stopped)).toBe(true)

	await setOverrides(org, [
		{ key: 'unique_worker_days_per_month', value: 1_000 },
	])
	await expect(claim()).resolves.toMatchObject({ created: true })
})

test('admin capabilities: non-admins are denied; admins set and read overrides by org handle', async () => {
	const org = await seedOrg({ label: 'override-capability' })
	await ensureOrgAuditTable()
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, stable_user_id
		) VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(
			'limits-admin',
			'limits-admin@example.com',
			'test-password-hash',
			now.toISOString(),
			adminId,
		)
		.run()
	const callerFor = (roles: Array<'admin' | 'user'>) =>
		createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored(adminId),
				email: 'limits-admin@example.com',
				displayName: 'Limits Admin',
				roles,
			},
		})
	for (const capability of [
		adminOrgLimitOverridesSetCapability,
		adminOrgLimitsGetCapability,
	]) {
		await expect(
			assertCallerCanAccessCapability(callerFor(['user']), capability),
		).rejects.toThrow('lacks required role "admin"')
		await assertCallerCanAccessCapability(callerFor(['admin']), capability)
	}

	const ctx = {
		env: { ...env, AUDIT_DB: env.APP_DB } as Env,
		callerContext: callerFor(['admin']),
	}
	const result = await adminOrgLimitOverridesSetCapability.handler(
		{
			org: `@${org.username}`,
			changes: [{ key: 'outbound_fetches_per_day', value: 1_000_000 }],
			reason: 'capability test',
		},
		ctx as never,
	)
	expect(result.changedKeys).toEqual(['outbound_fetches_per_day'])
	const read = await adminOrgLimitsGetCapability.handler(
		{ orgId: org.stableUserId },
		ctx as never,
	)
	expect(
		read.limits.find((row) => row.key === 'outbound_fetches_per_day'),
	).toMatchObject({ effectiveLimit: 1_000_000 })
	expect(await readAuditEvents(org.stableUserId)).toEqual([
		expect.objectContaining({
			action: orgLimitOverrideAuditActions.set,
			actorUserId: personIdFromStored(adminId),
		}),
	])
})
