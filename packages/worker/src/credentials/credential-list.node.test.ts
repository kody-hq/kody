import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personalOrgId,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { expect, test } from 'vitest'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { saveSecret } from '#mcp/secrets/service.ts'
import { type CredentialListItem } from '#universal/credential-contracts.ts'
import { findCredentialIdsByLegacyName } from './credential-ids.ts'
import {
	filterCredentialList,
	readCredentialListFilters,
} from '#universal/credentials-list.ts'
import { listCredentialsForViewer } from './credential-list.ts'
import { grantPersonalCredentialToOrg } from './personal-credentials.ts'

const now = '2026-10-13T00:00:00.000Z'

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const env = {
		APP_DB: db,
		...createInMemoryUserMeterEnv().env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	const person = (username: string) => {
		const stableUserId = testStableUserIdFromEmail(`${username}@example.com`)
		return { stableUserId, personId: personIdFromStored(stableUserId) }
	}
	const ann = person('ann')
	const bea = person('bea')
	for (const [username, who] of [
		['ann', ann],
		['bea', bea],
	] as const) {
		await provisionPersonalOrg(db, {
			stableUserId: who.stableUserId,
			username,
			createdAt: now,
		})
	}
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: bea.personId,
			audit: createTestOrgAuditWriter(),
			slug: 'quillworks-co',
			displayName: 'Acme',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const acme = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'quillworks-co'`)
		.first<{ id: string }>()
	const acmeId = ownerIdFromStored(acme!.id)
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(acmeId, ann.stableUserId, now)
		.run()

	await saveSecret({
		env,
		userId: acmeId,
		scope: 'user',
		name: 'stripeKey',
		value: 'sk-value',
		description: 'Stripe billing',
	})
	sqlite
		.prepare(
			`UPDATE secret_entries SET allowed_hosts = '["api.stripe.com"]' WHERE name = 'stripeKey'`,
		)
		.run()
	await saveSecret({
		env,
		userId: acmeId,
		scope: 'package',
		name: 'packageToken',
		value: 'pkg-value',
		storageContext: {
			sessionId: null,
			appId: null,
			packageId: 'pkg-1',
			storageId: 'pkg-1',
		},
	})
	sqlite
		.prepare(
			`INSERT INTO user_oauth_apps (user_id, slug, provider, client_id, token_url, flow, api_base_url)
			 VALUES (?, 'gh-app', 'github', 'client', 'https://github.com/token', 'confidential', 'https://api.github.com')`,
		)
		.run(acmeId)
	sqlite
		.prepare(
			`INSERT INTO user_integrations (id, user_id, name, app_slug, access_token_encrypted, connected_at)
			 VALUES ('i-github', ?, 'github', 'gh-app', 'ct', ?)`,
		)
		.run(acmeId, now)
	sqlite
		.prepare(
			`INSERT INTO mcp_server_settings (id, user_id, name, url, enabled, last_error)
			 VALUES ('mcp-linear', ?, 'linear', 'https://mcp.linear.app/sse', 1, 'boom')`,
		)
		.run(acmeId)

	const annOrgId = personalOrgId(ann.personId)
	await saveSecret({
		env,
		userId: annOrgId,
		scope: 'user',
		name: 'annToken',
		value: 'ann-value',
	})
	const annTokenId = (
		await findCredentialIdsByLegacyName(db, annOrgId, {
			type: 'secret',
			name: 'annToken',
		})
	)[0]!
	await grantPersonalCredentialToOrg({
		db,
		ownerPersonId: ann.personId,
		credentialId: annTokenId,
		orgId: acmeId,
	})

	const requestAs = (
		who: typeof ann,
		role: OrgRole,
		scopes: Array<string> | null = null,
	) =>
		deriveRequestContext({
			user: { userId: who.personId },
			source: scopes
				? { kind: 'api-token', tokenId: 'token-1' }
				: { kind: 'session' },
			orgBinding: { org: { id: acmeId, slug: 'quillworks-co' }, role },
			scopes: scopes as never,
		})
	const stripeKeyId = (
		await findCredentialIdsByLegacyName(db, acmeId, {
			type: 'secret',
			name: 'stripeKey',
		})
	)[0]!
	const grantToAnn = (credentialId: string, permissions: Array<string>) => {
		const insertPermission = sqlite.prepare(
			`INSERT INTO grant_permissions (grant_id, permission) VALUES (?, ?)`,
		)
		for (const permission of permissions) {
			insertPermission.run(`grant-${credentialId}`, permission)
		}
		sqlite
			.prepare(
				`INSERT INTO grants (id, org_id, resource_type, resource_id, subject_type,
				   subject_id, preset, created_by_user_id, created_at, updated_at)
				 VALUES (?, ?, 'credential', ?, 'user', ?, 'use', ?, ?, ?)`,
			)
			.run(
				`grant-${credentialId}`,
				acmeId,
				credentialId,
				ann.personId,
				bea.personId,
				now,
				now,
			)
		sqlite
			.prepare(`UPDATE orgs SET access_epoch = access_epoch + 1 WHERE id = ?`)
			.run(acmeId)
	}
	return {
		env,
		sqlite,
		ann,
		bea,
		annOrgId,
		acmeId,
		annTokenId,
		stripeKeyId,
		requestAs,
		grantToAnn,
	}
}

const summary = (items: Array<CredentialListItem>) =>
	items.map((item) => `${item.scope}:${item.kind}:${item.name}`)

test('lists Keys, OAuth integrations, and MCP servers as one shape', async () => {
	const t = await setup()
	const beaItems = await listCredentialsForViewer({
		env: t.env,
		request: t.requestAs(t.bea, 'owner'),
	})
	expect(summary(beaItems)).toEqual([
		'org:oauth:github',
		'org:mcp:linear',
		'org:secret:packageToken',
		'org:secret:stripeKey',
	])
	const byName = Object.fromEntries(beaItems.map((item) => [item.name, item]))
	expect(byName.stripeKey).toMatchObject({
		description: 'Stripe billing',
		hosts: ['api.stripe.com'],
		packageId: null,
		status: 'ok',
		mcp: null,
	})
	expect(byName.packageToken).toMatchObject({ packageId: 'pkg-1' })
	expect(byName.github).toMatchObject({
		provider: 'github',
		hosts: ['api.github.com'],
		inject: { kind: 'header', name: 'Authorization', format: 'Bearer {value}' },
		status: 'ok',
	})
	expect(byName.linear).toMatchObject({
		hosts: ['mcp.linear.app'],
		status: 'needs_attention',
		mcp: { url: 'https://mcp.linear.app/sse', enabled: true },
	})
	expect(JSON.stringify(beaItems)).not.toMatch(/sk-value|ann-value|pkg-value/)
	expect(byName.stripeKey?.placement).toBeNull()
	expect(byName.github?.placement).toBeNull()
	expect(byName.linear?.placement).toBeNull()
})

test('listCredentialsForViewer preserves non-null fill placement on Keys and OAuth', async () => {
	const t = await setup()
	t.sqlite
		.prepare(
			`UPDATE secret_entries SET placement_json = ? WHERE name = 'stripeKey'`,
		)
		.run(JSON.stringify({ headers: true, body: true }))
	t.sqlite
		.prepare(
			`UPDATE user_integrations SET placement_json = ? WHERE id = 'i-github'`,
		)
		.run(JSON.stringify({ headers: ['Authorization'] }))
	const beaItems = await listCredentialsForViewer({
		env: t.env,
		request: t.requestAs(t.bea, 'owner'),
	})
	const byName = Object.fromEntries(beaItems.map((item) => [item.name, item]))
	expect(byName.stripeKey?.placement).toEqual({ headers: true, body: true })
	expect(byName.github?.placement).toEqual({ headers: ['Authorization'] })
	expect(byName.linear?.placement).toBeNull()
})

test('a member sees the org credentials granted to them plus their own granted personal ones', async () => {
	const t = await setup()
	const annItems = () =>
		listCredentialsForViewer({
			env: t.env,
			request: t.requestAs(t.ann, 'member'),
		})
	expect(summary(await annItems())).toEqual(['personal:secret:annToken'])
	expect((await annItems())[0]).toMatchObject({ id: t.annTokenId })
	t.grantToAnn(t.stripeKeyId, ['secret:use'])
	t.grantToAnn('i-github', ['integration:use', 'integration:read'])
	expect(summary(await annItems())).toEqual([
		'personal:secret:annToken',
		'org:oauth:github',
		'org:secret:stripeKey',
	])
})

test('a scoped token without secret Use drops personal Keys', async () => {
	const t = await setup()
	const items = await listCredentialsForViewer({
		env: t.env,
		request: t.requestAs(t.ann, 'member', [
			'secret:use',
			'integration:read',
			'integration:use',
		]),
	})
	expect(summary(items)).toContain('personal:secret:annToken')
	const withoutSecretUse = await listCredentialsForViewer({
		env: t.env,
		request: t.requestAs(t.ann, 'member', ['secret:read', 'integration:read']),
	})
	expect(summary(withoutSecretUse)).not.toContain('personal:secret:annToken')
})

test('a package Key needs package read, not just org-wide secret Use', async () => {
	const t = await setup()
	const items = await listCredentialsForViewer({
		env: t.env,
		request: t.requestAs(t.bea, 'owner', ['secret:use']),
	})
	expect(summary(items)).toEqual(['org:secret:stripeKey'])
})

test('OAuth status is ok when connected, needs attention when not connected or auth failed', async () => {
	const t = await setup()
	t.sqlite
		.prepare(
			`INSERT INTO user_integrations (id, user_id, name, app_slug, access_token_encrypted, connected_at)
			 VALUES ('i-pending', ?, 'pending-oauth', 'gh-app', 'ct', NULL)`,
		)
		.run(t.acmeId)
	t.sqlite
		.prepare(
			`INSERT INTO user_integrations (id, user_id, name, app_slug, access_token_encrypted, connected_at, auth_failed_at, auth_failed_reason)
			 VALUES ('i-failed', ?, 'failed-oauth', 'gh-app', 'ct', ?, ?, 'provider_rejected')`,
		)
		.run(t.acmeId, now, now)
	const items = await listCredentialsForViewer({
		env: t.env,
		request: t.requestAs(t.bea, 'owner'),
	})
	const byName = Object.fromEntries(items.map((item) => [item.name, item]))
	expect(byName.github).toMatchObject({ status: 'ok', statusMessage: null })
	expect(byName['pending-oauth']).toMatchObject({
		status: 'needs_attention',
		statusMessage: 'Not connected yet.',
	})
	expect(byName['failed-oauth']).toMatchObject({
		status: 'needs_attention',
		statusMessage: 'Reconnect needed (provider_rejected).',
	})
})

test('a Key in an expired bucket shows as expired at the bucket expiry', async () => {
	const t = await setup()
	const bucketExpiry = '2026-10-01T00:00:00.000Z'
	t.sqlite
		.prepare(
			`UPDATE secret_buckets SET expires_at = ?
			 WHERE id = (SELECT bucket_id FROM secret_entries WHERE id = ?)`,
		)
		.run(bucketExpiry, t.stripeKeyId)
	const items = await listCredentialsForViewer({
		env: t.env,
		request: t.requestAs(t.bea, 'owner'),
		now: new Date(now),
	})
	expect(items.find((item) => item.name === 'stripeKey')).toMatchObject({
		status: 'expired',
		expiresAt: bucketExpiry,
	})
})

test('lists more granted personal credentials than one D1 statement can bind', async () => {
	const t = await setup()
	t.sqlite
		.prepare(
			`INSERT INTO user_oauth_apps (user_id, slug, provider, client_id, token_url, flow, api_base_url)
			 VALUES (?, 'ann-app', 'github', 'client', 'https://github.com/token', 'confidential', 'https://api.github.com')`,
		)
		.run(t.annOrgId)
	const insertIntegration = t.sqlite.prepare(
		`INSERT INTO user_integrations (id, user_id, name, app_slug, access_token_encrypted, connected_at)
		 VALUES (?, ?, ?, 'ann-app', 'ct', ?)`,
	)
	for (let index = 0; index < 120; index++) {
		const id = `i-ann-${index}`
		insertIntegration.run(id, t.annOrgId, `annGithub${index}`, now)
		await grantPersonalCredentialToOrg({
			db: t.env.APP_DB,
			ownerPersonId: t.ann.personId,
			credentialId: id,
			orgId: t.acmeId,
		})
	}
	const items = await listCredentialsForViewer({
		env: t.env,
		request: t.requestAs(t.ann, 'member'),
	})
	expect(items.filter((item) => item.scope === 'personal')).toHaveLength(121)
})

test('a granted personal MCP server is not listed; credential() cannot use it', async () => {
	const t = await setup()
	t.sqlite
		.prepare(
			`INSERT INTO mcp_server_settings (id, user_id, name, url, enabled)
			 VALUES ('mcp-ann', ?, 'annMcp', 'https://mcp.example.com/sse', 1)`,
		)
		.run(t.annOrgId)
	await grantPersonalCredentialToOrg({
		db: t.env.APP_DB,
		ownerPersonId: t.ann.personId,
		credentialId: 'mcp-ann',
		orgId: t.acmeId,
	})
	const items = await listCredentialsForViewer({
		env: t.env,
		request: t.requestAs(t.ann, 'member'),
	})
	expect(summary(items)).toEqual(['personal:secret:annToken'])
})

test('filters by text, kind, scope, package scope, and package lock', async () => {
	const t = await setup()
	const items = [
		...(await listCredentialsForViewer({
			env: t.env,
			request: t.requestAs(t.bea, 'owner'),
		})),
		...(await listCredentialsForViewer({
			env: t.env,
			request: t.requestAs(t.ann, 'member'),
		})),
	]
	const names = (filtered: Array<CredentialListItem>) =>
		filtered.map((item) => item.name)
	expect(names(filterCredentialList(items, { q: 'STRIPE' }))).toEqual([
		'stripeKey',
	])
	expect(names(filterCredentialList(items, { q: 'linear.app' }))).toEqual([
		'linear',
	])
	expect(
		names(filterCredentialList(items, { kinds: ['mcp', 'oauth'] })),
	).toEqual(['github', 'linear'])
	expect(names(filterCredentialList(items, { scope: 'personal' }))).toEqual([
		'annToken',
	])
	expect(names(filterCredentialList(items, { packageScoped: true }))).toEqual([
		'packageToken',
	])
	expect(filterCredentialList(items, { locked: true })).toEqual([])
	const locked = items.map((item) =>
		item.name === 'github' ? { ...item, lockedToPackageIds: ['pkg-2'] } : item,
	)
	expect(names(filterCredentialList(locked, { locked: 'pkg-2' }))).toEqual([
		'github',
	])
	expect(names(filterCredentialList(locked, { locked: 'pkg-3' }))).toEqual([])
})

test('reads list filters from a query string', () => {
	expect(
		readCredentialListFilters(
			new URLSearchParams(
				'q=+stripe+&kind=secret&kind=bogus&kind=mcp&scope=org&packageScoped=false&locked=pkg-1',
			),
		),
	).toEqual({
		q: 'stripe',
		kinds: ['secret', 'mcp'],
		scope: 'org',
		packageScoped: false,
		locked: 'pkg-1',
	})
	expect(
		readCredentialListFilters(new URLSearchParams('scope=x&locked=true')),
	).toEqual({ locked: true })
	expect(readCredentialListFilters(new URLSearchParams(''))).toEqual({})
})
