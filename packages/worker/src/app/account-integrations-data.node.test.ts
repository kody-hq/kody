import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	upsertIntegration,
	upsertOauthAppWithoutConnection,
} from '#worker/integrations/service.ts'
import { upsertPlatformOauthApp } from '#worker/integrations/platform-apps.ts'
import {
	loadAccountIntegrationByName,
	loadAccountIntegrationsData,
	loadAccountOauthAppBySlug,
} from './account-integrations-data.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const secretLeakPattern =
	/"access_token"\s*:|"refresh_token"\s*:|sk_|secret_value/

type LoaderUser = Parameters<typeof loadAccountIntegrationByName>[1]
type LookupOptions = Parameters<typeof loadAccountIntegrationByName>[3]

function fakeUser(userId: string) {
	return {
		email: 'user@example.com',
		username: 'user',
		mcpUser: { userId, email: 'user@example.com', username: 'user' },
	} as LoaderUser
}

function createEnv(userId: string) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	const env = { APP_DB: createD1FromSqlite(sqlite) } as Env
	const user = fakeUser(userId)
	return {
		env,
		user,
		platformEnv: {
			...env,
			SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		} as Env,
		lookup: (name: string, options?: LookupOptions) =>
			loadAccountIntegrationByName(env, user, name, options),
	}
}

const googleConfig = {
	name: 'google',
	tokenUrl: 'https://oauth2.googleapis.com/token',
	apiBaseUrl: 'https://www.googleapis.com',
	flow: 'pkce' as const,
	clientId: 'shared-google-client',
	requiredHosts: ['www.googleapis.com'],
	authorization: {
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		scopes: ['openid', 'email'],
		scopeSeparator: null,
		extraAuthorizeParams: { access_type: 'offline' },
	},
}

const googleCalendarConfig = {
	...googleConfig,
	name: 'google-calendar',
	authorization: {
		...googleConfig.authorization,
		scopes: ['calendar.readonly'],
	},
}

const notionAppConfig = {
	name: 'notion',
	tokenUrl: 'https://api.notion.com/v1/oauth/token',
	flow: 'confidential' as const,
	clientId: 'notion-client-from-setup',
	authorization: { authorizeUrl: 'https://api.notion.com/v1/oauth/authorize' },
}

const githubTokenUrl = 'https://github.com/login/oauth/access_token'
const githubAuthorizeUrl = 'https://github.com/login/oauth/authorize'

test('loadAccountIntegrationByName covers setup prefill, reconnect, and exact-slug apps', async () => {
	const userId = ownerIdFromStored('user-integrations-loader')
	const { env, lookup } = createEnv(userId)

	expect(await lookup('linear')).toBeNull()

	await upsertIntegration({ env, userId, config: googleConfig, audit: null })
	const calendarSetup = await lookup('google-calendar')
	expect(calendarSetup).toMatchObject({
		name: 'google-calendar',
		appSlug: 'google',
		provider: 'google',
		clientId: 'shared-google-client',
		tokenUrl: 'https://oauth2.googleapis.com/token',
		flow: 'pkce',
		authorization: {
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			scopes: [],
		},
		hasClientSecret: false,
	})
	expect(JSON.stringify(calendarSetup)).not.toMatch(secretLeakPattern)

	await upsertIntegration({
		env,
		userId,
		config: googleCalendarConfig,
		audit: null,
	})
	expect(await lookup('google-calendar')).toMatchObject({
		name: 'google-calendar',
		appSlug: 'google',
		clientId: 'shared-google-client',
		authorization: { scopes: ['calendar.readonly'] },
	})

	await upsertOauthAppWithoutConnection({
		env,
		userId: ownerIdFromStored('user-abandoned'),
		config: notionAppConfig,
	})
	expect(
		await loadAccountIntegrationByName(
			env,
			fakeUser('user-abandoned'),
			'notion',
		),
	).toMatchObject({
		name: 'notion',
		appSlug: 'notion',
		clientId: 'notion-client-from-setup',
	})
})

