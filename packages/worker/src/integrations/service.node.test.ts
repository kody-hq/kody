import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { upsertPlatformOauthApp } from './platform-apps.ts'
import {
	deleteIntegration,
	deleteOauthAppIfUnused,
	deleteOauthAppWithConnections,
	findOauthAppForProviderSetup,
	getAvailablePlatformApp,
	getIntegration,
	getJoinedIntegration,
	getOauthApp,
	listAvailablePlatformApps,
	listIntegrations,
	listOauthApps,
	listJoinedIntegrations,
	rotateOauthAppClientCredentials,
	upsertIntegration,
	upsertOauthAppWithoutConnection,
	upsertPlatformIntegration,
} from './service.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

type PlatformEnv = Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>

function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const env: PlatformEnv = {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	}
	const query = (sql: string, ...params: Array<string>) =>
		sqlite.prepare(sql).all(...params)
	const googleAppIdentity = (userId: string) =>
		sqlite
			.prepare(
				`SELECT slug, provider, label, client_id, token_url, created_at, updated_at
				FROM user_oauth_apps WHERE user_id = ? AND slug = 'google'`,
			)
			.get(userId)
	const save = (
		userId: string,
		config: Parameters<typeof upsertIntegration>[0]['config'],
	) => upsertIntegration({ env, userId, config })
	return { sqlite, env, query, googleAppIdentity, save }
}

const baseGoogleConfig = {
	name: 'google',
	tokenUrl: 'https://oauth2.googleapis.com/token',
	apiBaseUrl: 'https://www.googleapis.com',
	flow: 'pkce' as const,
	clientId: 'google-client-id-value',
	requiredHosts: ['www.googleapis.com', 'accounts.google.com'],
	authorization: {
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		scopes: ['openid', 'email'],
		scopeSeparator: null,
		extraAuthorizeParams: { access_type: 'offline' },
	},
}

function google(
	overrides: Partial<Omit<typeof baseGoogleConfig, 'authorization'>> & {
		scopes?: Array<string>
	} = {},
) {
	const { scopes, ...rest } = overrides
	return {
		...baseGoogleConfig,
		...rest,
		authorization: {
			...baseGoogleConfig.authorization,
			...(scopes ? { scopes } : {}),
		},
	}
}

const googleSetupConfig = (name: string) => ({
	name,
	tokenUrl: 'https://oauth2.googleapis.com/token',
	apiBaseUrl: 'https://www.googleapis.com',
	flow: 'pkce' as const,
	clientId: 'shared-google-client',
	authorization: {
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		scopes: [],
		extraAuthorizeParams: { access_type: 'offline' },
	},
})

const notionSetupConfig = (clientId: string) => ({
	name: 'notion',
	tokenUrl: 'https://api.notion.com/v1/oauth/token',
	flow: 'confidential' as const,
	clientId,
	authorization: { authorizeUrl: 'https://api.notion.com/v1/oauth/authorize' },
})

const githubPlatformApp = {
	slug: 'github',
	clientId: 'platform-github-client-id',
	tokenUrl: 'https://github.com/login/oauth/access_token',
	authorizeUrl: 'https://github.com/login/oauth/authorize',
	apiBaseUrl: 'https://api.github.com',
	flow: 'confidential' as const,
}

function provisionGithubPlatformApp(env: PlatformEnv) {
	return upsertPlatformOauthApp({
		db: env.APP_DB,
		env,
		app: {
			...githubPlatformApp,
			clientSecret: 'platform-github-client-secret-value',
			allowedScopes: ['repo', 'read:user', 'gist'],
			defaultScopes: ['read:user'],
			requiredHosts: ['api.github.com'],
		},
	})
}

function connectPlatform(
	env: PlatformEnv,
	userId: string,
	scopes: Array<string>,
	platformAppSlug = 'github',
) {
	return upsertPlatformIntegration({ env, userId, platformAppSlug, scopes })
}

