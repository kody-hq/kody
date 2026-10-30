import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import {
	getAcceptedSystemEmailDomains,
	getAcceptedUserEmailDomains,
	getPlatformEmailDomain,
	getSystemEmailDomain,
	resolveOwnedSenderAddress,
	resolveUserPlatformSender,
} from './platform-address.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

test('getPlatformEmailDomain derives inbox.<hostname> and prefers a valid USER_EMAIL_DOMAIN override', () => {
	const cases: Array<
		[Parameters<typeof getPlatformEmailDomain>[0], string | null]
	> = [
		[{ APP_BASE_URL: 'https://heykody.dev' }, 'inbox.heykody.dev'],
		[
			{ APP_BASE_URL: 'https://Staging.Example.COM/' },
			'inbox.staging.example.com',
		],
		[{}, null],
		[{ APP_BASE_URL: 'not a url' }, null],
		[
			{
				APP_BASE_URL: 'https://heykody.dev',
				USER_EMAIL_DOMAIN: 'Mail.Example.COM.',
			},
			'mail.example.com',
		],
		// The override works without APP_BASE_URL too.
		[{ USER_EMAIL_DOMAIN: 'inbox.heykody.dev' }, 'inbox.heykody.dev'],
		// A malformed override falls back to the derived default.
		[
			{
				APP_BASE_URL: 'https://heykody.dev',
				USER_EMAIL_DOMAIN: 'not a hostname',
			},
			'inbox.heykody.dev',
		],
		[{ USER_EMAIL_DOMAIN: 'user@host' }, null],
	]
	expect(cases.map(([input]) => getPlatformEmailDomain(input))).toEqual(
		cases.map(([, expected]) => expected),
	)
})

test('getSystemEmailDomain prefers a valid SYSTEM_EMAIL_DOMAIN override', () => {
	const cases: Array<
		[Parameters<typeof getSystemEmailDomain>[0], string | null]
	> = [
		// The migration lock: APP_BASE_URL moves to heykody.app but system mail
		// (kody@..., operator inboxes) stays on the verified heykody.dev zone.
		[
			{
				APP_BASE_URL: 'https://heykody.app',
				SYSTEM_EMAIL_DOMAIN: 'heykody.dev',
			},
			'heykody.dev',
		],
		[{ SYSTEM_EMAIL_DOMAIN: 'HeyKody.DEV.' }, 'heykody.dev'],
		// Without the override the domain derives from APP_BASE_URL as before.
		[{ APP_BASE_URL: 'https://heykody.dev' }, 'heykody.dev'],
		// A malformed override falls back to the derived default.
		[
			{
				APP_BASE_URL: 'https://heykody.dev',
				SYSTEM_EMAIL_DOMAIN: 'not a hostname',
			},
			'heykody.dev',
		],
		[{}, null],
	]
	expect(cases.map(([input]) => getSystemEmailDomain(input))).toEqual(
		cases.map(([, expected]) => expected),
	)
})

test('accepted inbound domains are canonical first plus legacy lists', () => {
	// The migration shape: canonical on .app, previous .dev domains still
	// accepted for inbound during the transition window.
	expect(
		getAcceptedUserEmailDomains({
			USER_EMAIL_DOMAIN: 'inbox.heykody.app',
			LEGACY_USER_EMAIL_DOMAINS: 'inbox.heykody.dev',
		}),
	).toEqual(['inbox.heykody.app', 'inbox.heykody.dev'])
	expect(
		getAcceptedSystemEmailDomains({
			SYSTEM_EMAIL_DOMAIN: 'heykody.app',
			LEGACY_SYSTEM_EMAIL_DOMAINS: 'heykody.dev',
		}),
	).toEqual(['heykody.app', 'heykody.dev'])

	// No legacy configured: just the canonical domain (unchanged behavior).
	expect(
		getAcceptedUserEmailDomains({ APP_BASE_URL: 'https://heykody.app' }),
	).toEqual(['inbox.heykody.app'])
	expect(getAcceptedSystemEmailDomains({})).toEqual([])

	// Normalization, dedupe against canonical, and malformed entries dropped.
	expect(
		getAcceptedUserEmailDomains({
			USER_EMAIL_DOMAIN: 'inbox.heykody.app',
			LEGACY_USER_EMAIL_DOMAINS:
				' Inbox.HeyKody.DEV. , inbox.heykody.app, not a domain ,,',
		}),
	).toEqual(['inbox.heykody.app', 'inbox.heykody.dev'])
})
test('resolveUserPlatformSender sends from an unreserved built-in username and blocks permanently reserved locals', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureUsersTestSchema({ db, columns: ['email_verified_at'] })
	const env = { APP_BASE_URL: 'https://kody.example.com' }

	const seedUser = async (username: string) => {
		const email = `${username}-holder@example.com`
		const userId = testStableUserIdFromEmail(email)
		await db
			.prepare(
				`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id)
				 VALUES (?, ?, 'hash', ?, ?)`,
			)
			.bind(username, email, new Date().toISOString(), userId)
			.run()
		return { accountEmail: email, userId }
	}

	const blog = await seedUser('blog')
	await expect(
		resolveUserPlatformSender({ db, env, ...blog }),
	).resolves.toEqual({
		from: 'blog@inbox.kody.example.com',
		accountEmail: blog.accountEmail,
		username: 'blog',
		domain: 'inbox.kody.example.com',
	})
	const kody = await seedUser('kody')
	await expect(resolveUserPlatformSender({ db, env, ...kody })).rejects.toThrow(
		'Reserved usernames cannot send email',
	)
})

test('resolveOwnedSenderAddress accepts only the sender base address and its plus aliases', () => {
	const sender = { username: 'examplebot', domain: 'inbox.kody.example.com' }
	const acceptedDomains = ['inbox.kody.example.com', 'inbox.legacy.example.com']
	const resolve = (address: string) =>
		resolveOwnedSenderAddress({ address, sender, acceptedDomains })

	expect(resolve('examplebot@inbox.kody.example.com')).toBe(
		'examplebot@inbox.kody.example.com',
	)
	expect(resolve('Bot <ExampleBot+Support@Inbox.Kody.Example.com>')).toBe(
		'examplebot+support@inbox.kody.example.com',
	)
	expect(resolve('examplebot+a.b_c-1@inbox.legacy.example.com')).toBe(
		'examplebot+a.b_c-1@inbox.kody.example.com',
	)
	for (const address of [
		'otherbot+support@inbox.kody.example.com',
		'examplebotx@inbox.kody.example.com',
		'examplebot+support@example.com',
		'examplebot+support@kody.example.com',
		'examplebot+@inbox.kody.example.com',
		'examplebot+a+b@inbox.kody.example.com',
		'examplebot+-a@inbox.kody.example.com',
		'examplebot+a%b@inbox.kody.example.com',
		`examplebot+${'t'.repeat(64)}@inbox.kody.example.com`,
		'not an address',
	]) {
		expect(resolve(address), address).toBeNull()
	}
})
