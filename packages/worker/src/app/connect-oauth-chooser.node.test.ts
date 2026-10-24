import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { upsertPlatformOauthApp } from '#worker/integrations/platform-apps.ts'
import {
	upsertIntegration,
	upsertPlatformIntegration,
} from '#worker/integrations/service.ts'
import { loadConnectOauthChooser } from './connect-oauth-chooser.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	return { APP_DB: createD1FromSqlite(sqlite) } as Env
}

test('connect chooser includes saved connections and hides unused built-ins', async () => {
	const env = createEnv()
	const platformEnv = {
		...env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as Env
	await upsertPlatformOauthApp({
		db: env.APP_DB,
		env: platformEnv,
		app: {
			slug: 'google',
			label: 'Google',
			clientId: 'platform-google-client',
			clientSecret: 'platform-google-secret',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			flow: 'confidential',
			defaultScopes: ['openid'],
			allowedScopes: ['openid', 'email'],
		},
	})
	await upsertPlatformOauthApp({
		db: env.APP_DB,
		env: platformEnv,
		app: {
			slug: 'github',
			label: 'GitHub',
			clientId: 'platform-github-client',
			clientSecret: 'platform-github-secret',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			flow: 'confidential',
			defaultScopes: ['read:user'],
		},
	})
	await upsertPlatformIntegration({
		env,
		userId: ownerIdFromStored('user-chooser'),
		platformAppSlug: 'github',
		name: 'github',
		scopes: ['read:user'],
		audit: null,
	})
	await upsertIntegration({
		env,
		userId: ownerIdFromStored('user-chooser'),
		config: {
			name: 'spotify-home',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			flow: 'pkce',
			clientId: 'spotify-client',
			requiredHosts: ['accounts.spotify.com'],
			authorization: {
				authorizeUrl: 'https://accounts.spotify.com/authorize',
				scopes: ['user-read-email'],
				scopeSeparator: null,
				extraAuthorizeParams: {},
			},
		},
		audit: null,
	})

	const chooser = await loadConnectOauthChooser({
		env,
		userId: ownerIdFromStored('user-chooser'),
	})
	expect(chooser.options.map((option) => option.id)).toEqual([
		'connection:github',
		'connection:spotify-home',
	])
	expect(
		chooser.options.find((option) => option.id === 'connection:spotify-home'),
	).toMatchObject({
		href: '/connect/oauth?provider=spotify-home&app=spotify-home',
		kind: 'connection',
	})
	expect(
		chooser.options.find((option) => option.id === 'connection:github'),
	).toMatchObject({
		href: '/connect/oauth?provider=github',
		kind: 'connection',
	})

	const publish = (app: Parameters<typeof upsertPlatformOauthApp>[0]['app']) =>
		upsertPlatformOauthApp({ db: env.APP_DB, env: platformEnv, app })
	await publish({
		slug: 'google',
		clientId: 'platform-google-client',
		tokenUrl: 'https://oauth2.googleapis.com/token',
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		flow: 'confidential',
		visibility: 'published',
	})
	await publish({
		slug: 'github',
		clientId: 'platform-github-client',
		tokenUrl: 'https://github.com/login/oauth/access_token',
		authorizeUrl: 'https://github.com/login/oauth/authorize',
		flow: 'confidential',
		visibility: 'published',
	})
	await publish({
		slug: 'notion',
		label: 'Notion',
		clientId: 'platform-notion-client',
		clientSecret: 'platform-notion-secret',
		tokenUrl: 'https://api.notion.com/v1/oauth/token',
		authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
		flow: 'confidential',
		enabled: false,
		visibility: 'published',
	})

	const published = await loadConnectOauthChooser({
		env,
		userId: ownerIdFromStored('user-chooser'),
	})
	// Published + enabled only: disabled notion stays hidden, and the
	// already-connected github is a reconnect rather than a new option.
	expect(published.options.map((option) => option.id)).toEqual([
		'connection:github',
		'connection:spotify-home',
		'platform:google',
	])
	expect(
		published.options.find((option) => option.id === 'connection:github'),
	).toMatchObject({ kind: 'connection' })
	expect(
		published.options.find((option) => option.id === 'platform:google'),
	).toMatchObject({
		href: '/connect/oauth?provider=google&platform=google',
		kind: 'platform',
		label: 'Google',
	})
})
