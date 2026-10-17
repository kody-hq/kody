import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { type AuthRequest } from '@cloudflare/workers-oauth-provider'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { isOrgAuthorizeError } from './authorize-error.ts'
import {
	resolveAccessibleOrgBySlug,
	resolveAuthorizeOrg,
	selectConsentOrg,
	selectConsentOrgsForLoader,
	stripLoginFromAuthorizePrompt,
} from './oauth-authorize.ts'
import { ensureOrgsTestSchema } from './orgs-test-schema.ts'
import { provisionPersonalOrg } from './provision.ts'

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	return db
}

function authRequest(resource?: string): AuthRequest {
	return {
		responseType: 'code',
		clientId: 'client-1',
		redirectUri: 'https://example.com/callback',
		scope: ['profile'],
		state: 'demo',
		resource,
	}
}

test('resolveAuthorizeOrg mismatches authorize URL and resource slugs', async () => {
	const db = await createDb()
	const userId = testStableUserIdFromEmail('ada@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: userId,
		username: 'ada',
		createdAt: '2026-01-02T00:00:00.000Z',
	})
	const request = new Request('https://kody.codes/oauth/authorize?org=ada')
	await expect(
		resolveAuthorizeOrg({
			env: { APP_DB: db } as Env,
			request,
			authRequest: authRequest('https://kody.codes/mcp?org=gus'),
			userId,
		}),
	).rejects.toSatisfy(
		(error: unknown) =>
			isOrgAuthorizeError(error) && error.message.includes('do not match'),
	)
})

test('resolveAuthorizeOrg resolves a matching slug and strips org from resource', async () => {
	const db = await createDb()
	const userId = testStableUserIdFromEmail('ada@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: userId,
		username: 'ada',
		createdAt: '2026-01-02T00:00:00.000Z',
	})
	const request = authRequest('https://kody.codes/mcp?org=ada&profile=ci')
	const resolved = await resolveAuthorizeOrg({
		env: { APP_DB: db } as Env,
		request: new Request('https://kody.codes/oauth/authorize?org=Ada'),
		authRequest: request,
		userId,
	})
	expect(resolved).toEqual({ orgId: userId, slug: 'ada' })
	expect(request.resource).toBe('https://kody.codes/mcp?profile=ci')
})

test('resolveAuthorizeOrg returns null when no org is requested', async () => {
	const db = await createDb()
	const userId = testStableUserIdFromEmail('ada@example.com')
	expect(
		await resolveAuthorizeOrg({
			env: { APP_DB: db } as Env,
			request: new Request('https://kody.codes/oauth/authorize'),
			authRequest: authRequest('https://kody.codes/mcp'),
			userId,
		}),
	).toBeNull()
})

test('resolveAccessibleOrgBySlug rejects unknown or inaccessible slugs', async () => {
	const db = await createDb()
	const ada = testStableUserIdFromEmail('ada@example.com')
	const gus = testStableUserIdFromEmail('gus@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada',
		createdAt: '2026-01-02T00:00:00.000Z',
	})
	await provisionPersonalOrg(db, {
		stableUserId: gus,
		username: 'gus',
		createdAt: '2026-01-02T00:00:00.000Z',
	})
	await expect(
		resolveAccessibleOrgBySlug({ db, userId: ada, slug: 'missing' }),
	).rejects.toSatisfy(
		(error: unknown) =>
			isOrgAuthorizeError(error) && error.message.includes('@missing'),
	)
	await expect(
		resolveAccessibleOrgBySlug({ db, userId: ada, slug: 'gus' }),
	).rejects.toSatisfy(
		(error: unknown) =>
			isOrgAuthorizeError(error) && error.message.includes('@gus'),
	)
	await expect(
		resolveAccessibleOrgBySlug({ db, userId: ada, slug: 'ada' }),
	).resolves.toEqual({ orgId: ada, slug: 'ada' })
})

test('selectConsentOrg uses form, then URL, then the sole org', async () => {
	const db = await createDb()
	const ada = testStableUserIdFromEmail('ada@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada',
		createdAt: '2026-01-02T00:00:00.000Z',
	})
	expect(
		await selectConsentOrg({
			db,
			userId: ada,
			formSlug: 'ada',
			urlOrg: null,
		}),
	).toEqual({ orgId: ada, slug: 'ada' })
	expect(
		await selectConsentOrg({
			db,
			userId: ada,
			formSlug: null,
			urlOrg: { orgId: ada, slug: 'ada' },
		}),
	).toEqual({ orgId: ada, slug: 'ada' })
	expect(
		await selectConsentOrg({
			db,
			userId: ada,
			formSlug: null,
			urlOrg: null,
		}),
	).toEqual({ orgId: ada, slug: 'ada' })
	expect(
		await selectConsentOrg({
			db,
			userId: ada,
			formSlug: 'ada',
			urlOrg: { orgId: ada, slug: 'ada' },
		}),
	).toEqual({ orgId: ada, slug: 'ada' })
})

