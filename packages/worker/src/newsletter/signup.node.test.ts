import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import {
	listWhatsNewRecipients,
	setWhatsNewOptIn,
} from '#worker/admin/whats-new.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

const mocks = vi.hoisted(() => ({ sendNewsletterConfirmationEmail: vi.fn() }))
vi.mock('#worker/email/system-outbound.ts', () => ({
	sendNewsletterConfirmationEmail: mocks.sendNewsletterConfirmationEmail,
}))

const {
	buildNewsletterConfirmEmail,
	confirmNewsletterSignup,
	newsletterConfirmTokenExpiryMs,
	newsletterSignupEmailRateLimit,
	newsletterSignupIpRateLimit,
	requestNewsletterSignup,
} = await import('./signup.ts')

const now = new Date('2026-11-15T12:00:00.000Z')

function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const env = {
		APP_DB: db,
		APP_BASE_URL: 'https://kody.example.com',
		SYSTEM_EMAIL_DOMAIN: 'kody.example.com',
	} as unknown as Env
	let ipCounter = 0
	function request(ip = `203.0.113.${++ipCounter}`) {
		return new Request('https://kody.example.com/newsletter', {
			method: 'POST',
			headers: { 'CF-Connecting-IP': ip },
		})
	}
	function signup(
		email: unknown,
		extra: Record<string, unknown> = {},
		ip?: string,
	) {
		return requestNewsletterSignup({
			env,
			request: request(ip),
			form: { email, ...extra },
			now,
		})
	}
	function sentToken(call = -1) {
		const input = mocks.sendNewsletterConfirmationEmail.mock.calls.at(call)![0]
		const match = /\/newsletter\/confirm\?token=([a-f0-9]{64})/.exec(input.text)
		return match![1]!
	}
	function confirm(token: string | null, at = now) {
		return confirmNewsletterSignup({ env, request: request(), token, now: at })
	}
	function user(email: string, optIn = 0, updatedAt: string | null = null) {
		const id = 'a'.repeat(64)
		sqlite
			.prepare(
				`INSERT INTO users (stable_user_id, personal_org_id, username, email, password_hash, email_verified_at, whats_new_email_opt_in, whats_new_email_opt_in_updated_at) VALUES (?, 'org-1', 'reader', ?, 'hash', '2026-11-14', ?, ?)`,
			)
			.run(id, email, optIn, updatedAt)
		return id
	}
	const recipients = (audience: 'opted-in' | 'all-users' = 'opted-in') =>
		listWhatsNewRecipients({ db, audience, limit: 100 })
	const rows = () =>
		sqlite.prepare('SELECT * FROM newsletter_signups').all() as Array<
			Record<string, unknown>
		>
	return { sqlite, db, signup, sentToken, confirm, user, recipients, rows }
}

test('a sign-up only emails a confirmation link; the address joins the list when the link is confirmed, once', async () => {
	const { signup, sentToken, confirm, recipients, rows, db } = setup()
	expect(await signup('  New.Reader@Example.com ')).toEqual({ ok: true })
	expect(mocks.sendNewsletterConfirmationEmail).toHaveBeenCalledTimes(1)
	expect(mocks.sendNewsletterConfirmationEmail.mock.calls[0]![0]).toMatchObject(
		{
			to: 'new.reader@example.com',
			subject: "Confirm your What's New in Kody subscription",
		},
	)
	const token = sentToken()
	// Only a hash of the token is stored, and nobody is a recipient yet.
	expect(rows()).toEqual([
		expect.objectContaining({
			email: 'new.reader@example.com',
			status: 'pending',
			confirmed_at: null,
			token_expires_at: now.getTime() + newsletterConfirmTokenExpiryMs,
		}),
	])
	expect(JSON.stringify(rows())).not.toContain(token)
	expect((await recipients('all-users')).users).toEqual([])

	expect(await confirm(token)).toEqual({ ok: true })
	const stableId = rows()[0]!.stable_id as string
	expect(stableId).toMatch(/^[a-f0-9]{64}$/)
	expect((await recipients()).users).toEqual([
		{
			stable_user_id: stableId,
			email: 'new.reader@example.com',
			username: '',
			opted_in: true,
			opt_in_updated_at: now.toISOString(),
			opt_in_source: 'newsletter_page',
			unsubscribed: false,
		},
	])
	// The link is single use.
	expect(await confirm(token)).toEqual({ ok: false, error: 'invalid_link' })

	// Unsubscribing through the admin capability removes the address from
	// the opted-in audience and keeps the stable id.
	await setWhatsNewOptIn({
		db,
		stable_user_id: stableId,
		opted_in: false,
		source: 'email_link',
	})
	expect((await recipients()).users).toEqual([])
	expect((await recipients('all-users')).users).toEqual([
		expect.objectContaining({
			stable_user_id: stableId,
			opted_in: false,
			opt_in_source: 'email_link',
			unsubscribed: true,
		}),
	])
	// Signing up again needs a fresh confirmation and keeps the same id.
	await signup('new.reader@example.com')
	expect((await recipients()).users).toEqual([])
	expect(await confirm(sentToken())).toEqual({ ok: true })
	expect((await recipients()).users[0]).toMatchObject({
		stable_user_id: stableId,
		opt_in_source: 'newsletter_page',
	})
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'newsletter_signup_confirm',
			result: 'success',
		}),
	)
})