test('upsertIntegration reuses matching app tuples, splits on endpoint mismatch, and normalizes required hosts', async () => {
	const { env, save } = createEnv()
	const normalized = await save(
		'user-upsert',
		google({
			requiredHosts: [
				'https://www.googleapis.com',
				'HTTPS://ACCOUNTS.GOOGLE.COM/o/oauth2',
				'oauth2.googleapis.com',
			],
		}),
	)
	expect(normalized.requiredHosts).toEqual([
		'accounts.google.com',
		'oauth2.googleapis.com',
		'www.googleapis.com',
	])
	await save(
		'user-upsert',
		google({
			name: 'google-calendar',
			scopes: ['calendar.readonly'],
			requiredHosts: ['www.googleapis.com'],
		}),
	)
	const apps = await listOauthApps({
		env,
		userId: ownerIdFromStored('user-upsert'),
	})
	expect(apps).toHaveLength(1)
	expect(apps[0]).toMatchObject({
		slug: 'google',
		connectionCount: 2,
		clientId: 'google-client-id-value',
	})
	const listed = await listIntegrations({
		env,
		userId: ownerIdFromStored('user-upsert'),
	})
	expect(listed.map((entry) => [entry.name, entry.clientId]).sort()).toEqual([
		['google', 'google-client-id-value'],
		['google-calendar', 'google-client-id-value'],
	])

	const splitUserId = 'user-upsert-split'
	await save(splitUserId, baseGoogleConfig)
	await save(
		splitUserId,
		google({
			name: 'google-legacy',
			tokenUrl: 'https://oauth2.googleapis.com/token/legacy',
		}),
	)
	const splitApps = await listOauthApps({ env, userId: splitUserId })
	expect(splitApps.map((app) => [app.slug, app.tokenUrl]).sort()).toEqual([
		['google', 'https://oauth2.googleapis.com/token'],
		['google-legacy', 'https://oauth2.googleapis.com/token/legacy'],
	])
	for (const [name, tokenUrl] of [
		['google', 'https://oauth2.googleapis.com/token'],
		['google-legacy', 'https://oauth2.googleapis.com/token/legacy'],
	] as const) {
		const integration = await getIntegration({
			env,
			userId: splitUserId,
			name,
		})
		expect(integration?.tokenUrl).toBe(tokenUrl)
	}
})

test('rotateOauthAppClientCredentials updates sibling joins, blocks delete while connected, and canonicalizes slugs', async () => {
	const { env, save } = createEnv()
	const userId = ownerIdFromStored('user-rotate')
	await save(userId, baseGoogleConfig)
	await save(userId, google({ name: 'google-mail' }))

	expect(await getOauthApp({ env, userId, slug: 'Google' })).toMatchObject({
		slug: 'google',
		clientId: 'google-client-id-value',
	})
	expect(
		await rotateOauthAppClientCredentials({
			env,
			userId,
			slug: ' Google ',
			clientId: 'google-client-id-rotated',
		}),
	).toMatchObject({
		slug: 'google',
		clientId: 'google-client-id-rotated',
		hasClientSecret: false,
	})
	for (const name of ['google', 'google-mail']) {
		const integration = await getIntegration({ env, userId, name })
		expect(integration?.clientId).toBe('google-client-id-rotated')
	}

	await expect(
		deleteOauthAppIfUnused({ env, userId, slug: 'GOOGLE' }),
	).rejects.toThrow(/still has 2 connections/)
	expect((await getIntegration({ env, userId, name: 'google' }))?.name).toBe(
		'google',
	)
	expect(
		await deleteOauthAppWithConnections({ env, userId, slug: 'GOOGLE' }),
	).toEqual({ deleted: true, connectionNames: ['google', 'google-mail'] })
	expect(await listIntegrations({ env, userId })).toEqual([])
	expect(await getOauthApp({ env, userId, slug: 'google' })).toBeNull()
	expect(
		await deleteOauthAppWithConnections({ env, userId, slug: 'google' }),
	).toEqual({ deleted: false, connectionNames: [] })
})

