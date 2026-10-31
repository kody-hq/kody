import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { afterEach, expect, test, vi } from 'vitest'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { upsertGrant } from '#worker/orgs/access-writes.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { deleteSecret, saveSecret } from '#mcp/secrets/service.ts'
import {
	CredentialLoginFailedError,
	CredentialLoginRetryLaterError,
	CredentialNotFoundError,
} from './credential-request.ts'
import { clearLoginSessionsForTests } from './login-resolver.ts'
import { resolveCredential } from './resolve-credential.ts'

vi.mock(
	'#worker/test-support/apply-all-migrations.ts',
	async (importOriginal) =>
		(await import('./cached-migrations.test-support.ts')).withCachedMigrations(
			await importOriginal(),
		),
)

const valueReads = vi.hoisted(() => ({ count: 0 }))
const scheduledAudits = vi.hoisted(() => [] as Array<Promise<unknown>>)

vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof import('cloudflare:workers')>()),
	waitUntil: (promise: Promise<unknown>) => {
		scheduledAudits.push(promise)
	},
}))

vi.mock('#mcp/secrets/crypto.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#mcp/secrets/crypto.ts')>()
	return {
		...actual,
		decryptSecretValue: async (
			...args: Parameters<typeof actual.decryptSecretValue>
		) => {
			valueReads.count += 1
			return await actual.decryptSecretValue(...args)
		},
	}
})

afterEach(() => {
	vi.unstubAllGlobals()
})

const now = '2026-10-12T00:00:00.000Z'
const password = 'hunter2-login-password'
const fields = JSON.stringify({ username: 'bea@example.com', password })
const jsonExchange = {
	url: 'https://api.example.com/v1/auth/login',
	bodyFormat: 'json',
	body: { email: '{username}', password: '{password}', client: 'kody' },
	tokenPath: 'data.token',
	expiresInPath: 'data.expires_in',
}

type Exchange = { url: string; init: RequestInit }

