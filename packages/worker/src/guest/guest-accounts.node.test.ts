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
	guestClaimCodeHash,
	readGuestAccountByClaimCode,
	readGuestAccountByPerson,
	readGuestClaimCode,
	sealPlaintextGuestClaimCodes,
} from './guest-accounts.ts'
import { guestErrorPayload } from './guest-errors.ts'
import {
	assertGuestCapabilityAllowed,
	guestBlockedReason,
} from './guest-policy.ts'
import {
	buildGuestResultBlock,
	formatGuestResultText,
	formatGuestTimeLeft,
} from './guest-result-block.ts'

const deleteUserAccount = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('#app/account-deletion.ts', () => ({ deleteUserAccount }))
const scheduleUserDeletedEvent = vi.hoisted(() => vi.fn())
vi.mock('#worker/identity/schedule-user-lifecycle-event.ts', () => ({
	scheduleUserDeletedEvent,
}))

const baseUrl = 'https://kody.test'
const start = new Date('2026-11-04T07:00:00.000Z')

const secretStoreKey = 'guest-test-secret-store-key-32-characters-ok'

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	return { sqlite, db, env: guestEnv(db) }
}

function guestEnv(db: D1Database) {
	return { APP_DB: db, SECRET_STORE_KEY: secretStoreKey }
}

async function createGuest(db: D1Database, requestIp = '203.0.113.7') {
	const result = await createGuestAccount({
		env: guestEnv(db),
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
	expect(await readGuestClaimCode(guestEnv(db), row!)).toBe(guest.claimCode)
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
		env: guestEnv(db),
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
	const early = await buildGuestResultBlock({
		env: guestEnv(db),
		callerContext,
		now: start,
	})
	expect(early).toMatchObject({
		status: 'active',
		time_left: '24 hours',
		claim_url: `${baseUrl}/claim/${guest.claimCode}`,
		claim_capability: guestClaimCapabilityName,
		remind_now: false,
	})
	const late = await buildGuestResultBlock({
		env: guestEnv(db),
		callerContext,
		now: new Date(start.getTime() + 22 * 60 * 60 * 1000),
	})
	expect(late).toMatchObject({ status: 'active', remind_now: true })
	const held = await buildGuestResultBlock({
		env: guestEnv(db),
		callerContext,
		now: new Date(start.getTime() + guestFullAccessMs + 1),
	})
	expect(held).toMatchObject({ status: 'read_only', time_left: '0 minutes' })
	expect(formatGuestResultText(early!)).toContain(
		`full access for 24 hours more`,
	)
	expect(formatGuestResultText(held!)).toContain(
		'read-only until claimed. It is deleted at',
	)
	expect(formatGuestResultText(held!)).toContain(
		`Claim link: ${baseUrl}/claim/${guest.claimCode}`,
	)
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
		env: guestEnv(db),
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
			env: guestEnv(db),
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
			env: guestEnv(db),
			callerContext,
			capabilityName,
			args: {},
		})
	}
	await assertGuestCapabilityAllowed({
		env: guestEnv(db),
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
	expect(scheduleUserDeletedEvent).not.toHaveBeenCalled()
	const afterHold = await pruneExpiredGuestAccounts({
		env,
		now: new Date(start.getTime() + guestFullAccessMs + guestHoldMs),
	})
	expect(afterHold.purged).toBe(1)
	expect(deleteUserAccount).toHaveBeenCalledWith(
		expect.objectContaining({ personUserId: guest.personId }),
	)
	expect(await readGuestAccountByPerson(db, guest.personId)).toBeNull()
	expect(scheduleUserDeletedEvent).toHaveBeenCalledOnce()
	expect(scheduleUserDeletedEvent).toHaveBeenCalledWith({
		env,
		user: {
			id: guest.personId,
			username: guest.username,
			email: guest.email,
		},
		createdAt: start.toISOString(),
	})
})