test('upsertIntegration reuses a confidential app that stored usePkce false as NULL', async () => {
	const { env, sqlite, query, save } = createEnv()
	const now = '2026-02-01T00:00:00.000Z'
	sqlite
		.prepare(
			`INSERT INTO user_oauth_apps (
				user_id, slug, provider, label, client_id,
				token_url, authorize_url, api_base_url, flow, use_pkce,
				token_exchange_style, scope_separator, extra_authorize_params_json,
				created_at, updated_at
			) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, 'confidential', NULL, ?, NULL, '{}', ?, ?)`,
		)
		.run(
			'user-reuse',
			'canva',
			'canva',
			'canva-client-id-value',
			'https://api.canva.com/rest/v1/oauth/token',
			'https://api.canva.com',
			'basic-form',
			now,
			now,
		)
	sqlite
		.prepare(
			`INSERT INTO user_integrations (
				user_id, name, app_slug, account_label, description, scopes_json,
				required_hosts_json,
				connected_at, token_refreshed_at, created_at, updated_at
			) VALUES (?, ?, ?, NULL, '', '[]', ?, NULL, NULL, ?, ?)`,
		)
		.run('user-reuse', 'canva', 'canva', '["api.canva.com"]', now, now)
	expect(
		query(
			`SELECT slug, flow, use_pkce FROM user_oauth_apps WHERE user_id = ?`,
			'user-reuse',
		),
	).toEqual([{ slug: 'canva', flow: 'confidential', use_pkce: null }])

	await save('user-reuse', {
		name: 'canva-team',
		tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
		apiBaseUrl: 'https://api.canva.com',
		flow: 'confidential',
		usePkce: false,
		clientId: 'canva-client-id-value',
		requiredHosts: ['api.canva.com'],
		tokenExchangeStyle: 'basic-form',
	})
	const apps = await listOauthApps({
		env,
		userId: ownerIdFromStored('user-reuse'),
	})
	expect(apps).toHaveLength(1)
	expect(apps[0]).toMatchObject({
		slug: 'canva',
		connectionCount: 2,
		usePkce: null,
		flow: 'confidential',
	})
	const joined = await listJoinedIntegrations({
		env,
		userId: ownerIdFromStored('user-reuse'),
	})
	expect(
		joined.map(({ connection, app }) => [connection.name, app?.slug]).sort(),
	).toEqual([
		['canva', 'canva'],
		['canva-team', 'canva'],
	])
})

test('shared app identity survives reuse and scope-only resaves across sibling connections', async () => {
	const { query, googleAppIdentity, save } = createEnv()
	const preserveUserId = 'user-provider-preserve'
	await save(preserveUserId, baseGoogleConfig)
	await save(preserveUserId, google({ name: 'google-calendar' }))
	const before = googleAppIdentity(preserveUserId)
	expect(before).toMatchObject({ provider: 'google' })
	await save(
		preserveUserId,
		google({
			name: 'acme-thing',
			scopes: ['acme.scope'],
			requiredHosts: ['www.googleapis.com'],
		}),
	)
	expect(googleAppIdentity(preserveUserId)).toEqual(before)

	const resaveUserId = 'user-four-shared'
	for (const name of [
		'google',
		'google-calendar',
		'google-mail',
		'google-drive',
	]) {
		await save(resaveUserId, google({ name, scopes: [`${name}.initial`] }))
	}
	const beforeResave = googleAppIdentity(resaveUserId)
	await save(
		resaveUserId,
		google({
			name: 'google-mail',
			scopes: ['gmail.modify', 'gmail.readonly'],
			requiredHosts: ['gmail.googleapis.com'],
		}),
	)
	expect(googleAppIdentity(resaveUserId)).toEqual(beforeResave)
	const connections = query(
		`SELECT name, app_slug, scopes_json, required_hosts_json
		FROM user_integrations WHERE user_id = ? ORDER BY name`,
		resaveUserId,
	)
	expect(connections.map((row) => row.app_slug)).toEqual(
		Array(4).fill('google'),
	)
	expect(connections.find((row) => row.name === 'google-mail')).toMatchObject({
		scopes_json: JSON.stringify(['gmail.modify', 'gmail.readonly']),
		required_hosts_json: JSON.stringify(['gmail.googleapis.com']),
	})
})

