import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import type * as DeploymentEnv from '#app/deployment-env.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	createGuestAccount,
	readClaimedGuestOrgForSlug,
	readGuestAccountByPerson,
} from './guest-accounts.ts'
import { guestClaimDonePath } from './guest-claim.ts'
import { recordSystemEmailSends } from '#worker/email/system-email-sends.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	describeClaimCodeDelivery,
	finishGuestClaim,
	guestClaimCodeMaxAttempts,
	guestClaimStartRateLimit,
	startGuestClaim,
} from './guest-claim-code.ts'

const sendGatedTransactionalEmail = vi.hoisted(() =>
	vi.fn(
		async (): Promise<
			{ ok: true; messageId?: string | null } | { ok: false; error: string }
		> => ({ ok: true }),
	),
)
const runtime = vi.hoisted(() => ({ nonProduction: true }))
const maybeGrantSignupWelcomeCredits = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('#worker/email/transactional-send-policy.ts', () => ({
	sendGatedTransactionalEmail,
}))
vi.mock('#worker/billing/signup-welcome-credits.ts', () => ({
	maybeGrantSignupWelcomeCredits,
}))
vi.mock('#app/deployment-env.ts', async (importOriginal) => ({
	...(await importOriginal<typeof DeploymentEnv>()),
	isNonProductionRuntime: () => runtime.nonProduction,
}))

const requestUrl = 'https://kody.test/mcp'
const start = new Date('2026-11-04T07:00:00.000Z')

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const env = {
		APP_DB: db,
		SECRET_STORE_KEY: 'guest-test-secret-store-key-32-characters-ok',
	} as unknown as Env
	const created = await createGuestAccount({
		env,
		requestIp: '203.0.113.7',
		clientName: 'Test Agent',
		now: start,
	})
	if (!created.ok) throw new Error('guest was not created')
	const guest = await readGuestAccountByPerson(db, created.personId)
	if (!guest) throw new Error('guest row missing')
	return { sqlite, db, env, guest, created }
}

test('agent-led claim emails a code, then converts the guest in place keeping the same person', async () => {
	const { sqlite, env, guest, created } = await setup()
	const started = await startGuestClaim({
		env,
		guest,
		email: 'Claimer@Example.test',
		username: 'claimer',
		requestUrl,
		now: start,
	})
	expect(started).toMatchObject({ email: 'claimer@example.test', mode: 'new' })
	expect(sendGatedTransactionalEmail).toHaveBeenCalledWith(
		expect.objectContaining({
			kind: 'guest_claim_code',
			message: expect.objectContaining({ to: 'claimer@example.test' }),
		}),
	)
	const result = await finishGuestClaim({
		env,
		guest,
		code: started.devCode!,
		baseUrl: 'https://kody.test',
		now: start,
	})
	expect(result).toMatchObject({
		mode: 'new',
		username: 'claimer',
		personId: created.personId,
		personalOrgId: created.personalOrgId,
	})
	const user = sqlite
		.prepare(
			'SELECT username, email, guest_expires_at FROM users WHERE stable_user_id = ?',
		)
		.get(created.personId)
	expect(user).toEqual({
		username: 'claimer',
		email: 'claimer@example.test',
		guest_expires_at: null,
	})
	expect(maybeGrantSignupWelcomeCredits).toHaveBeenCalledWith(
		expect.objectContaining({ userId: created.personalOrgId }),
	)
	const overrides = sqlite
		.prepare('SELECT COUNT(*) AS n FROM org_limit_overrides WHERE org_id = ?')
		.get(created.personalOrgId) as { n: number }
	expect(overrides.n).toBe(0)
	const claimed = await readGuestAccountByPerson(env.APP_DB, created.personId)
	expect(claimed?.claimedAt).toBeTruthy()
	const { guest_slug: guestSlug } = sqlite
		.prepare('SELECT guest_slug FROM guest_accounts WHERE person_id = ?')
		.get(created.personId) as { guest_slug: string }
	expect(guestSlug).toMatch(/^guest-/)
	expect(
		await readClaimedGuestOrgForSlug(env.APP_DB, {
			slug: guestSlug,
			personId: created.personId,
		}),
	).toBe(created.personalOrgId)
	expect(
		await readClaimedGuestOrgForSlug(env.APP_DB, {
			slug: guestSlug,
			personId: 'someone-else',
		}),
	).toBeNull()
})

test('claim codes stop working after too many wrong tries or once expired', async () => {
	const { env, guest } = await setup()
	await startGuestClaim({
		env,
		guest,
		email: 'person@example.test',
		username: 'person',
		requestUrl,
		now: start,
	})
	for (let attempt = 0; attempt < guestClaimCodeMaxAttempts; attempt++) {
		await expect(
			finishGuestClaim({
				env,
				guest,
				code: '000000x',
				baseUrl: 'https://kody.test',
				now: start,
			}),
		).rejects.toMatchObject({ code: 'code_invalid' })
	}
	await expect(
		finishGuestClaim({
			env,
			guest,
			code: '000000',
			baseUrl: 'https://kody.test',
			now: start,
		}),
	).rejects.toMatchObject({ code: 'too_many_attempts' })

	const restarted = await startGuestClaim({
		env,
		guest,
		email: 'person@example.test',
		username: 'person',
		requestUrl,
		now: start,
	})
	await expect(
		finishGuestClaim({
			env,
			guest,
			code: restarted.devCode!,
			baseUrl: 'https://kody.test',
			now: new Date(start.getTime() + 16 * 60 * 1000),
		}),
	).rejects.toMatchObject({ code: 'code_expired' })
})