test('a pending sign-up cannot be switched on without its link', async () => {
	const { signup, rows, db, recipients } = setup()
	await signup('pending@example.com')
	await expect(
		setWhatsNewOptIn({
			db,
			stable_user_id: rows()[0]!.stable_id as string,
			opted_in: true,
			source: 'admin',
		}),
	).rejects.toThrow('User not found.')
	expect((await recipients('all-users')).users).toEqual([])
})

test('expired, malformed, and missing tokens confirm nothing; a newer link replaces the older one', async () => {
	const { signup, sentToken, confirm, recipients } = setup()
	await signup('late@example.com')
	const first = sentToken()
	for (const token of [null, '', 'nope', 'A'.repeat(64), 'b'.repeat(64)])
		expect(await confirm(token)).toEqual({ ok: false, error: 'invalid_link' })
	expect(
		await confirm(
			first,
			new Date(now.getTime() + newsletterConfirmTokenExpiryMs),
		),
	).toEqual({ ok: false, error: 'invalid_link' })
	await signup('late@example.com')
	const second = sentToken()
	expect(second).not.toBe(first)
	expect(await confirm(first)).toEqual({ ok: false, error: 'invalid_link' })
	expect((await recipients('all-users')).users).toEqual([])
	expect(await confirm(second)).toEqual({ ok: true })
	expect((await recipients()).users).toHaveLength(1)
})

test('invalid addresses are rejected without an email', async () => {
	const { signup, rows } = setup()
	for (const email of [
		undefined,
		'',
		'nope',
		'a@b',
		'two@@example.com',
		'a b@example.com',
		"o'connor@example.com",
		`${'x'.repeat(250)}@example.com`,
	])
		expect(await signup(email)).toEqual({ ok: false, error: 'invalid_email' })
	expect(mocks.sendNewsletterConfirmationEmail).not.toHaveBeenCalled()
	expect(rows()).toEqual([])
})

test('a filled honeypot gets the normal success result and no email or row', async () => {
	const { signup, rows } = setup()
	expect(await signup('bot@example.com', { kody_hp: 'https://spam' })).toEqual({
		ok: true,
	})
	expect(mocks.sendNewsletterConfirmationEmail).not.toHaveBeenCalled()
	expect(rows()).toEqual([])
})

test('rate limits: per IP is reported, per address is silent', async () => {
	const { signup } = setup()
	for (let i = 0; i < newsletterSignupIpRateLimit.maxRequests; i++)
		expect(await signup(`ip${i}@example.com`, {}, '198.51.100.7')).toEqual({
			ok: true,
		})
	expect(await signup('ip-over@example.com', {}, '198.51.100.7')).toEqual({
		ok: false,
		error: 'rate_limited',
	})
	mocks.sendNewsletterConfirmationEmail.mockClear()
	for (let i = 0; i < newsletterSignupEmailRateLimit.maxRequests + 2; i++)
		expect(await signup('flood@example.com')).toEqual({ ok: true })
	expect(mocks.sendNewsletterConfirmationEmail).toHaveBeenCalledTimes(
		newsletterSignupEmailRateLimit.maxRequests,
	)
})

test('already subscribed addresses and failed sends look like any other sign-up', async () => {
	const { signup, sentToken, confirm, user, recipients } = setup()
	await signup('again@example.com')
	await confirm(sentToken())
	user('member@example.com', 1, '2026-11-14')
	mocks.sendNewsletterConfirmationEmail.mockClear()
	expect(await signup('again@example.com')).toEqual({ ok: true })
	expect(await signup('member@example.com')).toEqual({ ok: true })
	expect(mocks.sendNewsletterConfirmationEmail).not.toHaveBeenCalled()

	consoleWarn.mockImplementation(() => {})
	mocks.sendNewsletterConfirmationEmail.mockRejectedValueOnce(
		new Error('rejected fail@example.com'),
	)
	expect(await signup('fail@example.com')).toEqual({ ok: true })
	expect(consoleWarn).toHaveBeenCalledWith(
		'newsletter-signup-confirm-email-failed',
		'rejected [email]',
	)
	expect((await recipients()).users.map((row) => row.email).sort()).toEqual([
		'again@example.com',
		'member@example.com',
	])
})