test('rematch deletes orphan apps, keeps sibling apps intact, and converts sole user apps to platform', async () => {
	const { env, query, save } = createEnv()
	const orphanUserId = 'user-orphan'
	const appSlugs = (userId: string) =>
		query(
			`SELECT slug FROM user_oauth_apps WHERE user_id = ? ORDER BY slug`,
			userId,
		)
	const connectionApps = (userId: string) =>
		query(
			`SELECT name, app_slug FROM user_integrations WHERE user_id = ? ORDER BY name`,
			userId,
		)
	await save(orphanUserId, baseGoogleConfig)
	await save(
		orphanUserId,
		google({ name: 'solo-app', clientId: 'solo-client-id' }),
	)
	expect(appSlugs(orphanUserId)).toEqual([
		{ slug: 'google' },
		{ slug: 'solo-app' },
	])
	await save(orphanUserId, google({ name: 'solo-app' }))
	expect(appSlugs(orphanUserId)).toEqual([{ slug: 'google' }])
	expect(connectionApps(orphanUserId)).toEqual([
		{ name: 'google', app_slug: 'google' },
		{ name: 'solo-app', app_slug: 'google' },
	])

	const siblingUserId = 'user-sibling-keep'
	for (const name of [
		'google',
		'google-calendar',
		'google-mail',
		'google-drive',
	]) {
		await save(
			siblingUserId,
			google({
				name,
				scopes: name === 'google' ? ['openid', 'email'] : [`${name}.scope`],
			}),
		)
	}
	expect(connectionApps(siblingUserId)).toEqual([
		{ name: 'google', app_slug: 'google' },
		{ name: 'google-calendar', app_slug: 'google' },
		{ name: 'google-drive', app_slug: 'google' },
		{ name: 'google-mail', app_slug: 'google' },
	])
	await save(
		siblingUserId,
		google({
			name: 'google-drive',
			tokenUrl: 'https://oauth2.googleapis.com/token/other',
		}),
	)
	expect(
		query(
			`SELECT slug, provider FROM user_oauth_apps WHERE user_id = ? AND slug = 'google'`,
			siblingUserId,
		),
	).toEqual([{ slug: 'google', provider: 'google' }])
	expect(connectionApps(siblingUserId)).toEqual([
		{ name: 'google', app_slug: 'google' },
		{ name: 'google-calendar', app_slug: 'google' },
		{ name: 'google-drive', app_slug: 'google-drive' },
		{ name: 'google-mail', app_slug: 'google' },
	])

	await provisionGithubPlatformApp(env)
	const convertUserId = 'user-converts'
	await save(convertUserId, {
		name: 'github',
		tokenUrl: 'https://github.com/login/oauth/access_token',
		flow: 'confidential',
		clientId: 'personal-github-client-id',
		requiredHosts: ['api.github.com'],
		authorization: {
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			scopes: ['repo'],
			scopeSeparator: null,
			extraAuthorizeParams: {},
		},
	})
	expect(await listOauthApps({ env, userId: convertUserId })).toHaveLength(1)
	await connectPlatform(env, convertUserId, ['read:user'])
	expect(await listOauthApps({ env, userId: convertUserId })).toHaveLength(0)
	const joined = await listJoinedIntegrations({ env, userId: convertUserId })
	expect(joined.map((entry) => entry.lane)).toEqual(['platform'])
})

test('upsertOauthAppWithoutConnection covers setup, client-id reuse, and connected-app preservation', async () => {
	const { env, googleAppIdentity, save } = createEnv()
	const setupUserId = 'user-setup-then-connect'
	const spotifyAuthorization = {
		authorizeUrl: 'https://accounts.spotify.com/authorize',
		scopeSeparator: ' ',
		extraAuthorizeParams: {},
	}
	const spotifyApp = {
		slug: 'spotify',
		clientId: 'spotify-client-from-setup',
	}
	const app = await upsertOauthAppWithoutConnection({
		env,
		userId: setupUserId,
		config: {
			name: 'spotify',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			apiBaseUrl: null,
			flow: 'pkce',
			usePkce: true,
			clientId: 'spotify-client-from-setup',
			authorization: { ...spotifyAuthorization, scopes: [] },
		},
	})
	expect(app).toMatchObject({ ...spotifyApp, flow: 'pkce' })
	expect(await listOauthApps({ env, userId: setupUserId })).toEqual([
		expect.objectContaining({ ...spotifyApp, connectionCount: 0 }),
	])
	expect(await listIntegrations({ env, userId: setupUserId })).toEqual([])
	await save(setupUserId, {
		name: 'spotify',
		tokenUrl: 'https://accounts.spotify.com/api/token',
		apiBaseUrl: null,
		flow: 'pkce',
		clientId: 'spotify-client-from-setup',
		requiredHosts: ['api.spotify.com'],
		authorization: { ...spotifyAuthorization, scopes: ['user-read-email'] },
	})
	expect(await listOauthApps({ env, userId: setupUserId })).toEqual([
		expect.objectContaining({ ...spotifyApp, connectionCount: 1 }),
	])

	const notionUserId = 'user-setup-orphan-reuse'
	await upsertOauthAppWithoutConnection({
		env,
		userId: notionUserId,
		config: notionSetupConfig('notion-client-old'),
	})
	expect(
		await upsertOauthAppWithoutConnection({
			env,
			userId: notionUserId,
			config: notionSetupConfig('notion-client-new'),
		}),
	).toMatchObject({ slug: 'notion', clientId: 'notion-client-new' })
	expect(await listOauthApps({ env, userId: notionUserId })).toHaveLength(1)

	const preserveUserId = 'user-setup-preserve'
	await upsertOauthAppWithoutConnection({
		env,
		userId: preserveUserId,
		config: googleSetupConfig('google'),
	})
	await save(
		preserveUserId,
		google({
			clientId: 'shared-google-client',
			requiredHosts: ['www.googleapis.com'],
		}),
	)
	const before = googleAppIdentity(preserveUserId)
	const secondSetup = await upsertOauthAppWithoutConnection({
		env,
		userId: preserveUserId,
		config: googleSetupConfig('google-calendar'),
	})
	expect(secondSetup.slug).toBe('google')
	expect(googleAppIdentity(preserveUserId)).toEqual(before)
})