test('a merge request needs an existing account for that email', async () => {
	const { env, guest } = await setup()
	await expect(
		startGuestClaim({
			env,
			guest,
			email: 'nobody@example.test',
			merge: true,
			requestUrl,
			now: start,
		}),
	).rejects.toMatchObject({ code: 'no_account' })
})

test('the claimed confirmation link leaves out empty categories', () => {
	expect(
		guestClaimDonePath('abc', 'merge', {
			packages: 2,
			memories: 0,
			jobs: 1,
			runs: 0,
		}),
	).toBe('/claim/abc?result=claimed&mode=merge&packages=2&jobs=1')
	expect(
		guestClaimDonePath('abc', 'new', {
			packages: 0,
			memories: 0,
			jobs: 0,
			runs: 0,
		}),
	).toBe('/claim/abc?result=claimed&mode=new')
})

test('a guest can only ask for a few fresh claim codes per hour', async () => {
	const { env, guest } = await setup()
	for (
		let started = 0;
		started < guestClaimStartRateLimit.maxRequests;
		started++
	) {
		await startGuestClaim({
			env,
			guest,
			email: 'person@example.test',
			username: 'person',
			requestUrl,
			now: start,
		})
	}
	await expect(
		startGuestClaim({
			env,
			guest,
			email: 'person@example.test',
			username: 'person',
			requestUrl,
			now: start,
		}),
	).rejects.toMatchObject({ code: 'rate_limited' })
})

test('production claim starts return the provider message id and log the send outcome', async () => {
	const { env, guest } = await setup()
	runtime.nonProduction = false
	try {
		sendGatedTransactionalEmail.mockResolvedValueOnce({
			ok: true,
			messageId: '<claim-1@kody.test>',
		})
		const started = await startGuestClaim({
			env,
			guest,
			email: 'person@example.test',
			username: 'person',
			requestUrl,
			now: start,
		})
		expect(started).toMatchObject({
			devCode: null,
			providerMessageId: '<claim-1@kody.test>',
			codeDelivery: 'accepted',
		})
		expect(logAuditEventSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				action: 'guest_claim_code_sent',
				result: 'success',
				reason: 'mode=new;message_id=<claim-1@kody.test>',
			}),
		)

		consoleWarn.mockImplementation(() => {})
		sendGatedTransactionalEmail.mockRejectedValueOnce(new Error('boom'))
		await expect(
			startGuestClaim({
				env,
				guest,
				email: 'person@example.test',
				username: 'person',
				requestUrl,
				now: start,
			}),
		).rejects.toMatchObject({ code: 'send_failed' })
		expect(logAuditEventSpy).toHaveBeenLastCalledWith(
			expect.objectContaining({
				action: 'guest_claim_code_sent',
				result: 'failure',
				reason: 'mode=new;error=provider_error',
			}),
		)
		expect(consoleWarn).toHaveBeenCalledWith('guest-claim-code-send-threw', {
			error: 'boom',
		})
	} finally {
		runtime.nonProduction = true
	}
})

test('wrong claim codes report what the mail provider said about the code email', async () => {
	const { env, guest } = await setup()
	await startGuestClaim({
		env,
		guest,
		email: 'person@example.test',
		username: 'person',
		requestUrl,
		now: start,
	})
	await expect(
		finishGuestClaim({
			env,
			guest,
			code: '000000x',
			baseUrl: 'https://kody.test',
			now: start,
		}),
	).rejects.toMatchObject({
		code: 'code_invalid',
		deliveryNote: describeClaimCodeDelivery(null),
	})
	await recordSystemEmailSends({
		db: env.APP_DB,
		providerMessageId: '<claim-2@kody.test>',
		recipients: ['person@example.test'],
		sender: 'kody@kody.test',
		kind: 'guest_claim_code',
		now: start,
	})
	await expect(
		finishGuestClaim({
			env,
			guest,
			code: '000001x',
			baseUrl: 'https://kody.test',
			now: start,
		}),
	).rejects.toMatchObject({
		deliveryNote: expect.stringContaining(
			'accepted the code email (message <claim-2@kody.test>) but has not confirmed delivery yet',
		),
	})
})

test('claim code delivery notes follow the latest delivery report', () => {
	const send = {
		providerMessageId: '<m@kody.test>',
		recipient: 'person@example.test',
		sender: 'kody@kody.test',
		kind: 'guest_claim_code',
		sentAt: start.toISOString(),
		deliveryStatusAt: start.toISOString(),
		hardBouncedAt: null,
	}
	expect(
		describeClaimCodeDelivery({ ...send, deliveryStatus: 'delivered' }),
	).toContain('was delivered to the recipient')
	expect(
		describeClaimCodeDelivery({ ...send, deliveryStatus: 'deferred' }),
	).toContain('is delayed')
	expect(
		describeClaimCodeDelivery({ ...send, deliveryStatus: 'bounced' }),
	).toContain('was not delivered (bounced)')
})
