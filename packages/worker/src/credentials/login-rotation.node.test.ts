import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { afterEach, expect, test, vi } from 'vitest'
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
import { saveSecret } from '#mcp/secrets/service.ts'
import {
	clearLoginSessionsForTests,
	loginExchangeSchema,
	readRetryAfterSeconds,
} from './login-resolver.ts'
import { listCredentialsForViewer } from './credential-list.ts'
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
		rejectedSessionId?: string | null
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
				rejectedSessionId: input.rejectedSessionId ?? null,
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

const refreshFields = JSON.stringify({ refresh_token: 'dummy-refresh-1' })
const rotatingExchange = {
	url: 'https://auth.example.com/oauth/token',
	bodyFormat: 'form',
	body: {
		grant_type: 'refresh_token',
		client_id: 'token-demo',
		refresh_token: '{refresh_token}',
	},
	tokenPath: 'access_token',
	expiresInPath: 'expires_in',
	refreshToken: { path: 'refresh_token', field: 'refresh_token' },
}

/** A provider that rotates: each refresh token works once. */
function stubRotatingProvider() {
	const sent: Array<string> = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: RequestInit) => {
			const presented = new URLSearchParams(String(init.body)).get(
				'refresh_token',
			)!
			sent.push(presented)
			const n = sent.length
			return Response.json({
				access_token: `dummy-access-${n}`,
				expires_in: 3600,
				refresh_token: `dummy-refresh-${n + 1}`,
			})
		}),
	)
	return sent
}

async function valueAuditRows(env: Env) {
	const { results } = await env
		.AUDIT_DB!.prepare(
			`SELECT details_json FROM org_audit_events
			WHERE action = 'credential.value_replaced' ORDER BY rowid`,
		)
		.all<{ details_json: string }>()
	return results
}

test('a rotated refresh token replaces the login value with its session, audited without the value', async () => {
	const t = await setup()
	const sent = stubRotatingProvider()
	const actor = t.requestAs('bea', 'owner')
	const id = await t.storeCredential({
		name: 'token-demo-login',
		value: refreshFields,
		hosts: ['auth.example.com', 'api.example.com'],
		exchange: rotatingExchange,
	})
	const before = await t.db
		.prepare(`SELECT encrypted_value FROM secret_entries WHERE id = ?`)
		.bind(id)
		.first<{ encrypted_value: string }>()
	const first = await t.signIn({ actor, credentialId: id })
	expect(first.placement).toMatchObject({ value: 'Bearer dummy-access-1' })
	expect(sent).toEqual(['dummy-refresh-1'])
	const after = await t.db
		.prepare(`SELECT encrypted_value FROM secret_entries WHERE id = ?`)
		.bind(id)
		.first<{ encrypted_value: string }>()
	expect(after!.encrypted_value).not.toBe(before!.encrypted_value)
	expect(after!.encrypted_value).not.toContain('dummy-refresh')

	// Another isolate reuses the session stored under the new revision.
	clearLoginSessionsForTests()
	const second = await t.signIn({ actor, credentialId: id })
	expect(second.placement).toMatchObject({ value: 'Bearer dummy-access-1' })
	expect(sent).toHaveLength(1)

	// A rejected session re-exchanges with the rotated token, never the old one.
	const third = await t.signIn({
		actor,
		credentialId: id,
		rejectedSessionId: second.sessionId,
	})
	expect(third.placement).toMatchObject({ value: 'Bearer dummy-access-2' })
	expect(sent).toEqual(['dummy-refresh-1', 'dummy-refresh-2'])

	const rows = await valueAuditRows(t.env)
	expect(rows).toHaveLength(2)
	for (const row of rows) {
		expect(row.details_json).not.toMatch(/dummy-(refresh|access)/)
		expect(JSON.parse(row.details_json)).toMatchObject({
			replacedBy: 'login_exchange.refreshToken',
		})
	}
	const sessionRows = await t.db
		.prepare(`SELECT * FROM login_credential_sessions`)
		.all()
	expect(JSON.stringify(sessionRows.results)).not.toMatch(
		/dummy-(refresh|access)/,
	)
})