test('upsertOauthAppWithoutConnection persists deviceAuthorizationUrl on user apps', async () => {
	const { env } = createEnv()
	const userId = 'user-device-url-persist'
	const app = await upsertOauthAppWithoutConnection({
		env,
		userId,
		config: {
			name: 'example-device',
			tokenUrl: 'https://auth.example.com/token',
			apiBaseUrl: 'https://api.example.com',
			flow: 'device',
			clientId: 'device-client-1',
			deviceAuthorizationUrl: 'https://auth.example.com/device',
			authorization: null,
		},
	})
	expect(app.deviceAuthorizationUrl).toBe('https://auth.example.com/device')
	expect(app.flow).toBe('device')
	const reloaded = await getOauthApp({
		env,
		userId,
		slug: app.slug,
	})
	expect(reloaded?.deviceAuthorizationUrl).toBe(
		'https://auth.example.com/device',
	)
})

test('findOauthAppForProviderSetup prefers an exact-slug setup app over family prefill', async () => {
	const { env, save } = createEnv()
	const userId = ownerIdFromStored('user-family-prefill')
	await save(userId, baseGoogleConfig)
	await upsertOauthAppWithoutConnection({
		env,
		userId,
		config: {
			name: 'google-calendar',
			tokenUrl: 'https://oauth2.googleapis.com/token/calendar-only',
			apiBaseUrl: 'https://www.googleapis.com',
			flow: 'pkce',
			clientId: 'calendar-only-client',
			authorization: {
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			},
		},
	})
	expect(
		await findOauthAppForProviderSetup({
			env,
			userId,
			name: 'google-calendar',
		}),
	).toMatchObject({
		slug: 'google-calendar',
		clientId: 'calendar-only-client',
		tokenUrl: 'https://oauth2.googleapis.com/token/calendar-only',
	})
})

test('listJoinedIntegrations skips orphan OAuth joins; getJoinedIntegration still throws', async () => {
	const { env, sqlite, save } = createEnv()
	const userId = ownerIdFromStored('user-orphan-list')
	await save(userId, baseGoogleConfig)
	await save(userId, google({ name: 'google-calendar' }))
	const now = new Date().toISOString()
	// Soft-delete the shared OAuth app while leaving both connections live.
	sqlite
		.prepare(
			`UPDATE user_oauth_apps SET deleted_at = ? WHERE user_id = ? AND slug = 'google'`,
		)
		.run(now, userId)
	await save(userId, {
		name: 'notion',
		tokenUrl: 'https://api.notion.com/v1/oauth/token',
		apiBaseUrl: 'https://api.notion.com',
		flow: 'confidential' as const,
		clientId: 'notion-client',
		requiredHosts: ['api.notion.com'],
		authorization: {
			authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
			scopes: [],
		},
	})

	const listed = await listJoinedIntegrations({ env, userId })
	expect(listed.map((entry) => entry.connection.name).sort()).toEqual([
		'notion',
	])

	await expect(
		getJoinedIntegration({ env, userId, name: 'google' }),
	).rejects.toThrow(/references a missing OAuth app/)
	await expect(
		getJoinedIntegration({ env, userId, name: 'google-calendar' }),
	).rejects.toThrow(/references a missing OAuth app/)
})

