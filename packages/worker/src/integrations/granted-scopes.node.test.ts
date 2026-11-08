import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { recordConnectGrantedScopes } from '#worker/integrations/connect-oauth-persist.ts'
import { upsertPlatformOauthApp } from '#worker/integrations/platform-apps.ts'
import {
	getIntegration,
	upsertPlatformIntegration,
} from '#worker/integrations/service.ts'
import {
	compareRequestedAndGrantedScopes,
	parseScopeList,
	readGrantedScopes,
} from './granted-scopes.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const github = {
	provider: 'github',
	tokenUrl: 'https://github.com/login/oauth/access_token',
}

function githubResponse(scopes: string | null, status = 200) {
	const headers = new Headers()
	if (scopes != null) headers.set('X-OAuth-Scopes', scopes)
	return new Response('{}', { status, headers })
}

async function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		AUDIT_DB: createAuditTestDb(),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	await upsertPlatformOauthApp({
		db: env.APP_DB,
		env,
		app: {
			slug: 'github',
			provider: 'github',
			clientId: 'platform-github-client-id',
			clientSecret: 'platform-github-client-secret-value',
			tokenUrl: github.tokenUrl,
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			flow: 'confidential',
			allowedScopes: ['repo', 'read:user', 'gist', 'workflow'],
			defaultScopes: ['repo', 'read:user'],
		},
	})
	return env
}

test('scope lists parse comma and space separated grants', () => {
	expect(parseScopeList('repo, read:user,gist')).toEqual([
		'gist',
		'read:user',
		'repo',
	])
	expect(parseScopeList('openid email  email')).toEqual(['email', 'openid'])
	expect(parseScopeList('')).toEqual([])
	expect(parseScopeList(undefined)).toBeNull()
	expect(
		compareRequestedAndGrantedScopes(['repo', 'gist'], ['repo', 'workflow']),
	).toEqual({ missing: ['gist'], extra: ['workflow'] })
})

test('GitHub grants come from X-OAuth-Scopes on a read, never a revoke', async () => {
	const fetchImpl = vi.fn(async () => githubResponse('repo, read:user'))
	const granted = await readGrantedScopes({
		app: github,
		accessToken: 'gho_test_only',
		tokenRecord: { scope: 'repo,read:user,gist' },
		fetchImpl,
		now: () => new Date('2026-11-07T00:00:00.000Z'),
	})
	expect(granted).toEqual({
		scopes: ['read:user', 'repo'],
		source: 'github-x-oauth-scopes',
		checkedAt: '2026-11-07T00:00:00.000Z',
	})
	expect(fetchImpl).toHaveBeenCalledTimes(1)
	const [url, init] = fetchImpl.mock.calls[0] as unknown as [
		string,
		RequestInit,
	]
	expect(url).toBe('https://api.github.com/user')
	expect(init.method).toBe('GET')
	expect(url).not.toContain('/applications/')
})

test('falls back to the token response scope, or unknown', async () => {
	const failing = vi.fn(async () => githubResponse(null, 401))
	expect(
		await readGrantedScopes({
			app: github,
			accessToken: 'gho_test_only',
			tokenRecord: { scope: 'repo' },
			fetchImpl: failing,
		}),
	).toMatchObject({ scopes: ['repo'], source: 'token-response' })
	const notGithub = vi.fn()
	expect(
		await readGrantedScopes({
			app: {
				provider: 'google',
				tokenUrl: 'https://oauth2.googleapis.com/token',
			},
			accessToken: 'ya29.test_only',
			tokenRecord: {},
			fetchImpl: notGithub,
		}),
	).toBeNull()
	expect(notGithub).not.toHaveBeenCalled()
})

test('a connect records the actual grant on one connection and reports mismatches', async () => {
	const env = await createEnv()
	const owner = ownerIdFromStored('user-123')
	for (const [name, scopes] of [
		['github', ['repo', 'gist']],
		['github-work', ['repo', 'read:user', 'workflow']],
	] as const) {
		await upsertPlatformIntegration({
			env,
			userId: owner,
			platformAppSlug: 'github',
			name,
			scopes: [...scopes],
			audit: null,
		})
	}
	const fetchImpl = vi.fn(async () => githubResponse('repo, workflow'))
	const grant = await recordConnectGrantedScopes({
		env,
		userId: owner,
		name: 'github',
		app: github,
		accessToken: 'gho_test_only',
		tokenRecord: {},
		requestedScopes: ['repo', 'gist'],
		fetchImpl,
	})
	expect(grant).toEqual({
		requested: ['repo', 'gist'],
		granted: ['repo', 'workflow'],
		source: 'github-x-oauth-scopes',
		missing: ['gist'],
		extra: ['workflow'],
	})
	const saved = await getIntegration({ env, userId: owner, name: 'github' })
	expect(saved?.grantedScopes).toMatchObject({
		scopes: ['repo', 'workflow'],
		missing: ['gist'],
		extra: ['workflow'],
	})
	const sibling = await getIntegration({
		env,
		userId: owner,
		name: 'github-work',
	})
	expect(sibling?.grantedScopes).toBeUndefined()
	expect(sibling?.authorization?.scopes).toEqual([
		'repo',
		'read:user',
		'workflow',
	])
	expect(
		fetchImpl.mock.calls.every(
			(call) => (call as unknown as [string, RequestInit])[1].method === 'GET',
		),
	).toBe(true)
})