/** Stands in for the login endpoint; records each exchange. */
function stubLoginEndpoint(
	respond: (call: number) => Response = (call) =>
		Response.json({ data: { token: `session-${call}`, expires_in: 3600 } }),
) {
	const exchanges: Array<Exchange> = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init: RequestInit) => {
			exchanges.push({ url, init })
			return respond(exchanges.length)
		}),
	)
	return exchanges
}

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const auditDb = createAuditTestDb()
	const env = {
		APP_DB: db,
		AUDIT_DB: auditDb,
		...createInMemoryUserMeterEnv().env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	const people = Object.fromEntries(
		(['ann', 'bea'] as const).map((username) => {
			const stableUserId = testStableUserIdFromEmail(`${username}@example.com`)
			return [
				username,
				{ stableUserId, personId: personIdFromStored(stableUserId) },
			]
		}),
	) as Record<
		'ann' | 'bea',
		{ stableUserId: string; personId: ReturnType<typeof personIdFromStored> }
	>
	for (const [username, person] of Object.entries(people)) {
		await provisionPersonalOrg(db, {
			stableUserId: person.stableUserId,
			username,
			createdAt: now,
		})
	}
	// Bea owns Acme; Ann is a member.
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: people.bea.personId,
			audit: createTestOrgAuditWriter(),
			slug: 'acme-login',
			displayName: 'Acme',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const acme = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'acme-login'`)
		.first<{ id: string }>()
	const acmeId = ownerIdFromStored(acme!.id)
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(acmeId, people.ann.stableUserId, now)
		.run()
	const storeCredential = async (input: {
		name: string
		value?: string
		kind?: string
		hosts?: Array<string>
		exchange?: unknown
		inject?: unknown
	}) => {
		await saveSecret({
			env,
			userId: acmeId,
			scope: 'user',
			name: input.name,
			value: input.value ?? fields,
			audit: null,
		})
		const row = await db
			.prepare(
				`UPDATE secret_entries
				SET kind = ?, allowed_hosts = ?, config_json = ?,
					inject_json = COALESCE(?, inject_json)
				WHERE name = ? AND bucket_id IN (
					SELECT id FROM secret_buckets WHERE user_id = ? AND scope = 'user'
				)
				RETURNING id`,
			)
			.bind(
				input.kind ?? 'login',
				JSON.stringify(input.hosts ?? ['api.example.com']),
				JSON.stringify(input.exchange ?? jsonExchange),
				input.inject ? JSON.stringify(input.inject) : null,
				input.name,
				acmeId,
			)
			.first<{ id: string }>()
		return row!.id
	}
	const requestAs = (person: keyof typeof people, role: OrgRole) =>
		deriveRequestContext({
			user: { userId: people[person].personId, username: person },
			source: { kind: 'mcp-oauth' },
			orgBinding: { org: { id: acmeId, slug: 'acme-login' }, role },
		})
	const signIn = (input: {
		actor: ReturnType<typeof requestAs>
		credentialId: string
		requestUrl?: string
	}) =>
		resolveCredential({
			env,
			orgId: acmeId,
			actor: input.actor,
			baseUrl: 'https://example.com',
			credential: {
				use: 'login',
				credentialId: input.credentialId,
				requestUrl: new URL(
					input.requestUrl ?? 'https://api.example.com/v1/reports',
				),
			},
		})
	const grantUse = (credentialId: string) =>
		upsertGrant({
			db,
			orgId: acmeId,
			resourceType: 'credential',
			resourceId: credentialId,
			family: 'secret',
			subject: { type: 'user', id: people.ann.stableUserId },
			preset: 'use',
			permissions: null,
			createdByUserId: people.bea.stableUserId,
			audit: createTestOrgAuditWriter(),
		})
	const audits = async () => {
		await Promise.all(scheduledAudits.splice(0))
		const { results } = await auditDb
			.prepare(
				`SELECT result, details_json FROM org_audit_events
				 WHERE action = 'credential.resolve' ORDER BY rowid`,
			)
			.all<{ result: string; details_json: string }>()
		return results
	}
	valueReads.count = 0
	scheduledAudits.length = 0
	clearLoginSessionsForTests()
	return {
		env,
		db,
		acmeId,
		storeCredential,
		requestAs,
		signIn,
		grantUse,
		audits,
	}
}

test('a login credential runs its exchange and places the session, reusing it until it expires', async () => {
	const t = await setup()
	const exchanges = stubLoginEndpoint()
	const id = await t.storeCredential({ name: 'portal-login' })
	const actor = t.requestAs('bea', 'owner')

	const first = await t.signIn({ actor, credentialId: id })
	expect(first.placement).toEqual({
		kind: 'header',
		name: 'Authorization',
		value: 'Bearer session-1',
	})
	expect(first.substitutedValues).toEqual(['session-1', 'Bearer session-1'])
	expect(exchanges).toHaveLength(1)
	expect(exchanges[0]!.url).toBe('https://api.example.com/v1/auth/login')
	expect(exchanges[0]!.init).toMatchObject({
		method: 'POST',
		redirect: 'manual',
	})
	expect(JSON.parse(String(exchanges[0]!.init.body))).toEqual({
		email: 'bea@example.com',
		password,
		client: 'kody',
	})

	const second = await t.signIn({ actor, credentialId: id })
	expect(second.placement.value).toBe('Bearer session-1')
	expect(exchanges).toHaveLength(1)
	expect(valueReads.count).toBe(1)

	const rows = await t.audits()
	expect(rows.map((row) => row.result)).toEqual(['success', 'success'])
	expect(rows.map((row) => JSON.parse(row.details_json).session)).toEqual([
		'new',
		'cached',
	])
	expect(JSON.stringify(rows)).not.toContain(password)
	expect(JSON.stringify(rows)).not.toContain('session-1')
})

test('Use is checked on every resolution, cached session or not', async () => {
	const t = await setup()
	const exchanges = stubLoginEndpoint()
	const id = await t.storeCredential({ name: 'portal-login' })
	await t.signIn({ actor: t.requestAs('bea', 'owner'), credentialId: id })

	await expect(
		t.signIn({ actor: t.requestAs('ann', 'member'), credentialId: id }),
	).rejects.toBeInstanceOf(AuthorizationError)
	await t.grantUse(id)
	await expect(
		t.signIn({ actor: t.requestAs('ann', 'member'), credentialId: id }),
	).resolves.toMatchObject({ placement: { value: 'Bearer session-1' } })
	expect(exchanges).toHaveLength(1)
	expect((await t.audits()).map((row) => row.result)).toEqual([
		'success',
		'denied',
		'success',
	])
})

test('an off-host or plain HTTP request, or a bad exchange URL, never runs the exchange or reads the fields', async () => {
	const t = await setup()
	const exchanges = stubLoginEndpoint()
	const actor = t.requestAs('bea', 'owner')
	const id = await t.storeCredential({ name: 'portal-login' })
	await expect(
		t.signIn({
			actor,
			credentialId: id,
			requestUrl: 'https://evil.example.net/v1/reports',
		}),
	).rejects.toMatchObject({ code: 'host_not_allowed' })
	await expect(
		t.signIn({
			actor,
			credentialId: id,
			requestUrl: 'http://api.example.com/v1/reports',
		}),
	).rejects.toMatchObject({ code: 'insecure_transport' })
	const offHost = await t.storeCredential({
		name: 'off-host-exchange',
		exchange: { ...jsonExchange, url: 'https://evil.example.net/login' },
	})
	await expect(
		t.signIn({ actor, credentialId: offHost }),
	).rejects.toMatchObject({ code: 'host_not_allowed' })
	const plain = await t.storeCredential({
		name: 'http-exchange',
		exchange: { ...jsonExchange, url: 'http://api.example.com/login' },
	})
	await expect(t.signIn({ actor, credentialId: plain })).rejects.toMatchObject({
		code: 'insecure_transport',
	})
	const broken = await t.storeCredential({
		name: 'broken-exchange',
		exchange: { url: 'https://api.example.com/login' },
	})
	await expect(t.signIn({ actor, credentialId: broken })).rejects.toMatchObject(
		{
			code: 'invalid_request',
		},
	)
	const key = await t.storeCredential({ name: 'plain-key', kind: 'secret' })
	await expect(t.signIn({ actor, credentialId: key })).rejects.toBeInstanceOf(
		CredentialNotFoundError,
	)
	expect(exchanges).toHaveLength(0)
	expect(valueReads.count).toBe(0)
})

test('a failed exchange reports only its status and keeps no session', async () => {
	const t = await setup()
	const exchanges = stubLoginEndpoint((call) =>
		call === 1
			? Response.json({ error: `bad password ${password}` }, { status: 401 })
			: Response.json({ data: { token: 'session-2' } }),
	)
	const actor = t.requestAs('bea', 'owner')
	const id = await t.storeCredential({ name: 'portal-login' })
	const failure = await t.signIn({ actor, credentialId: id }).catch((e) => e)
	expect(failure).toBeInstanceOf(CredentialLoginFailedError)
	expect(failure).toMatchObject({ status: 401 })
	expect(String(failure.message)).not.toContain(password)
	await expect(t.signIn({ actor, credentialId: id })).rejects.toBeInstanceOf(
		CredentialLoginRetryLaterError,
	)
	expect(exchanges).toHaveLength(1)
	// Once the cooldown passes, the exchange runs again.
	await t.db
		.prepare(`UPDATE login_credential_sessions SET retry_after = 0`)
		.run()
	await expect(t.signIn({ actor, credentialId: id })).resolves.toMatchObject({
		placement: { value: 'Bearer session-2' },
	})
	const rows = await t.audits()
	expect(rows.map((row) => row.result)).toEqual([
		'failure',
		'failure',
		'success',
	])
	expect(JSON.stringify(rows)).not.toContain(password)
})

test('a token the endpoint reports as expired, or an oversized response, is never cached', async () => {
	const t = await setup()
	const actor = t.requestAs('bea', 'owner')
	const id = await t.storeCredential({ name: 'portal-login' })
	const expired = stubLoginEndpoint((call) =>
		Response.json({ data: { token: `session-${call}`, expires_in: 0 } }),
	)
	await expect(t.signIn({ actor, credentialId: id })).resolves.toMatchObject({
		placement: { value: 'Bearer session-1' },
	})
	await expect(t.signIn({ actor, credentialId: id })).resolves.toMatchObject({
		placement: { value: 'Bearer session-2' },
	})
	expect(expired).toHaveLength(2)

	const expiredText = stubLoginEndpoint((call) =>
		Response.json({ data: { token: `text-${call}`, expires_in: '0' } }),
	)
	await t.signIn({ actor, credentialId: id })
	await t.signIn({ actor, credentialId: id })
	expect(expiredText).toHaveLength(2)

	const oversized = stubLoginEndpoint(() =>
		Response.json({ data: { token: 'big', padding: 'x'.repeat(70_000) } }),
	)
	await expect(t.signIn({ actor, credentialId: id })).rejects.toBeInstanceOf(
		CredentialLoginFailedError,
	)
	await expect(t.signIn({ actor, credentialId: id })).rejects.toBeInstanceOf(
		CredentialLoginRetryLaterError,
	)
	expect(oversized).toHaveLength(1)
})

test('a header format keeps a token with $ patterns as is', async () => {
	const t = await setup()
	stubLoginEndpoint(() =>
		Response.json({ data: { token: "a$&b$'c$$d", expires_in: 3600 } }),
	)
	const id = await t.storeCredential({ name: 'portal-login' })
	await expect(
		t.signIn({ actor: t.requestAs('bea', 'owner'), credentialId: id }),
	).resolves.toMatchObject({
		placement: { value: "Bearer a$&b$'c$$d" },
	})
})

test('a form exchange can place its session in a query parameter, and a changed credential signs in again', async () => {
	const t = await setup()
	const exchanges = stubLoginEndpoint()
	const actor = t.requestAs('bea', 'owner')
	const id = await t.storeCredential({
		name: 'form-login',
		exchange: {
			url: 'https://api.example.com/oauth/token',
			bodyFormat: 'form',
			body: {
				grant_type: 'password',
				username: '{username}',
				password: '{password}',
			},
			tokenPath: 'access_token',
			ttlSeconds: 600,
		},
		inject: { kind: 'query', param: 'access_token' },
	})
	stubLoginEndpoint(() => Response.json({ access_token: 'form-session' }))
	const placed = await t.signIn({ actor, credentialId: id })
	expect(placed.placement).toEqual({
		kind: 'query',
		param: 'access_token',
		value: 'form-session',
	})
	expect(exchanges).toHaveLength(0)

	const formExchanges = stubLoginEndpoint(() =>
		Response.json({ access_token: 'form-session-2' }),
	)
	// A replacement in the same millisecond still starts a new session.
	const { updated_at } = (await t.db
		.prepare(`SELECT updated_at FROM secret_entries WHERE id = ?`)
		.bind(id)
		.first<{ updated_at: string }>())!
	await t.storeCredential({
		name: 'form-login',
		exchange: {
			url: 'https://api.example.com/oauth/token',
			bodyFormat: 'form',
			body: {
				grant_type: 'password',
				username: '{username}',
				password: '{password}',
			},
			tokenPath: 'access_token',
			ttlSeconds: 600,
		},
		inject: { kind: 'query', param: 'access_token' },
	})
	await t.db
		.prepare(`UPDATE secret_entries SET updated_at = ? WHERE id = ?`)
		.bind(updated_at, id)
		.run()
	await expect(t.signIn({ actor, credentialId: id })).resolves.toMatchObject({
		placement: { value: 'form-session-2' },
	})
	expect(String(formExchanges[0]!.init.body)).toBe(
		new URLSearchParams({
			grant_type: 'password',
			username: 'bea@example.com',
			password,
		}).toString(),
	)
})

test('a session persists encrypted across isolates and is reused until the credential changes', async () => {
	const t = await setup()
	const exchanges = stubLoginEndpoint()
	const id = await t.storeCredential({ name: 'portal-login' })
	const actor = t.requestAs('bea', 'owner')

	await t.signIn({ actor, credentialId: id })
	const stored = await t.db
		.prepare(`SELECT * FROM login_credential_sessions WHERE credential_id = ?`)
		.bind(id)
		.first<Record<string, unknown>>()
	expect(stored).toMatchObject({ user_id: t.acmeId, lease_id: null })
	expect(JSON.stringify(stored)).not.toContain('session-1')
	expect(JSON.stringify(stored)).not.toContain(password)

	// A fresh isolate has an empty front cache and reuses the stored session.
	clearLoginSessionsForTests()
	const again = await t.signIn({ actor, credentialId: id })
	expect(again.placement.value).toBe('Bearer session-1')
	expect(exchanges).toHaveLength(1)
	expect(valueReads.count).toBe(1)

	// Hosts, inject, and value edits each start a new session. Hosts and inject
	// change only their own columns, so the ciphertext stays the same.
	const setColumn = async (
		column: 'allowed_hosts' | 'inject_json',
		value: unknown,
	) =>
		await t.db
			.prepare(`UPDATE secret_entries SET ${column} = ? WHERE id = ?`)
			.bind(JSON.stringify(value), id)
			.run()
	await setColumn('allowed_hosts', ['api.example.com', 'auth.example.com'])
	clearLoginSessionsForTests()
	expect((await t.signIn({ actor, credentialId: id })).placement.value).toBe(
		'Bearer session-2',
	)
	await setColumn('inject_json', {
		kind: 'header',
		name: 'X-Session',
		format: '{value}',
	})
	expect((await t.signIn({ actor, credentialId: id })).placement).toEqual({
		kind: 'header',
		name: 'X-Session',
		value: 'session-3',
	})
	await t.storeCredential({
		name: 'portal-login',
		value: JSON.stringify({ username: 'bea@example.com', password: 'rotated' }),
		hosts: ['api.example.com', 'auth.example.com'],
		inject: { kind: 'header', name: 'X-Session', format: '{value}' },
	})
	expect((await t.signIn({ actor, credentialId: id })).placement.value).toBe(
		'session-4',
	)
	expect(exchanges).toHaveLength(4)

	const rows = await t.audits()
	expect(rows.map((row) => JSON.parse(row.details_json).session)).toEqual([
		'new',
		'stored',
		'new',
		'new',
		'new',
	])
	expect(JSON.stringify(rows)).not.toMatch(/session-\d/)
})

test('deleting a login credential deletes its stored session', async () => {
	const t = await setup()
	stubLoginEndpoint()
	const id = await t.storeCredential({ name: 'portal-login' })
	await t.signIn({ actor: t.requestAs('bea', 'owner'), credentialId: id })
	const count = () =>
		t.db
			.prepare(
				`SELECT COUNT(*) AS n FROM login_credential_sessions WHERE credential_id = ?`,
			)
			.bind(id)
			.first<{ n: number }>()
	expect(await count()).toEqual({ n: 1 })

	await deleteSecret({
		env: t.env,
		userId: t.acmeId,
		scope: 'user',
		name: 'portal-login',
		audit: null,
	})
	expect(await count()).toEqual({ n: 0 })
	clearLoginSessionsForTests()
	await expect(
		t.signIn({ actor: t.requestAs('bea', 'owner'), credentialId: id }),
	).rejects.toBeInstanceOf(CredentialNotFoundError)
})