test('upsertPlatformIntegration enforces connect policy, hides secrets, and deletes without orphaning the shared app', async () => {
	const { env } = createEnv()
	await provisionGithubPlatformApp(env)

	const saved = await connectPlatform(env, 'user-platform', [
		'read:user',
		'repo',
	])
	expect(saved).toMatchObject({
		name: 'github',
		platform: true,
		clientId: 'platform-github-client-id',
	})
	expect(saved.requiredHosts).toEqual(['api.github.com', 'github.com'])
	expect(saved.authorization?.scopes).toEqual(['read:user', 'repo'])
	const listed = await listIntegrations({
		env,
		userId: ownerIdFromStored('user-platform'),
	})
	expect(listed).toHaveLength(1)
	expect(listed[0]?.platform).toBe(true)
	expect(JSON.stringify(listed)).not.toContain(
		'platform-github-client-secret-value',
	)
	const joined = await listJoinedIntegrations({
		env,
		userId: ownerIdFromStored('user-platform'),
	})
	expect(joined[0]?.lane).toBe('platform')
	expect(joined[0]?.connection.platformAppSlug).toBe('github')
	expect(joined[0]?.connection.appSlug).toBeNull()

	await expect(
		connectPlatform(env, 'user-platform-scopes', ['admin:org']),
	).rejects.toThrow('Scopes not allowed for platform integration "github"')
	// An explicitly empty selection stays empty: the stored list mirrors the
	// authorize request instead of reporting default scopes never requested.
	const clearedScopes = await connectPlatform(env, 'user-platform-cleared', [])
	expect(clearedScopes.authorization?.scopes).toEqual([])

	await upsertPlatformOauthApp({
		db: env.APP_DB,
		env,
		app: {
			slug: 'github-strict',
			clientId: 'platform-github-strict-id',
			clientSecret: 'platform-github-strict-secret',
			tokenUrl: githubPlatformApp.tokenUrl,
			authorizeUrl: githubPlatformApp.authorizeUrl,
			flow: 'confidential',
			allowedScopes: [],
			defaultScopes: [],
		},
	})
	await expect(
		connectPlatform(env, 'user-strict', ['repo'], 'github-strict'),
	).rejects.toThrow(
		'Scopes not allowed for platform integration "github-strict"',
	)
	const scopeless = await connectPlatform(
		env,
		'user-strict',
		[],
		'github-strict',
	)
	expect(scopeless.authorization?.scopes).toEqual([])

	await connectPlatform(env, 'user-deletes', [])
	expect(
		await deleteIntegration({
			env,
			userId: ownerIdFromStored('user-deletes'),
			name: 'github',
		}),
	).toBe(true)
	expect(
		await listIntegrations({ env, userId: ownerIdFromStored('user-deletes') }),
	).toEqual([])
	// The shared app survives; draft keeps it off discovery until published.
	expect(await getAvailablePlatformApp({ env, slug: 'github' })).toBeNull()
	await upsertPlatformOauthApp({
		db: env.APP_DB,
		env,
		app: { ...githubPlatformApp, visibility: 'published' },
	})
	expect(await getAvailablePlatformApp({ env, slug: 'github' })).toMatchObject({
		slug: 'github',
		visibility: 'published',
	})
	expect(
		(await listAvailablePlatformApps({ env })).map((app) => app.slug),
	).toEqual(['github'])

	const disabled = createEnv()
	const disabledApp = await provisionGithubPlatformApp(disabled.env)
	await upsertPlatformOauthApp({
		db: disabled.env.APP_DB,
		env: disabled.env,
		app: {
			slug: disabledApp.slug,
			clientId: disabledApp.clientId,
			tokenUrl: disabledApp.tokenUrl,
			authorizeUrl: disabledApp.authorizeUrl,
			flow: disabledApp.flow,
			enabled: false,
			visibility: 'published',
		},
	})
	expect(await listAvailablePlatformApps({ env: disabled.env })).toEqual([])
	await expect(
		connectPlatform(disabled.env, 'user-blocked', []),
	).rejects.toThrow('Platform integration "github" is not available.')
})

test('loading a platform integration adds current app hosts without removing connection hosts', async () => {
	const { env, sqlite, query } = createEnv()
	const userId = ownerIdFromStored('user-stale-platform-hosts')
	await provisionGithubPlatformApp(env)
	await connectPlatform(env, userId, [])
	sqlite
		.prepare(
			`UPDATE user_integrations SET required_hosts_json = ? WHERE user_id = ? AND name = ?`,
		)
		.run('["api.github.com","user-added.example.com"]', userId, 'github')
	await upsertPlatformOauthApp({
		db: env.APP_DB,
		env,
		app: {
			...githubPlatformApp,
			requiredHosts: ['api.github.com', 'uploads.github.com'],
		},
	})

	const loaded = await getIntegration({ env, userId, name: 'github' })
	const expectedHosts = [
		'api.github.com',
		'uploads.github.com',
		'user-added.example.com',
	]
	expect(loaded?.requiredHosts).toEqual(expectedHosts)
	expect(
		query(
			`SELECT required_hosts_json FROM user_integrations WHERE user_id = ? AND name = ?`,
			userId,
			'github',
		),
	).toEqual([{ required_hosts_json: JSON.stringify(expectedHosts) }])
})
