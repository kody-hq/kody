/**
 * secretSet's opt-in credential fields (kind, hosts, login_exchange,
 * provider, inject) and credentialUpdate, against a fully migrated APP_DB.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { credentialUpdateCapability } from './credential-update.ts'
import { secretListCapability } from './secret-list.ts'
import { secretSetManyCapability } from './secret-set-many.ts'
import { secretSetCapability } from './secret-set.ts'

const now = '2026-10-12T00:00:00.000Z'
const hookUrl = 'https://hooks.example.com/services/T1/B1/hook-secret-part'

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	const db = createD1FromSqlite(sqlite)
	const auditDb = createAuditTestDb()
	const ownerId = testStableUserIdFromEmail('owner@example.com')
	const memberId = testStableUserIdFromEmail('member@example.com')
	for (const [index, [stableUserId, username]] of [
		[ownerId, 'owneruser'],
		[memberId, 'memberuser'],
	].entries()) {
		await db
			.prepare(
				`INSERT INTO users (id, username, email, password_hash, created_at, updated_at, stable_user_id)
				 VALUES (?, ?, ?, 'h', ?, ?, ?)`,
			)
			.bind(
				index + 1,
				username,
				`${username}@example.com`,
				now,
				now,
				stableUserId,
			)
			.run()
		await provisionPersonalOrg(db, {
			stableUserId: stableUserId!,
			username: username!,
			createdAt: now,
		})
	}
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(ownerId, memberId, now)
		.run()
	const env = {
		APP_DB: db,
		AUDIT_DB: auditDb,
		...createInMemoryUserMeterEnv().env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	const ctx = (
		userId: string,
		username: string,
		role: OrgRole | null,
		scopes?: Array<OrgPermission>,
	) => ({
		env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			scopes,
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored(userId),
				email: `${username}@example.com`,
				displayName: username,
				username,
			},
			orgBinding: {
				org: { id: ownerIdFromStored(ownerId), slug: 'owneruser' },
				role,
			},
		}),
	})
	const owner = ctx(ownerId, 'owneruser', 'owner')
	const member = ctx(memberId, 'memberuser', 'member')
	const ownerReadOnlyToken = ctx(ownerId, 'owneruser', 'owner', [
		'secret:read',
		'secret:use',
	])
	const entry = async (name: string) =>
		await db
			.prepare(
				`SELECT e.id, e.kind, e.allowed_hosts, e.config_json, e.provider, e.inject_json,
					e.placement_json, e.encrypted_value, e.updated_at
				 FROM secret_entries e JOIN secret_buckets b ON b.id = e.bucket_id
				 WHERE b.user_id = ? AND b.scope = 'user' AND e.name = ? AND e.deleted_at IS NULL`,
			)
			.bind(ownerId, name)
			.first<{
				id: string
				kind: string
				allowed_hosts: string
				config_json: string | null
				provider: string | null
				inject_json: string
				placement_json: string | null
				encrypted_value: string
				updated_at: string
			}>()
	const audits = async (action: string) => {
		const { results } = await auditDb
			.prepare(
				`SELECT resource_id, details_json FROM org_audit_events WHERE action = ? ORDER BY rowid`,
			)
			.bind(action)
			.all<{ resource_id: string; details_json: string }>()
		return results.map((row) => ({
			resourceId: row.resource_id,
			details: JSON.parse(row.details_json) as Record<string, unknown>,
		}))
	}
	const set = (input: Record<string, unknown>, as = owner) =>
		secretSetCapability.handler({ scope: 'user', ...input } as never, as)
	return { sqlite, owner, member, ownerReadOnlyToken, entry, audits, set }
}

test('secretSet stores a url credential with its hosts, and audits the kind', async () => {
	const t = await setup()
	const saved = await t.set({
		name: 'deploy-hook',
		value: hookUrl,
		kind: 'url',
		hosts: ['Hooks.Example.com'],
	})
	expect(saved).toMatchObject({
		name: 'deploy-hook',
		kind: 'url',
		allowed_hosts: ['hooks.example.com'],
	})
	expect(JSON.stringify(saved)).not.toContain('hook-secret-part')
	const row = await t.entry('deploy-hook')
	expect(row).toMatchObject({
		kind: 'url',
		allowed_hosts: '["hooks.example.com"]',
		config_json: null,
	})
	expect(await t.audits('credential.kind_set')).toEqual([
		{
			resourceId: row!.id,
			details: {
				kind: { before: null, after: 'url' },
				hosts: { before: null, after: ['hooks.example.com'] },
				loginExchangeHost: { before: null, after: null },
			},
		},
	])
})

test('a url value off its hosts is refused before anything is written, without echoing it', async () => {
	const t = await setup()
	const error = await t
		.set({
			name: 'deploy-hook',
			value: hookUrl,
			kind: 'url',
			hosts: ['other.example.com'],
		})
		.catch((caught: unknown) => caught)
	expect(String(error)).toContain("value's host must be one of its hosts")
	expect(String(error)).not.toContain('hook-secret-part')
	expect(await t.entry('deploy-hook')).toBeNull()
})

test('a login credential needs an exchange on its hosts and stores it', async () => {
	const t = await setup()
	const value = JSON.stringify({ username: 'kody', password: 'pw-123' })
	await expect(
		t.set({
			name: 'portal',
			value,
			kind: 'login',
			hosts: ['portal.example.com'],
		}),
	).rejects.toThrow('needs login_exchange')
	const exchange = {
		url: 'https://portal.example.com/api/login',
		bodyFormat: 'json',
		body: { user: '{username}', pass: '{password}' },
		tokenPath: 'token',
	}
	await t.set({
		name: 'portal',
		value,
		kind: 'login',
		hosts: ['portal.example.com'],
		login_exchange: exchange,
	})
	const row = await t.entry('portal')
	expect(row?.kind).toBe('login')
	expect(JSON.parse(row!.config_json!)).toMatchObject(exchange)
})

test('Keys keep their approval flow: hosts and kinds need a value, and a plain update changes nothing', async () => {
	const t = await setup()
	await t.set({ name: 'apiKey', value: 'key-1' })
	await expect(
		t.set({ name: 'apiKey', value: 'key-2', hosts: ['api.example.com'] }),
	).rejects.toThrow('hosts apply only to the opt-in kinds')
	await expect(t.set({ name: 'apiKey', kind: 'url' })).rejects.toThrow(
		'together with a value',
	)
	const saved = await t.set({ name: 'apiKey', value: 'key-3' })
	expect(saved).not.toHaveProperty('kind')
	expect(await t.entry('apiKey')).toMatchObject({
		kind: 'secret',
		allowed_hosts: '[]',
	})
	expect(await t.audits('credential.kind_set')).toEqual([])
})

test('a new value for an existing url credential is checked against its stored hosts', async () => {
	const t = await setup()
	await t.set({
		name: 'deploy-hook',
		value: hookUrl,
		kind: 'url',
		hosts: ['hooks.example.com'],
	})
	await expect(
		t.set({ name: 'deploy-hook', value: 'https://evil.example.net/x' }),
	).rejects.toThrow("value's host must be one of its hosts")
	await t.set({
		name: 'deploy-hook',
		value: 'https://hooks.example.com/services/T1/B2/next',
	})
	expect(await t.entry('deploy-hook')).toMatchObject({
		kind: 'url',
		allowed_hosts: '["hooks.example.com"]',
	})
})

test('switching back to a Key clears the opt-in hosts and exchange', async () => {
	const t = await setup()
	await t.set({
		name: 'deploy-hook',
		value: hookUrl,
		kind: 'url',
		hosts: ['hooks.example.com'],
	})
	const saved = await t.set({
		name: 'deploy-hook',
		value: 'plain-key',
		kind: 'secret',
	})
	expect(saved).toMatchObject({ kind: 'secret', allowed_hosts: [] })
	expect(await t.entry('deploy-hook')).toMatchObject({
		kind: 'secret',
		allowed_hosts: '[]',
		config_json: null,
	})
})

test('provider and inject update an existing Key without a value, audited', async () => {
	const t = await setup()
	await t.set({ name: 'githubPat', value: 'ghp_value' })
	const beforeEdit = await t.entry('githubPat')
	const saved = await t.set({
		name: 'githubPat',
		provider: 'github',
		inject: { kind: 'header', name: 'Authorization', format: 'token {value}' },
	})
	expect(saved).toMatchObject({
		kind: 'secret',
		provider: 'github',
		inject: { kind: 'header', name: 'Authorization', format: 'token {value}' },
	})
	const row = await t.entry('githubPat')
	expect(row?.provider).toBe('github')
	expect(row?.updated_at).toBe(beforeEdit!.updated_at)
	expect(row?.encrypted_value).toBe(beforeEdit!.encrypted_value)
	await expect(
		t.set({ name: 'githubPat', provider: 'gh', description: 'PAT' }),
	).rejects.toThrow('in a call of their own')
	const [audit] = await t.audits('credential.fields_updated')
	expect(audit).toMatchObject({
		resourceId: row!.id,
		details: { provider: { before: null, after: 'github' } },
	})
	await expect(t.set({ name: 'missing', provider: 'github' })).rejects.toThrow(
		'No user-scope secret named "missing"',
	)
	await expect(
		t.set({
			name: 'githubPat',
			inject: { kind: 'header', name: 'Authorization', format: 'no value' },
		}),
	).rejects.toThrow()
})

test('credentialUpdate sets provider and inject by credential id for a writer only', async () => {
	const t = await setup()
	await t.set({ name: 'resendKey', value: 're_value' })
	const listed = await secretListCapability.handler({ scope: 'user' }, t.owner)
	const credentialId = listed.secrets.find(
		(secret) => secret.name === 'resendKey',
	)!.credential_id
	await expect(
		credentialUpdateCapability.handler(
			{ credential_id: credentialId, provider: 'resend' },
			t.member,
		),
	).rejects.toThrow()
	const updated = await credentialUpdateCapability.handler(
		{
			credential_id: credentialId,
			provider: 'resend',
			inject: { kind: 'query', param: 'api_key' },
		},
		t.owner,
	)
	expect(updated).toEqual({
		credential_id: credentialId,
		credential_kind: 'secret',
		name: 'resendKey',
		provider: 'resend',
		inject: { kind: 'query', param: 'api_key' },
		placement: null,
	})
	await expect(
		credentialUpdateCapability.handler(
			{ credential_id: 'cred_missing', provider: 'x' },
			t.owner,
		),
	).rejects.toThrow('No credential with that id')
})

test('a padded name saves the opt-in credential under the trimmed name', async () => {
	const t = await setup()
	await t.set({
		name: '  deploy-hook  ',
		value: hookUrl,
		kind: 'url',
		hosts: ['hooks.example.com'],
	})
	expect(await t.entry('deploy-hook')).toMatchObject({
		kind: 'url',
		allowed_hosts: '["hooks.example.com"]',
	})
	await expect(
		t.set({ name: ' deploy-hook ', value: 'https://evil.example.net/x' }),
	).rejects.toThrow("value's host must be one of its hosts")
})

test('hosts are bare hosts: URLs, ports, paths, and userinfo are refused, not narrowed', async () => {
	const t = await setup()
	for (const host of [
		'https://hooks.example.com',
		'hooks.example.com:8443',
		'hooks.example.com/services',
		'user@hooks.example.com',
		'*.*.example.com',
		'localhost',
		'*.github.io',
		'*.co.uk',
		'*.com',
	]) {
		await expect(
			t.set({
				name: 'deploy-hook',
				value: hookUrl,
				kind: 'url',
				hosts: [host],
			}),
		).rejects.toThrow('not a bare host')
	}
	expect(await t.entry('deploy-hook')).toBeNull()
	await t.set({
		name: 'deploy-hook',
		value: hookUrl,
		kind: 'url',
		hosts: ['*.Example.com', '*.example.co.uk'],
	})
	expect((await t.entry('deploy-hook'))?.allowed_hosts).toBe(
		'["*.example.com","*.example.co.uk"]',
	)
})

test('login credentials refuse basic placement and exchange urls with userinfo', async () => {
	const t = await setup()
	const value = JSON.stringify({ username: 'kody', password: 'pw-123' })
	const exchange = {
		url: 'https://portal.example.com/api/login',
		bodyFormat: 'json',
		body: { user: '{username}' },
		tokenPath: 'token',
	}
	const login = {
		name: 'portal',
		value,
		kind: 'login',
		hosts: ['portal.example.com'],
	}
	await expect(
		t.set({
			...login,
			login_exchange: { ...exchange, url: 'https://a:b@portal.example.com/x' },
		}),
	).rejects.toThrow('cannot carry a username or password')
	await expect(
		t.set({
			...login,
			login_exchange: exchange,
			inject: { kind: 'basic', valueAs: 'password', other: 'alice' },
		}),
	).rejects.toThrow('not basic auth')
	expect(await t.entry('portal')).toBeNull()
	await t.set({ ...login, login_exchange: exchange })
	await expect(
		t.set({
			name: 'portal',
			inject: { kind: 'basic', valueAs: 'password', other: 'alice' },
		}),
	).rejects.toThrow('not basic auth')
	const { id } = (await t.entry('portal'))!
	await expect(
		credentialUpdateCapability.handler(
			{
				credential_id: id,
				inject: { kind: 'basic', valueAs: 'password', other: 'alice' },
			},
			t.owner,
		),
	).rejects.toThrow('not basic auth')
	await t.set({
		name: 'basicKey',
		value: 'k',
		inject: { kind: 'basic', valueAs: 'password', other: 'alice' },
	})
	await expect(
		t.set({ ...login, name: 'basicKey', login_exchange: exchange }),
	).rejects.toThrow('not basic auth')
})

test('the value, its kind and hosts, and the audit commit together or not at all', async () => {
	const t = await setup()
	await t.set({ name: 'apiKey', value: 'key-1' })
	const before = await t.entry('apiKey')
	t.sqlite.exec(
		`CREATE TRIGGER fail_outbox BEFORE INSERT ON org_audit_outbox
		BEGIN SELECT RAISE(ABORT, 'outbox down'); END`,
	)
	await expect(
		t.set({
			name: 'apiKey',
			value: hookUrl,
			kind: 'url',
			hosts: ['hooks.example.com'],
		}),
	).rejects.toThrow('outbox down')
	expect(await t.entry('apiKey')).toEqual(before)
	t.sqlite.exec('DROP TRIGGER fail_outbox')
	await t.set({
		name: 'apiKey',
		value: hookUrl,
		kind: 'url',
		hosts: ['hooks.example.com'],
	})
	const after = await t.entry('apiKey')
	expect(after).toMatchObject({ id: before!.id, kind: 'url' })
	expect(after!.encrypted_value).not.toBe(before!.encrypted_value)
	expect(await t.audits('credential.kind_set')).toEqual([
		{
			resourceId: before!.id,
			details: {
				kind: { before: 'secret', after: 'url' },
				hosts: { before: [], after: ['hooks.example.com'] },
				loginExchangeHost: { before: null, after: null },
			},
		},
	])
})

test('credentialUpdate refuses an API token not scoped for write, even for an owner', async () => {
	const t = await setup()
	await t.set({ name: 'resendKey', value: 're_value' })
	const { id } = (await t.entry('resendKey'))!
	await expect(
		credentialUpdateCapability.handler(
			{ credential_id: id, provider: 'resend' },
			t.ownerReadOnlyToken,
		),
	).rejects.toThrow('not scoped for secret:write')
	expect((await t.entry('resendKey'))?.provider).toBeNull()
})

test('every value write path checks an opt-in credential against its stored kind and hosts', async () => {
	const t = await setup()
	await t.set({
		name: 'deploy-hook',
		value: hookUrl,
		kind: 'url',
		hosts: ['hooks.example.com'],
	})
	const before = await t.entry('deploy-hook')
	const error = await secretSetManyCapability
		.handler(
			{
				secrets: [
					{
						name: 'deploy-hook',
						value: 'https://evil.example.net/hook-secret-part',
						scope: 'user',
					},
				],
			} as never,
			t.owner,
		)
		.catch((caught: unknown) => caught)
	expect(String(error)).toContain("value's host must be one of its hosts")
	expect(String(error)).not.toContain('hook-secret-part')
	expect(await t.entry('deploy-hook')).toEqual(before)
	await secretSetManyCapability.handler(
		{
			secrets: [
				{
					name: 'deploy-hook',
					value: 'https://hooks.example.com/services/T1/B3/next',
					scope: 'user',
				},
				{ name: 'plainKey', value: 'anything', scope: 'user' },
			],
		} as never,
		t.owner,
	)
	expect((await t.entry('deploy-hook'))?.kind).toBe('url')
})

test('placement updates an existing Key without a value, audited, and leaves it null by default', async () => {
	const t = await setup()
	await t.set({ name: 'apiKey', value: 'sk_value' })
	expect((await t.entry('apiKey'))?.placement_json).toBeNull()
	const saved = await t.set({
		name: 'apiKey',
		placement: { headers: true },
	})
	expect(saved).toMatchObject({
		placement: { headers: true },
	})
	expect(JSON.parse((await t.entry('apiKey'))!.placement_json!)).toEqual({
		headers: true,
	})
	const audits = await t.audits('credential.fields_updated')
	expect(audits[0]?.details).toMatchObject({
		placement: { before: null, after: { headers: true } },
	})
	const cleared = await t.set({ name: 'apiKey', placement: null })
	expect(cleared).toMatchObject({ placement: null })
	expect((await t.entry('apiKey'))?.placement_json).toBeNull()
})
