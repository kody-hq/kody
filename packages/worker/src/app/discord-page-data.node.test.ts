import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'
import { loadDiscordPageData } from '#app/discord-page-data.ts'
import { loadDiscordPageForRequest } from '#app/handlers/discord.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { kodyDiscordInviteUrl } from '#universal/community-links.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

function createTestDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function createAppEnv(
	db: D1Database,
	overrides: Record<string, string> = {},
): Env {
	return {
		APP_DB: db,
		COOKIE_SECRET: testCookieSecret,
		DISCORD_CLIENT_ID: 'discord-client-id-test',
		DISCORD_CLIENT_SECRET: 'discord-client-secret-test',
		...overrides,
	} as unknown as Env
}

async function seedUser(
	sqlite: DatabaseSync,
	input: { id: number; email: string },
) {
	const stableUserId = testStableUserIdFromEmail(input.email)
	sqlite
		.prepare(
			`INSERT INTO users (id, username, email, stable_user_id, password_hash)
			 VALUES (?, ?, ?, ?, ?)`,
		)
		.run(input.id, `user-${input.id}`, input.email, stableUserId, 'x')
	await provisionPersonalOrg(createD1FromSqlite(sqlite), {
		stableUserId,
		username: `user-${input.id}`,
	})
	return stableUserId
}

test('discord page reports guest, unconnected, and connected states', async () => {
	setAuthSessionSecret(testCookieSecret)
	const { sqlite, db } = createTestDb()
	const env = createAppEnv(db)

	const anonymous = await loadDiscordPageForRequest({
		env,
		request: new Request('http://example.com/discord.json'),
		url: new URL('http://example.com/discord.json'),
		params: {},
	} as never)
	expect(anonymous).toEqual({
		ok: true,
		signedIn: false,
		discordConnected: false,
		discordDisplayName: null,
		discordProviderAvailable: true,
		canSyncDiscordRoles: false,
		inviteUrl: kodyDiscordInviteUrl,
		turnstileSiteKey: null,
	})

	const stableUserId = await seedUser(sqlite, {
		id: 7,
		email: 'member@example.com',
	})
	expect(
		await loadDiscordPageData({
			env,
			userId: 7,
		}),
	).toEqual({
		ok: true,
		signedIn: true,
		discordConnected: false,
		discordDisplayName: null,
		discordProviderAvailable: true,
		canSyncDiscordRoles: false,
		inviteUrl: kodyDiscordInviteUrl,
		turnstileSiteKey: null,
	})

	sqlite
		.prepare(
			`INSERT INTO oauth_connections (
				provider_name, provider_id, user_id, provider_display_name
			) VALUES (?, ?, ?, ?)`,
		)
		.run('discord', '333333333333333333', 7, 'Kody Fan')

	expect(
		await loadDiscordPageData({
			env,
			userId: 7,
		}),
	).toMatchObject({
		signedIn: true,
		discordConnected: true,
		discordDisplayName: 'Kody Fan',
		canSyncDiscordRoles: false,
	})

	expect(
		await loadDiscordPageData({
			env: createAppEnv(db, {
				DISCORD_BOT_TOKEN: 'bot-token-test',
				DISCORD_GUILD_ID: '111111111111111111',
				DISCORD_MEMBER_ROLE_ID: '222222222222222222',
			}),
			userId: 7,
		}),
	).toMatchObject({
		discordConnected: true,
		canSyncDiscordRoles: true,
	})

	expect(
		await loadDiscordPageData({
			env: createAppEnv(db, {
				DISCORD_CLIENT_ID: '',
				DISCORD_CLIENT_SECRET: '',
			}),
			userId: 7,
		}),
	).toMatchObject({
		discordProviderAvailable: false,
	})

	expect(
		await loadDiscordPageData({
			env: createAppEnv(db, {
				TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
				TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
			}),
			userId: 7,
		}),
	).toMatchObject({
		turnstileSiteKey: '1x00000000000000000000AA',
	})

	const sessionCookie = await createAuthCookie(
		{
			stableUserId,
			email: 'member@example.com',
			rememberMe: false,
		},
		false,
	)
	const signedIn = await loadDiscordPageForRequest({
		env,
		request: new Request('http://example.com/discord.json', {
			headers: { Cookie: sessionCookie.split(';')[0] ?? sessionCookie },
		}),
		url: new URL('http://example.com/discord.json'),
		params: {},
	} as never)
	expect(signedIn).toMatchObject({
		ok: true,
		signedIn: true,
		discordConnected: true,
		discordDisplayName: 'Kody Fan',
	})
})