test('confirming an address with a verified account sets consent on the account and lists it once', async () => {
	const { signup, sentToken, confirm, user, recipients, sqlite } = setup()
	const id = user('member@example.com', 0, '2026-11-01')
	expect((await recipients()).users).toEqual([])
	await signup('member@example.com')
	expect((await recipients()).users).toEqual([])
	await confirm(sentToken())
	expect((await recipients('all-users')).users).toEqual([
		{
			stable_user_id: id,
			email: 'member@example.com',
			username: 'reader',
			opted_in: true,
			opt_in_updated_at: now.toISOString(),
			opt_in_source: 'newsletter_page',
			unsubscribed: false,
		},
	])
	// A later explicit choice on the account wins over the old sign-up.
	sqlite
		.prepare(
			`UPDATE users SET whats_new_email_opt_in = 0, whats_new_email_opt_in_updated_at = '2026-11-16'`,
		)
		.run()
	expect((await recipients()).users).toEqual([])
})

test('a sign-up confirmed before the account existed carries over while the account has made no choice', async () => {
	const { signup, sentToken, confirm, user, recipients } = setup()
	await signup('early@example.com')
	await confirm(sentToken())
	const id = user('early@example.com')
	expect((await recipients()).users).toEqual([
		expect.objectContaining({
			stable_user_id: id,
			opted_in: true,
			opt_in_source: 'newsletter_page',
			opt_in_updated_at: now.toISOString(),
			unsubscribed: false,
		}),
	])
})

test('the confirmation email states the double opt-in terms and has no em dashes', () => {
	const message = buildNewsletterConfirmEmail({
		appBaseUrl: 'https://kody.example.com',
		confirmUrl: 'https://kody.example.com/newsletter/confirm?token=abc',
	})
	expect(message.text).toContain('You are not subscribed until you do.')
	expect(message.text).toContain('expires in 7 days')
	expect(message.html).toContain(
		'https://kody.example.com/newsletter/confirm?token=abc',
	)
	expect(`${message.subject}${message.text}`).not.toContain('\u2014')
})

test('unsubscribing through either id leaves the list when an address has both a sign-up and an account', async () => {
	for (const through of ['signup', 'account'] as const) {
		const { signup, sentToken, confirm, user, recipients, rows, db, sqlite } =
			setup()
		await signup('both@example.com')
		await confirm(sentToken())
		const signupId = rows()[0]!.stable_id as string
		const userId = user('both@example.com', 1, '2026-11-16')
		await setWhatsNewOptIn({
			db,
			stable_user_id: through === 'signup' ? signupId : userId,
			opted_in: false,
			source: 'email_link',
		})
		expect((await recipients()).users).toEqual([])
		expect(rows()[0]!.status).toBe('unsubscribed')
		// The old sign-up must not come back if the account's address changes.
		sqlite.prepare(`UPDATE users SET email = 'moved@example.com'`).run()
		expect((await recipients()).users).toEqual([])
		// Opening the same unsubscribe link again is not an error.
		await setWhatsNewOptIn({
			db,
			stable_user_id: signupId,
			opted_in: false,
			source: 'email_link',
		})
	}
})

test('the sign-up lifecycle only joins the list through a confirmed link and never returns to pending', async () => {
	const { canHandle } = await import('@kody-internal/shared/state-machine.ts')
	const { newsletterSignupState: machine } = await import('./signup-state.ts')
	expect(canHandle(machine, 'pending', 'CONFIRM')).toBe(true)
	expect(canHandle(machine, 'pending', 'RESUBSCRIBE')).toBe(false)
	expect(canHandle(machine, 'pending', 'UNSUBSCRIBE')).toBe(false)
	expect(canHandle(machine, 'confirmed', 'UNSUBSCRIBE')).toBe(true)
	expect(canHandle(machine, 'confirmed', 'CONFIRM')).toBe(false)
	expect(canHandle(machine, 'unsubscribed', 'RESUBSCRIBE')).toBe(true)
	expect(canHandle(machine, 'unsubscribed', 'CONFIRM')).toBe(true)
})