test('an edit during the exchange wins: the rotated value and its session are not saved', async () => {
	const t = await setup()
	const actor = t.requestAs('bea', 'owner')
	const id = await t.storeCredential({
		name: 'token-demo-login',
		value: refreshFields,
		hosts: ['auth.example.com', 'api.example.com'],
		exchange: rotatingExchange,
	})
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => {
			await t.db
				.prepare(
					`UPDATE secret_entries SET encrypted_value = 'edited-by-owner' WHERE id = ?`,
				)
				.bind(id)
				.run()
			return Response.json({
				access_token: 'dummy-access-1',
				expires_in: 3600,
				refresh_token: 'dummy-refresh-2',
			})
		}),
	)
	const placed = await t.signIn({ actor, credentialId: id })
	expect(placed.placement).toMatchObject({ value: 'Bearer dummy-access-1' })
	expect(placed.sessionId).toBeNull()
	const row = await t.db
		.prepare(`SELECT encrypted_value FROM secret_entries WHERE id = ?`)
		.bind(id)
		.first<{ encrypted_value: string }>()
	expect(row!.encrypted_value).toBe('edited-by-owner')
	const session = await t.db
		.prepare(
			`SELECT session_encrypted, lease_id FROM login_credential_sessions WHERE credential_id = ?`,
		)
		.bind(id)
		.first()
	expect(session).toEqual({ session_encrypted: null, lease_id: null })
	expect(await valueAuditRows(t.env)).toHaveLength(0)
})

test('a rejected session is dropped once: a second caller with the same rejection reuses the new one', async () => {
	const t = await setup()
	const exchanges = stubLoginEndpoint()
	const actor = t.requestAs('bea', 'owner')
	const id = await t.storeCredential({ name: 'portal-login' })
	const first = await t.signIn({ actor, credentialId: id })
	expect(first.sessionId).toEqual(expect.any(String))
	const retried = await t.signIn({
		actor,
		credentialId: id,
		rejectedSessionId: first.sessionId,
	})
	expect(retried.placement).toMatchObject({ value: 'Bearer session-2' })
	clearLoginSessionsForTests()
	const again = await t.signIn({
		actor,
		credentialId: id,
		rejectedSessionId: first.sessionId,
	})
	expect(again.placement).toMatchObject({ value: 'Bearer session-2' })
	expect(exchanges).toHaveLength(2)
	expect(
		(await t.audits()).map((row) => JSON.parse(row.details_json).session),
	).toEqual(['new', 'new-after-401', 'stored-after-401'])
})

test('refreshToken is strict and must name a field the exchange body sends', () => {
	expect(loginExchangeSchema.safeParse(rotatingExchange).success).toBe(true)
	expect(
		loginExchangeSchema.safeParse({
			...rotatingExchange,
			refreshToken: { path: 'refresh_token', field: 'other_field' },
		}).success,
	).toBe(false)
	expect(
		loginExchangeSchema.safeParse({
			...rotatingExchange,
			refreshToken: { path: 'refresh_token', field: 'refresh_token', extra: 1 },
		}).success,
	).toBe(false)
})

test('concurrent callers sharing one rotating exchange write one value audit row', async () => {
	const t = await setup()
	const sent = stubRotatingProvider()
	const actor = t.requestAs('bea', 'owner')
	const id = await t.storeCredential({
		name: 'token-demo-login',
		value: refreshFields,
		hosts: ['auth.example.com', 'api.example.com'],
		exchange: rotatingExchange,
	})
	const [a, b] = await Promise.all([
		t.signIn({ actor, credentialId: id }),
		t.signIn({ actor, credentialId: id }),
	])
	expect(a.placement).toMatchObject({ value: 'Bearer dummy-access-1' })
	expect(b.placement).toMatchObject({ value: 'Bearer dummy-access-1' })
	expect(sent).toEqual(['dummy-refresh-1'])
	expect(await valueAuditRows(t.env)).toHaveLength(1)
})

