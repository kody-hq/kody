import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { integrationDeleteCapability } from './integration-delete.ts'
import { integrationGetCapability } from './integration-get.ts'
import { integrationListCapability } from './integration-list.ts'
import { integrationOauthAppDeleteCapability } from './integration-oauth-app-delete.ts'
import { integrationOauthAppListCapability } from './integration-oauth-app-list.ts'
import { integrationOauthAppRotateCredentialsCapability } from './integration-oauth-app-rotate-credentials.ts'
import { integrationSaveCapability } from './integration-save.ts'
import {
	integrationConfigSchema,
	mergeIntegrationConfig,
} from './integration-shared.ts'
import { upsertPlatformOauthApp } from '#worker/integrations/platform-apps.ts'
import {
	getJoinedIntegration,
	upsertPlatformIntegration,
} from '#worker/integrations/service.ts'

const migrationsDirectory = new URL('../../../../migrations/', import.meta.url)

function applyAllMigrations(db: DatabaseSync) {
	applyRepositoryMigrations(db, migrationsDirectory)
}

function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite)
	return {
		sqlite,
		env: {
			APP_DB: createD1FromSqlite(sqlite),
			SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		} as unknown as Env,
	}
}

function caller(userId: string) {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://heykody.dev',
		user: {
			userId: personIdFromStored(userId),
			email: `${userId}@example.com`,
			displayName: userId,
		},
	})
}

function ctx(env: Env, userId: string) {
	return { env, callerContext: caller(userId) }
}

const spotifyBase = {
	name: 'spotify',
	tokenUrl: 'https://accounts.spotify.com/api/token',
	apiBaseUrl: 'https://api.spotify.com/v1',
	flow: 'pkce' as const,
	clientId: 'spotify-client-id-value',
	requiredHosts: ['api.spotify.com'],
	authorization: {
		authorizeUrl: 'https://accounts.spotify.com/authorize',
		scopes: ['user-read-email', 'playlist-read-private'],
		scopeSeparator: ' ',
		extraAuthorizeParams: { show_dialog: 'true' },
	},
}

const googleBase = {
	name: 'google',
	tokenUrl: 'https://oauth2.googleapis.com/token',
	apiBaseUrl: 'https://www.googleapis.com',
	flow: 'pkce' as const,
	clientId: 'google-client-id-value',
	requiredHosts: ['www.googleapis.com', 'accounts.google.com'],
	authorization: {
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		scopes: ['openid', 'email'],
		scopeSeparator: null as string | null,
		extraAuthorizeParams: { access_type: 'offline' },
	},
}