test('selectConsentOrg rejects form slug that disagrees with ?org=', async () => {
	const db = await createDb()
	const ada = testStableUserIdFromEmail('ada@example.com')
	const gus = testStableUserIdFromEmail('gus@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada',
		createdAt: '2026-01-02T00:00:00.000Z',
	})
	await provisionPersonalOrg(db, {
		stableUserId: gus,
		username: 'gus',
		createdAt: '2026-01-02T00:00:00.000Z',
	})
	await db
		.prepare(
			`INSERT INTO org_memberships (user_id, org_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(ada, gus, '2026-01-02T00:00:00.000Z')
		.run()
	await expect(
		selectConsentOrg({
			db,
			userId: ada,
			formSlug: 'ada',
			urlOrg: { orgId: gus, slug: 'gus' },
		}),
	).rejects.toSatisfy(
		(error: unknown) =>
			isOrgAuthorizeError(error) && error.message.includes('do not match'),
	)
})

test('selectConsentOrgsForLoader auto-selects a sole org and keeps multi unspecified', () => {
	const ada = {
		id: 'ada-id',
		slug: 'ada',
		display_name: 'Ada',
		avatar_key: null,
		plan: 'free',
		entitlement_ladder: 'public',
		role: 'owner' as const,
	}
	const acme = {
		id: 'acme-id',
		slug: 'acme',
		display_name: 'Acme',
		avatar_key: null,
		plan: 'pro',
		entitlement_ladder: 'public',
		role: 'member' as const,
	}
	expect(selectConsentOrgsForLoader([ada], null)).toEqual({
		orgs: [{ slug: 'ada', displayName: 'Ada', role: 'owner' }],
		selectedOrgSlug: 'ada',
	})
	expect(selectConsentOrgsForLoader([ada, acme], null)).toEqual({
		orgs: [
			{ slug: 'ada', displayName: 'Ada', role: 'owner' },
			{ slug: 'acme', displayName: 'Acme', role: 'member' },
		],
		selectedOrgSlug: null,
	})
	expect(selectConsentOrgsForLoader([ada, acme], 'ACME')).toEqual({
		orgs: [
			{ slug: 'ada', displayName: 'Ada', role: 'owner' },
			{ slug: 'acme', displayName: 'Acme', role: 'member' },
		],
		selectedOrgSlug: 'acme',
	})
})

test('stripLoginFromAuthorizePrompt drops login and id_token_hint, keeps other prompts', () => {
	expect(
		stripLoginFromAuthorizePrompt(
			'https://kody.codes/oauth/authorize?client_id=c&prompt=login',
		),
	).toBe('https://kody.codes/oauth/authorize?client_id=c')
	expect(
		stripLoginFromAuthorizePrompt(
			'https://kody.codes/oauth/authorize?prompt=login%20consent&state=s',
		),
	).toBe('https://kody.codes/oauth/authorize?prompt=consent&state=s')
	expect(
		stripLoginFromAuthorizePrompt(
			'https://kody.codes/oauth/authorize?prompt=consent',
		),
	).toBe('https://kody.codes/oauth/authorize?prompt=consent')
	expect(
		stripLoginFromAuthorizePrompt(
			'https://kody.codes/oauth/authorize?client_id=c&id_token_hint=stale',
		),
	).toBe('https://kody.codes/oauth/authorize?client_id=c')
})

test('native consent rejects explicit authorize-org conflicts independently of the RPC URL', async () => {
	const request = new Request('https://kody.codes/_serverFn/oauth?org=gus')
	await expect(
		resolveAuthorizeOrg({
			env: { APP_DB: await createDb() } as Env,
			request,
			authorizeUrl: new URL('https://kody.codes/oauth/authorize?org=ada'),
			authRequest: authRequest('https://kody.codes/mcp?org=gus'),
			userId: testStableUserIdFromEmail('ada@example.com'),
		}),
	).rejects.toSatisfy(
		(error: unknown) =>
			isOrgAuthorizeError(error) && error.message.includes('do not match'),
	)
	expect(request.url).toContain('/_serverFn/oauth?org=gus')
})