test('a caller that read the value before another isolate rotated it reuses the new session', async () => {
	const t = await setup()
	const sent: Array<string> = []
	let release!: () => void
	const gate = new Promise<void>((resolve) => {
		release = resolve
	})
	let started!: () => void
	const exchangeStarted = new Promise<void>((resolve) => {
		started = resolve
	})
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: RequestInit) => {
			sent.push(new URLSearchParams(String(init.body)).get('refresh_token')!)
			const n = sent.length
			if (n === 1) {
				started()
				await gate
			}
			return Response.json({
				access_token: `dummy-access-${n}`,
				expires_in: 3600,
				refresh_token: `dummy-refresh-${n + 1}`,
			})
		}),
	)
	const actor = t.requestAs('bea', 'owner')
	const id = await t.storeCredential({
		name: 'token-demo-login',
		value: refreshFields,
		hosts: ['auth.example.com', 'api.example.com'],
		exchange: rotatingExchange,
	})
	const first = t.signIn({ actor, credentialId: id })
	await exchangeStarted
	// A second isolate reads the pre-rotation value while the first holds the lease.
	clearLoginSessionsForTests()
	const second = t.signIn({ actor, credentialId: id })
	await new Promise((resolve) => setTimeout(resolve, 50))
	release()
	expect((await first).placement).toMatchObject({
		value: 'Bearer dummy-access-1',
	})
	expect((await second).placement).toMatchObject({
		value: 'Bearer dummy-access-1',
	})
	expect(sent).toEqual(['dummy-refresh-1'])
	expect(await valueAuditRows(t.env)).toHaveLength(1)
})

function loginErrorBody(error: unknown) {
	const caught = error as {
		code?: string
		body?: { code: string; retryAfterSeconds?: number }
		retryAfterSeconds?: number | null
		message: string
	}
	return {
		code: caught.body?.code ?? caught.code,
		retryAfterSeconds:
			caught.body?.retryAfterSeconds ?? caught.retryAfterSeconds ?? null,
		message: caught.message,
	}
}

test('invalid_grant from the token endpoint needs reconnecting and stops the exchange', async () => {
	const t = await setup()
	const exchanges = stubLoginEndpoint(() =>
		Response.json(
			{ error: 'invalid_grant', error_description: 'dummy-refresh-1 revoked' },
			{ status: 400 },
		),
	)
	const actor = t.requestAs('bea', 'owner')
	const id = await t.storeCredential({
		name: 'token-demo-login',
		value: refreshFields,
		hosts: ['auth.example.com', 'api.example.com'],
		exchange: rotatingExchange,
	})
	for (let i = 0; i < 3; i++) {
		clearLoginSessionsForTests()
		const error = loginErrorBody(
			await t.signIn({ actor, credentialId: id }).catch((e: unknown) => e),
		)
		expect(error.code).toBe('login_needs_reconnect')
		expect(error.message).not.toContain('dummy-refresh')
	}
	expect(exchanges).toHaveLength(1)
	const listed = await listCredentialsForViewer({ env: t.env, request: actor })
	expect(listed.find((item) => item.id === id)).toMatchObject({
		status: 'needs_attention',
		statusMessage: expect.stringContaining('Save a new value to reconnect'),
	})
	expect(JSON.stringify(listed)).not.toContain('dummy-refresh')
})

test("a 429 waits for the provider's Retry-After before the next exchange", async () => {
	const t = await setup()
	const exchanges = stubLoginEndpoint(
		() =>
			new Response('{"error":"slow_down"}', {
				status: 429,
				headers: { 'retry-after': '120' },
			}),
	)
	const actor = t.requestAs('bea', 'owner')
	const id = await t.storeCredential({ name: 'portal-login' })
	const first = loginErrorBody(
		await t.signIn({ actor, credentialId: id }).catch((e: unknown) => e),
	)
	expect(first).toMatchObject({ code: 'login_failed', retryAfterSeconds: 120 })
	clearLoginSessionsForTests()
	const second = loginErrorBody(
		await t.signIn({ actor, credentialId: id }).catch((e: unknown) => e),
	)
	expect(second.code).toBe('login_retry_later')
	expect(second.retryAfterSeconds).toBeGreaterThan(100)
	expect(exchanges).toHaveLength(1)
})

test('readRetryAfterSeconds reads delta-seconds and HTTP dates', () => {
	const at = Date.parse('2026-10-30T00:00:00Z')
	expect(readRetryAfterSeconds('90', at)).toBe(90)
	expect(readRetryAfterSeconds('Fri, 30 Oct 2026 00:02:00 GMT', at)).toBe(120)
	expect(readRetryAfterSeconds('soon', at)).toBeNull()
	expect(readRetryAfterSeconds(null, at)).toBeNull()
})
