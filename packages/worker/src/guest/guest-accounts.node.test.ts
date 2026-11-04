import { DatabaseSync } from 'node:sqlite'
import type { McpCallerContext } from '@kody-internal/shared/chat.ts'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	createGuestAccount,
	guestClaimCapabilityName,
	guestClaimFinishCapabilityName,
	guestCreateIpRateLimit,
	guestFullAccessMs,
	guestHoldMs,
	guestLimitOverrides,
	guestPhase,
	isGuestEmail,
	readGuestAccountByPerson,
} from './guest-accounts.ts'
import { guestErrorPayload } from './guest-errors.ts'
import {
	assertGuestCapabilityAllowed,
	guestBlockedReason,
} from './guest-policy.ts'
import {
	buildGuestResultBlock,
	formatGuestTimeLeft,
} from './guest-result-block.ts'

const deleteUserAccount = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('#app/account-deletion.ts', () => ({ deleteUserAccount }))

const baseUrl = 'https://kody.test'
const start = new Date('2026-11-04T07:00:00.000Z')

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

async function createGuest(db: D1Database, requestIp = '203.0.113.7') {
	const result = await createGuestAccount({
		db,
		requestIp,
		clientName: 'Test Agent',
		now: start,
	})
	if (!result.ok) throw new Error('guest was not created')
	return result
}

function guestCaller(personId: string, expiresAt: string) {
	return {
		baseUrl,
		user: { userId: personId, guestExpiresAt: expiresAt },
	} as unknown as McpCallerContext
}

test('Try it out creates the guest person, personal org, guest row, and limits in one write', async () => {
	const { sqlite, db } = createDb()
	const guest = await createGuest(db)
	expect(isGuestEmail(guest.email)).toBe(true)
	const user = sqlite
		.prepare(
			'SELECT personal_org_id, guest_expires_at FROM users WHERE stable_user_id = ?',
		)
		.get(guest.personId) as {
		personal_org_id: string
		guest_expires_at: string
	}
	expect(user.personal_org_id).toBe(guest.personalOrgId)
	expect(Date.parse(user.guest_expires_at) - start.getTime()).toBe(
		guestFullAccessMs,
	)
	const row = await readGuestAccountByPerson(db, guest.personId)
	expect(row?.claimCode).toBe(guest.claimCode)
	expect(Date.parse(row!.deleteAt) - start.getTime()).toBe(
		guestFullAccessMs + guestHoldMs,
	)
	const overrides = sqlite
		.prepare('SELECT limit_key FROM org_limit_overrides WHERE org_id = ?')
		.all(guest.personalOrgId) as Array<{ limit_key: string }>
	expect(overrides.map((override) => override.limit_key).sort()).toEqual(
		guestLimitOverrides.map(([key]) => key).sort(),
	)
})

test('guest creation is rate limited per IP', async () => {
	const { db } = createDb()
	for (let index = 0; index < guestCreateIpRateLimit.maxRequests; index++) {
		await createGuest(db)
	}
	const blocked = await createGuestAccount({
		db,
		requestIp: '203.0.113.7',
		clientName: null,
		now: start,
	})
	expect(blocked).toMatchObject({ ok: false, reason: 'rate_limited' })
	await createGuest(db, '198.51.100.9')
})

test('full access ends after 24 hours, then the account is read-only', () => {
	const expiresAt = new Date(start.getTime() + guestFullAccessMs).toISOString()
	expect(guestPhase(expiresAt, new Date(start.getTime() + 1000))).toBe('active')
	expect(guestPhase(expiresAt, new Date(Date.parse(expiresAt)))).toBe('hold')
})

test('guest result block shows time left and asks for a reminder with 2 hours left', async () => {
	const { db } = createDb()
	const guest = await createGuest(db)
	const callerContext = guestCaller(guest.personId, guest.expiresAt)
	const early = await buildGuestResultBlock({ db, callerContext, now: start })
	expect(early).toMatchObject({
		status: 'active',
		time_left: '24 hours',
		claim_url: `${baseUrl}/claim/${guest.claimCode}`,
		claim_capability: guestClaimCapabilityName,
		remind_now: false,
	})
	const late = await buildGuestResultBlock({
		db,
		callerContext,
		now: new Date(start.getTime() + 22 * 60 * 60 * 1000),
	})
	expect(late).toMatchObject({ status: 'active', remind_now: true })
	const held = await buildGuestResultBlock({
		db,
		callerContext,
		now: new Date(start.getTime() + guestFullAccessMs + 1),
	})
	expect(held).toMatchObject({ status: 'read_only', time_left: '0 minutes' })
	expect(formatGuestTimeLeft(90 * 60 * 1000)).toBe('1 hour 30 minutes')
})