test('mergeIntegrationConfig and integrationSave create, canonicalize identity, and persist non-default usePkce', async () => {
	const current = integrationConfigSchema.parse({
		name: 'spotify',
		tokenUrl: 'https://accounts.spotify.com/api/token',
		apiBaseUrl: 'https://api.spotify.com/v1',
		flow: 'pkce',
		clientId: 'spotify-client-id-value',
		requiredHosts: ['accounts.spotify.com', 'api.spotify.com'],
		authorization: {
			authorizeUrl: 'https://accounts.spotify.com/authorize',
			scopes: ['user-read-email'],
			scopeSeparator: ' ',
			extraAuthorizeParams: {},
		},
	})

	expect(
		mergeIntegrationConfig(current, {
			name: 'spotify',
			apiBaseUrl: 'https://api.spotify.com/v2/',
			authorization: {
				authorizeUrl: 'https://accounts.spotify.com/oauth2/authorize',
				scopes: ['user-read-email', 'playlist-read-private'],
				scopeSeparator: ' ',
				extraAuthorizeParams: { prompt: 'consent' },
			},
			requiredHosts: ['https://api.spotify.com/v1', 'accounts.spotify.com'],
		}),
	).toMatchObject({
		apiBaseUrl: 'https://api.spotify.com/v2/',
		authorization: {
			authorizeUrl: 'https://accounts.spotify.com/oauth2/authorize',
			scopeSeparator: null,
		},
		requiredHosts: ['accounts.spotify.com', 'api.spotify.com'],
	})

	const { env } = createEnv()
	const result = await integrationSaveCapability.handler(
		spotifyBase,
		ctx(env, 'user-123'),
	)

	expect(result.integration).toMatchObject({
		name: 'spotify',
		flow: 'pkce',
		requiredHosts: ['api.spotify.com'],
		authorization: {
			scopes: ['user-read-email', 'playlist-read-private'],
			scopeSeparator: null,
		},
	})

	const listed = await integrationListCapability.handler(
		{},
		ctx(env, 'user-123'),
	)
	expect(listed.integrations).toHaveLength(1)

	const github = await integrationSaveCapability.handler(
		{
			name: 'GitHub',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			flow: 'confidential',
			clientId: 'github-client-id-value',
			requiredHosts: ['api.github.com'],
		},
		ctx(env, 'user-123'),
	)
	expect(github.integration.name).toBe('github')

	const canvaResult = await integrationSaveCapability.handler(
		{
			name: 'canva',
			tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
			apiBaseUrl: 'https://api.canva.com/rest/v1',
			flow: 'confidential',
			usePkce: true,
			clientId: 'canva-client-id-value',
			requiredHosts: ['api.canva.com'],
			tokenExchangeStyle: 'basic-form',
		},
		ctx(env, 'user-456'),
	)
	expect(canvaResult.integration).toMatchObject({
		name: 'canva',
		flow: 'confidential',
		usePkce: true,
		tokenExchangeStyle: 'basic-form',
	})

	const defaultPkceEnv = createEnv()
	const defaultResult = await integrationSaveCapability.handler(
		{
			name: 'spotify-default',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			flow: 'pkce',
			usePkce: true,
			clientId: 'spotify-client-id-value',
			requiredHosts: ['api.spotify.com'],
		},
		ctx(defaultPkceEnv.env, 'user-789'),
	)
	expect(defaultResult.integration.flow).toBe('pkce')
	expect(defaultResult.integration.usePkce).toBeUndefined()

	await expect(
		integrationSaveCapability.handler(
			{
				name: 'spotify',
				flow: 'pkce',
				clientId: 'spotify-client-id-value',
			},
			ctx(createEnv().env, 'user-123'),
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			/missing or invalid required fields/i.test(error.message),
	)

	await expect(
		integrationSaveCapability.handler(
			{
				name: '._-',
				tokenUrl: 'https://example.com/token',
				flow: 'pkce',
				clientId: 'x-client-id',
			},
			ctx(createEnv().env, 'user-123'),
		),
	).rejects.toThrow(/letters or numbers/i)
})

test('integrationSave reuses an existing app when credentials match and preserves unspecified fields on partial update', async () => {
	const { env } = createEnv()
	const userId = ownerIdFromStored('user-reuse')

	await integrationSaveCapability.handler(googleBase, ctx(env, userId))
	await integrationSaveCapability.handler(
		{
			...googleBase,
			name: 'google-calendar',
			authorization: {
				...googleBase.authorization,
				scopes: ['calendar.readonly'],
			},
			requiredHosts: ['www.googleapis.com'],
		},
		ctx(env, userId),
	)

	const apps = await integrationOauthAppListCapability.handler(
		{},
		ctx(env, userId),
	)
	expect(apps.apps).toHaveLength(1)
	expect(apps.apps[0]).toMatchObject({
		slug: 'google',
		connectionCount: 2,
		clientId: 'google-client-id-value',
		hasClientSecret: false,
	})
	expect(apps.apps[0]?.connections.map((entry) => entry.name).sort()).toEqual([
		'google',
		'google-calendar',
	])

	const partial = await integrationSaveCapability.handler(
		{
			name: 'google',
			apiBaseUrl: 'https://www.googleapis.com/v2',
		},
		ctx(env, userId),
	)
	expect(partial.integration).toMatchObject({
		apiBaseUrl: 'https://www.googleapis.com/v2',
		clientId: 'google-client-id-value',
		requiredHosts: ['accounts.google.com', 'www.googleapis.com'],
		authorization: {
			scopes: ['openid', 'email'],
		},
	})

	await expect(
		integrationSaveCapability.handler(
			{
				name: 'google',
				requiredHosts: [
					'accounts.google.com',
					'www.googleapis.com',
					'attacker.example',
				],
			},
			ctx(env, userId),
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.message.includes('Cannot add required hosts (attacker.example)'),
	)
	await expect(
		integrationSaveCapability.handler(
			{
				name: 'google',
				tokenUrl: 'https://attacker.example/token',
			},
			ctx(env, userId),
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.message.includes(
				'Cannot point tokenUrl at host "attacker.example"',
			),
	)
	const sameHost = await integrationSaveCapability.handler(
		{
			name: 'google',
			tokenUrl: 'https://oauth2.googleapis.com/oauth/token',
		},
		ctx(env, userId),
	)
	expect(sameHost.integration.tokenUrl).toBe(
		'https://oauth2.googleapis.com/oauth/token',
	)
})

test('integrationDelete and credential rotation return the expected MCP response shapes', async () => {
	const { env } = createEnv()
	const as = ctx(env, 'user-rotate')
	const saveGoogleAndMail = async () => {
		await integrationSaveCapability.handler(googleBase, as)
		await integrationSaveCapability.handler(
			{ ...googleBase, name: 'google-mail' },
			as,
		)
	}
	await saveGoogleAndMail()

	const rotated = await integrationOauthAppRotateCredentialsCapability.handler(
		{ slug: 'google', clientId: 'google-client-id-rotated' },
		as,
	)
	expect(rotated.app).toMatchObject({
		slug: 'google',
		clientId: 'google-client-id-rotated',
		hasClientSecret: false,
		connectionCount: 2,
	})

	await expect(
		integrationDeleteCapability.handler({ name: 'google-mail' }, as),
	).resolves.toEqual({ deleted: true })
	const afterDelete = await integrationListCapability.handler({}, as)
	expect(afterDelete.integrations.map((entry) => entry.name)).toEqual([
		'google',
	])
	await expect(
		integrationDeleteCapability.handler({ name: 'google' }, as),
	).resolves.toEqual({ deleted: true })
	await expect(
		integrationOauthAppListCapability.handler({}, as),
	).resolves.toEqual({ apps: [] })

	await saveGoogleAndMail()
	await expect(
		integrationOauthAppDeleteCapability.handler({ slug: 'google' }, as),
	).resolves.toEqual({
		deleted: true,
		connectionNames: ['google', 'google-mail'],
	})
	await expect(
		integrationOauthAppListCapability.handler({}, as),
	).resolves.toEqual({ apps: [] })
})

test('integration capabilities deny cross-user reads and require authentication', async () => {
	const { env } = createEnv()
	await integrationSaveCapability.handler(spotifyBase, ctx(env, 'user-a'))

	const userB = ctx(env, 'user-b')
	await expect(integrationListCapability.handler({}, userB)).resolves.toEqual({
		integrations: [],
	})
	await expect(
		integrationGetCapability.handler({ name: 'spotify' }, userB),
	).resolves.toMatchObject({ integration: null })
	await expect(
		integrationDeleteCapability.handler({ name: 'spotify' }, userB),
	).resolves.toEqual({ deleted: false })
	const stillThere = await integrationGetCapability.handler(
		{ name: 'spotify' },
		ctx(env, 'user-a'),
	)
	expect(stillThere.integration?.name).toBe('spotify')

	await expect(
		integrationSaveCapability.handler(spotifyBase, {
			env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://heykody.dev',
			}),
		}),
	).rejects.toThrow('Authenticated MCP user is required for this capability.')
})

test('integrationSave refuses platform (built-in) connections and persists accountLabel on user-lane connections', async () => {
	const { env } = createEnv()
	const as = ctx(env, 'user-123')
	await upsertPlatformOauthApp({
		db: env.APP_DB,
		env,
		app: {
			slug: 'github',
			clientId: 'platform-github-client-id',
			clientSecret: 'platform-github-client-secret-value',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			flow: 'confidential',
			allowedScopes: ['read:user'],
		},
	})
	await upsertPlatformIntegration({
		env,
		userId: ownerIdFromStored('user-123'),
		platformAppSlug: 'github',
		scopes: ['read:user'],
	})
	await expect(
		integrationSaveCapability.handler(
			{ name: 'github', requiredHosts: ['api.github.com'] },
			as,
		),
	).rejects.toThrow(/platform \(built-in\) connection/)
	const got = await integrationGetCapability.handler({ name: 'github' }, as)
	expect(got.integration?.platform).toBe(true)

	await integrationSaveCapability.handler(spotifyBase, as)
	await integrationSaveCapability.handler(
		{ name: 'spotify', accountLabel: 'me@kentcdodds.com' },
		as,
	)
	const joined = await getJoinedIntegration({
		env,
		userId: ownerIdFromStored('user-123'),
		name: 'spotify',
	})
	expect(joined?.connection.accountLabel).toBe('me@kentcdodds.com')
})