test('platform= never converts an existing connection and wins over a same-slug personal app only while published', async () => {
	const userId = ownerIdFromStored('user-platform-precedence')
	const { env, platformEnv, lookup } = createEnv(userId)
	const githubApp = {
		slug: 'github-platform',
		label: 'GitHub',
		clientId: 'platform-github-client',
		clientSecret: 'platform-github-secret',
		tokenUrl: githubTokenUrl,
		authorizeUrl: githubAuthorizeUrl,
		flow: 'confidential' as const,
		defaultScopes: ['read:user'],
		allowedScopes: ['read:user'],
		visibility: 'published' as const,
	}
	await upsertPlatformOauthApp({
		db: env.APP_DB,
		env: platformEnv,
		app: githubApp,
	})
	const personalGithub = {
		tokenUrl: githubTokenUrl,
		flow: 'confidential' as const,
		authorization: { authorizeUrl: githubAuthorizeUrl, scopes: [] },
	}
	await upsertIntegration({
		env,
		userId,
		config: {
			...personalGithub,
			name: 'github-mine',
			clientId: 'user-github-client',
		},
		audit: null,
	})
	const existingByo = await lookup('github-mine', {
		platformSlug: 'github-platform',
	})
	expect(existingByo).toMatchObject({
		name: 'github-mine',
		clientId: 'user-github-client',
	})
	expect(existingByo?.platform).toBeFalsy()

	await upsertOauthAppWithoutConnection({
		env,
		userId,
		config: {
			...personalGithub,
			name: 'github-platform',
			clientId: 'personal-same-slug-client',
		},
	})
	const personalOnly = await lookup('github-platform-2', {
		appSlug: 'github-platform',
	})
	expect(personalOnly).toMatchObject({ clientId: 'personal-same-slug-client' })
	expect(personalOnly?.platform).toBeFalsy()
	expect(
		await lookup('github-platform-2', {
			appSlug: 'github-platform',
			platformSlug: 'github-platform',
		}),
	).toMatchObject({ platform: true, clientId: 'platform-github-client' })

	await upsertPlatformOauthApp({
		db: env.APP_DB,
		env: platformEnv,
		app: { ...githubApp, clientSecret: undefined, visibility: 'draft' },
	})
	const draftBuiltIn = await lookup('github-platform-2', {
		appSlug: 'github-platform',
		platformSlug: 'github-platform',
	})
	expect(draftBuiltIn).toMatchObject({ clientId: 'personal-same-slug-client' })
	expect(draftBuiltIn?.platform).toBeFalsy()
})

test('loadAccountIntegrationsData includes OAuth apps with their connections', async () => {
	const userId = ownerIdFromStored('user-integrations-apps-loader')
	const { env, user } = createEnv(userId)

	await upsertIntegration({ env, userId, config: googleConfig, audit: null })
	await upsertIntegration({
		env,
		userId,
		config: googleCalendarConfig,
		audit: null,
	})
	await upsertOauthAppWithoutConnection({
		env,
		userId,
		config: notionAppConfig,
	})

	const payload = await loadAccountIntegrationsData(env, user)
	expect(payload.ok).toBe(true)
	expect(payload.integrations.map((entry) => entry.name).sort()).toEqual([
		'google',
		'google-calendar',
	])
	expect(payload.apps).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				slug: 'google',
				provider: 'google',
				clientId: 'shared-google-client',
				connectionCount: 2,
				connections: expect.arrayContaining([
					expect.objectContaining({ name: 'google' }),
					expect.objectContaining({ name: 'google-calendar' }),
				]),
			}),
			expect.objectContaining({
				slug: 'notion',
				provider: 'notion',
				clientId: 'notion-client-from-setup',
				connectionCount: 0,
				connections: [],
			}),
		]),
	)
	expect(JSON.stringify(payload)).not.toMatch(secretLeakPattern)

	expect(await loadAccountOauthAppBySlug(env, user, 'google')).toMatchObject({
		slug: 'google',
		clientId: 'shared-google-client',
		connectionCount: 2,
	})
	expect(await loadAccountOauthAppBySlug(env, user, 'missing')).toBeNull()
	expect(
		await loadAccountOauthAppBySlug(env, fakeUser('other-user'), 'google'),
	).toBeNull()
})