test('guests are blocked from credentials, orgs, invites, and public packages', async () => {
	expect(guestBlockedReason('secretSet', {})).toBe('store credentials')
	expect(guestBlockedReason('orgCreate', {})).toBe(
		'create or join organizations',
	)
	expect(guestBlockedReason('inviteLinkCreate', {})).toBe('invite people')
	expect(
		guestBlockedReason('packageUpdate', { changes: { visibility: 'public' } }),
	).toBe('publish public or internet-visible packages')
	expect(
		guestBlockedReason('packageUpdate', { changes: { description: 'x' } }),
	).toBeNull()
	expect(guestBlockedReason('memoryUpsert', {})).toBeNull()

	const { db } = createDb()
	const guest = await createGuest(db)
	const error = await assertGuestCapabilityAllowed({
		db,
		callerContext: guestCaller(
			guest.personId,
			new Date(Date.now() + guestFullAccessMs).toISOString(),
		),
		capabilityName: 'secretSet',
		args: {},
	}).catch((caught: unknown) => caught)
	expect(error).toMatchObject({
		payload: {
			error: 'guest_not_allowed',
			claim_url: `${baseUrl}/claim/${guest.claimCode}`,
			claim_capability: guestClaimCapabilityName,
			claim_finish_capability: guestClaimFinishCapabilityName,
		},
	})
})

test('during the hold, writes return guest_claim_required while reads and claiming still work', async () => {
	const { db } = createDb()
	const guest = await createGuest(db)
	const callerContext = guestCaller(
		guest.personId,
		new Date(Date.now() - 1000).toISOString(),
	)
	await expect(
		assertGuestCapabilityAllowed({
			db,
			callerContext,
			capabilityName: 'memoryUpsert',
			args: {},
		}),
	).rejects.toMatchObject({ payload: { error: 'guest_claim_required' } })
	for (const capabilityName of [
		guestClaimCapabilityName,
		guestClaimFinishCapabilityName,
	]) {
		await assertGuestCapabilityAllowed({
			db,
			callerContext,
			capabilityName,
			args: {},
		})
	}
	await assertGuestCapabilityAllowed({
		db,
		callerContext,
		capabilityName: 'memorySearch',
		readOnly: true,
		args: {},
	})
})

test('guest error payloads say what is blocked and how to claim', () => {
	const payload = guestErrorPayload({
		code: 'guest_not_allowed',
		blocked: 'store credentials',
		claimUrl: `${baseUrl}/claim/abc`,
	})
	expect(payload.error_description).toContain(
		"Guest accounts can't store credentials.",
	)
	expect(payload.error_description).toContain(guestClaimCapabilityName)
	expect(payload.error_description).toContain(`${baseUrl}/claim/abc`)
	expect(payload.error_description).not.toMatch(/secret|\u2014/i)
})

test('the purge deletes guests only after the seven-day hold, through account deletion', async () => {
	const { pruneExpiredGuestAccounts } = await import('./guest-account-purge.ts')
	const { db } = createDb()
	const guest = await createGuest(db)
	const env = { APP_DB: db } as unknown as Env
	const duringHold = await pruneExpiredGuestAccounts({
		env,
		now: new Date(start.getTime() + guestFullAccessMs + guestHoldMs - 1000),
	})
	expect(duringHold.purged).toBe(0)
	expect(deleteUserAccount).not.toHaveBeenCalled()
	const afterHold = await pruneExpiredGuestAccounts({
		env,
		now: new Date(start.getTime() + guestFullAccessMs + guestHoldMs),
	})
	expect(afterHold.purged).toBe(1)
	expect(deleteUserAccount).toHaveBeenCalledWith(
		expect.objectContaining({ personUserId: guest.personId }),
	)
	expect(await readGuestAccountByPerson(db, guest.personId)).toBeNull()
})