test('claim codes are stored only as a lookup hash plus a person-bound sealed copy', async () => {
	const { sqlite, db, env } = createDb()
	const guest = await createGuest(db)
	const row = sqlite
		.prepare(
			'SELECT claim_code, claim_code_encrypted FROM guest_accounts WHERE person_id = ?',
		)
		.get(guest.personId) as {
		claim_code: string
		claim_code_encrypted: string
	}
	expect(row.claim_code).toBe(await guestClaimCodeHash(guest.claimCode))
	expect(row.claim_code_encrypted).toMatch(/^v2\./)
	expect(JSON.stringify(row)).not.toContain(guest.claimCode)
	expect(
		(await readGuestAccountByClaimCode(env, guest.claimCode))?.personId,
	).toBe(guest.personId)
	expect(
		await readGuestAccountByClaimCode(
			env,
			guest.claimCode.replace(/.$/, (last) => (last === 'x' ? 'y' : 'x')),
		),
	).toBeNull()

	// A sealed copy moved onto another guest row does not open there.
	const other = await createGuest(db, '198.51.100.4')
	sqlite
		.prepare(
			'UPDATE guest_accounts SET claim_code_encrypted = ? WHERE person_id = ?',
		)
		.run(row.claim_code_encrypted, other.personId)
	const swapped = await readGuestAccountByPerson(db, other.personId)
	expect(await readGuestClaimCode(env, swapped!)).toBeNull()
})

test('outstanding plaintext claim links keep working and are migrated', async () => {
	const { sqlite, db, env } = createDb()
	const first = await createGuest(db)
	const second = await createGuest(db, '198.51.100.4')
	const legacyCode = (personId: string, code: string) =>
		sqlite
			.prepare(
				'UPDATE guest_accounts SET claim_code = ?, claim_code_encrypted = NULL WHERE person_id = ?',
			)
			.run(code, personId)
	legacyCode(first.personId, first.claimCode)
	legacyCode(second.personId, second.claimCode)

	// Opening a legacy link converts that row in place.
	expect(
		(await readGuestAccountByClaimCode(env, first.claimCode))?.personId,
	).toBe(first.personId)
	const converted = sqlite
		.prepare('SELECT claim_code FROM guest_accounts WHERE person_id = ?')
		.get(first.personId) as { claim_code: string }
	expect(converted.claim_code).toBe(await guestClaimCodeHash(first.claimCode))

	// A legacy row still shows its own claim link before the backfill.
	const legacyRow = await readGuestAccountByPerson(db, second.personId)
	expect(await readGuestClaimCode(env, legacyRow!)).toBe(second.claimCode)

	expect(
		await sealPlaintextGuestClaimCodes({ env, dryRun: true, limit: 10 }),
	).toMatchObject({ scanned: 1, sealed: 0, remainingPlaintext: 1 })
	expect(
		await sealPlaintextGuestClaimCodes({ env, dryRun: false, limit: 10 }),
	).toMatchObject({ scanned: 1, sealed: 1, remainingPlaintext: 0 })
	expect(
		await sealPlaintextGuestClaimCodes({ env, dryRun: false, limit: 10 }),
	).toMatchObject({ scanned: 0, sealed: 0, remainingPlaintext: 0 })
	// A claimed guest keeps only its lookup hash and is not plaintext.
	sqlite
		.prepare(
			"UPDATE guest_accounts SET claimed_at = '2026-01-01T00:00:00Z', claim_code_encrypted = NULL WHERE person_id = ?",
		)
		.run(first.personId)
	expect(
		await sealPlaintextGuestClaimCodes({ env, dryRun: true, limit: 10 }),
	).toMatchObject({ scanned: 0, remainingPlaintext: 0 })
	expect(
		(await readGuestAccountByClaimCode(env, second.claimCode))?.personId,
	).toBe(second.personId)
	const plaintext = sqlite
		.prepare(
			'SELECT COUNT(*) AS count FROM guest_accounts WHERE claim_code IN (?, ?)',
		)
		.get(first.claimCode, second.claimCode) as { count: number }
	expect(plaintext.count).toBe(0)
})
