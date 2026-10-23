import { env, runInDurableObject } from 'cloudflare:test'
import { type UserMeter } from '#worker/entitlements/user-meter-do.ts'
import { userMeterDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { applyAdminOrgLimitOverrideChanges } from '#worker/admin/org-limit-overrides.ts'
import { ensureCreditWalletTestSchema } from '#worker/billing/test-schema.ts'
import {
	ExecuteRateLimitedError,
	admitHostedExecuteCall,
} from '#mcp/execute-admission.ts'
import { getCachedUserEntitlement } from '#worker/entitlements/service.ts'
import { type OrgAuditWriter } from '#worker/orgs/org-audit.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { resolveEntitlementLimit } from '#universal/plans.ts'

const now = new Date('2026-10-10T12:00:00.000Z')

type SeededOrg = { email: string; stableUserId: string }

async function seedOrg(input: {
	label: string
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
		plan: 'free',
		stripeCustomerId: null,
		stripePlan: input.stripePlan ?? null,
		stripeCreditsEligible: input.creditsEligible ? 1 : 0,
		createdAt: now.toISOString(),
	})
	return { email, stableUserId }
}

async function addSeat(org: SeededOrg) {
	const member = await seedOrg({ label: 'rate-brake-seat' })
	await env.APP_DB.prepare(
		`INSERT INTO org_memberships (org_id, user_id, role, created_at)
		 VALUES (?, ?, 'member', ?)`,
	)
		.bind(org.stableUserId, member.stableUserId, now.toISOString())
		.run()
	return member.stableUserId
}

function removeSeat(org: SeededOrg, memberId: string) {
	return env.APP_DB.prepare(
		`UPDATE org_memberships SET deleted_at = ? WHERE org_id = ? AND user_id = ?`,
	)
		.bind(now.toISOString(), org.stableUserId, memberId)
		.run()
}

async function seedThreeSeatPro(label: string) {
	const org = await seedOrg({
		label,
		stripePlan: 'pro',
		creditsEligible: true,
	})
	const members = [await addSeat(org), await addSeat(org)]
	return { org, members }
}

async function admit(org: SeededOrg) {
	await admitHostedExecuteCall({
		env,
		ownerId: ownerIdFromStored(org.stableUserId),
		email: org.email,
		now,
	})
}

async function fillBrake(org: SeededOrg, count: number) {
	const stub = env.USER_METER.get(
		env.USER_METER.idFromName(
			userMeterDurableObjectName(ownerIdFromStored(org.stableUserId)),
		),
	)
	await runInDurableObject(stub, async (instance: UserMeter) => {
		for (let index = 0; index < count - 1; index += 1) {
			const result = await instance.admitExecuteCall({
				nowMs: now.getTime(),
				limitPerMinute: count,
			})
			expect(result.admitted).toBe(true)
		}
	})
	await admit(org)
}

const adminId = testStableUserIdFromEmail('rate-brake-admin@example.com')

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

async function adminAudit(): Promise<OrgAuditWriter> {
	await ensureOrgAuditTable()
	return {
		appDb: env.APP_DB,
		db: env.APP_DB,
		actorUserId: adminId,
		actorUsername: 'rate-brake-admin',
		credentialKind: null,
		credentialId: null,
	}
}

test('a free multi-seat org scales the runaway brake from getUserEntitlement', async () => {
	const org = await seedOrg({ label: 'rate-brake-free-seats' })
	await addSeat(org)
	await addSeat(org)
	const entitlement = await getCachedUserEntitlement(env.APP_DB, {
		userId: org.stableUserId,
		email: org.email,
	})
	expect(entitlement).toMatchObject({
		plan: 'free',
		creditWallet: 'none',
		seats: 3,
	})
	expect(
		resolveEntitlementLimit(entitlement, 'execute_calls_per_minute', now),
	).toBe(900)
})

test('a 3-seat Pro org admits 900 execute calls per minute and refuses the 901st', async () => {
	const { org } = await seedThreeSeatPro('rate-brake-three-seat')
	const entitlement = await getCachedUserEntitlement(env.APP_DB, {
		userId: org.stableUserId,
		email: org.email,
	})
	expect(entitlement.seats).toBe(3)
	expect(
		resolveEntitlementLimit(entitlement, 'execute_calls_per_minute', now),
	).toBe(900)

	await fillBrake(org, 900)
	await expect(admit(org)).rejects.toBeInstanceOf(ExecuteRateLimitedError)
	await expect(admit(org)).rejects.toMatchObject({
		code: 'execute_rate_limited',
		message: expect.stringContaining('started 900 execute calls'),
	})
}, 120_000)

test('removing a seat shrinks the execute runaway brake on the next check', async () => {
	const { org, members } = await seedThreeSeatPro('rate-brake-shrink')
	await fillBrake(org, 600)
	expect(
		(
			await getCachedUserEntitlement(env.APP_DB, {
				userId: org.stableUserId,
				email: org.email,
			})
		).seats,
	).toBe(3)

	await removeSeat(org, members[0]!)
	// 2 seats → 600/min; already used 600 this minute, so the next call denies.
	await expect(admit(org)).rejects.toBeInstanceOf(ExecuteRateLimitedError)
}, 120_000)

test('an admin override raises the execute runaway brake above seats × 300', async () => {
	const { org } = await seedThreeSeatPro('rate-brake-override')
	await applyAdminOrgLimitOverrideChanges({
		db: env.APP_DB,
		target: { orgId: org.stableUserId },
		changes: [{ key: 'execute_calls_per_minute', value: 1_200 }],
		reason: 'rate brake override test',
		audit: await adminAudit(),
		now,
	})
	const entitlement = await getCachedUserEntitlement(env.APP_DB, {
		userId: org.stableUserId,
		email: org.email,
	})
	expect(
		resolveEntitlementLimit(
			{
				...entitlement,
				seats: 3,
				limitOverrides: entitlement.limitOverrides,
			},
			'execute_calls_per_minute',
			now,
		),
	).toBe(1_200)

	await fillBrake(org, 1_200)
	await expect(admit(org)).rejects.toBeInstanceOf(ExecuteRateLimitedError)
}, 120_000)
