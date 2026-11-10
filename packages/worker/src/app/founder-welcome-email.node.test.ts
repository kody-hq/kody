import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import type * as cloudflareEmail from '#app/email/cloudflare-email.ts'

const sendCloudflareEmail = vi.fn<typeof cloudflareEmail.sendCloudflareEmail>(
	async () => ({ ok: true }),
)

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (
		...args: Parameters<typeof cloudflareEmail.sendCloudflareEmail>
	) => sendCloudflareEmail(...args),
}))

const { sendFounderWelcomeEmail } =
	await import('#app/founder-welcome-email.ts')

function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const insert = sqlite.prepare(
		`INSERT INTO users (username, email, password_hash, stable_user_id, email_verified_at, guest_expires_at)
		 VALUES (?, ?, 'x', ?, ?, ?)`,
	)
	insert.run(
		'ada',
		'ada@example.com',
		'user-ada',
		'2026-11-09T00:00:00.000Z',
		null,
	)
	insert.run('bea', 'bea@example.com', 'user-unverified', null, null)
	insert.run(
		'guest-1',
		'guest@example.com',
		'user-guest',
		'2026-11-09T00:00:00.000Z',
		'2026-12-01T00:00:00.000Z',
	)
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		APP_BASE_URL: 'https://kody.codes',
		SYSTEM_EMAIL_DOMAIN: 'kody.codes',
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token',
	} as unknown as Env
	const sentAt = (stableUserId: string) =>
		(
			sqlite
				.prepare(
					'SELECT founder_welcome_sent_at AS at FROM users WHERE stable_user_id = ?',
				)
				.get(stableUserId) as { at: string | null }
		).at
	return { sqlite, env, sentAt }
}

function welcome(env: Env, stableUserId: string, email = 'ada@example.com') {
	return sendFounderWelcomeEmail({ env, email, stableUserId })
}

test('the founder welcome sends once per verified user from Kent with Reply-To kent@ and no tips unsubscribe', async () => {
	sendCloudflareEmail.mockClear()
	const { env, sentAt } = setup()
	expect(await welcome(env, 'user-ada')).toBe(true)
	expect(await welcome(env, 'user-ada')).toBe(false)
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
	const payload = sendCloudflareEmail.mock.calls[0]?.[1]
	expect(payload).toMatchObject({
		to: 'ada@example.com',
		from: 'kody@kody.codes',
		fromName: 'Kent C. Dodds (Kody)',
		replyTo: 'kent@kody.codes',
		subject: 'Thanks for trying Kody',
	})
	expect(payload?.headers?.['List-Unsubscribe']).toBeUndefined()
	expect(payload?.html).toContain(
		'src="https://kody.codes/images/email/kent-c-dodds.png" width="48" height="48"',
	)
	expect(payload?.html).toContain('https://kody.codes/onboarding')
	expect(payload?.html).not.toContain('/unsubscribe/tips')
	expect(payload?.text).toContain(
		'Replying to this email goes straight to me, the founder.',
	)
	expect(payload?.text).toContain('I read every reply')
	expect(payload?.text).toContain('Kent C. Dodds\nFounder of Kody')
	for (const part of [payload?.subject, payload?.html, payload?.text]) {
		expect(part).not.toMatch(/[\u2013\u2014]/)
	}
	expect(sentAt('user-ada')).toBeTruthy()
})

test('the founder welcome skips unverified and still-guest accounts', async () => {
	sendCloudflareEmail.mockClear()
	const { env, sentAt } = setup()
	expect(await welcome(env, 'user-unverified', 'bea@example.com')).toBe(false)
	expect(await welcome(env, 'user-guest', 'guest@example.com')).toBe(false)
	expect(await welcome(env, 'user-missing')).toBe(false)
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
	expect(sentAt('user-unverified')).toBeNull()
})

test('a failed founder welcome send releases the durable claim so the next attempt can send', async () => {
	sendCloudflareEmail.mockClear()
	consoleWarn.mockImplementation(() => {})
	const { env, sentAt } = setup()
	sendCloudflareEmail.mockImplementationOnce(async () => {
		throw new Error('provider down')
	})
	expect(await welcome(env, 'user-ada')).toBe(false)
	expect(sentAt('user-ada')).toBeNull()
	expect(consoleWarn).toHaveBeenCalledWith(
		'founder-welcome-email-send-failed',
		{
			error: expect.any(Error),
		},
	)
	expect(await welcome(env, 'user-ada')).toBe(true)
	expect(sentAt('user-ada')).toBeTruthy()
})

test('existing users are not backfilled: the migration leaves every row unclaimed and nothing sends without a new verification', () => {
	const { sqlite } = setup()
	const { claimed } = sqlite
		.prepare(
			'SELECT COUNT(*) AS claimed FROM users WHERE founder_welcome_sent_at IS NOT NULL',
		)
		.get() as { claimed: number }
	expect(claimed).toBe(0)
	expect(sendCloudflareEmail).not.toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ to: 'bea@example.com' }),
	)
})
