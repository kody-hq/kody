import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personalOrgId,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { expect, test, vi } from 'vitest'
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
import { findSecret, saveSecret } from '#mcp/secrets/service.ts'
import {
	CredentialNotFoundError,
	CredentialRequestRefusedError,
} from './credential-request.ts'
import { grantPersonalCredentialToOrg } from './personal-credentials.ts'
import { resolveCredential } from './resolve-credential.ts'
import { joinCredentialUrl } from './url-resolver.ts'

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

const now = '2026-10-12T00:00:00.000Z'
const hookUrl = 'https://hooks.example.com/services/T1/B1/hook-secret-part'

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
		(['ann', 'bea', 'cy'] as const).map((username) => {
			const stableUserId = testStableUserIdFromEmail(`${username}@example.com`)
			return [
				username,
				{ stableUserId, personId: personIdFromStored(stableUserId) },
			]
		}),
	) as Record<
		'ann' | 'bea' | 'cy',
		{ stableUserId: string; personId: ReturnType<typeof personIdFromStored> }
	>
	for (const [username, person] of Object.entries(people)) {
		await provisionPersonalOrg(db, {
			stableUserId: person.stableUserId,
			username,
			createdAt: now,
		})
	}
	// Bea owns Acme; Ann and Cy are members.
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: people.bea.personId,
			audit: createTestOrgAuditWriter(),
			slug: 'acme-hooks',
			displayName: 'Acme',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const acme = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'acme-hooks'`)
		.first<{ id: string }>()
	const acmeId = ownerIdFromStored(acme!.id)
	for (const person of [people.ann, people.cy]) {
		await db
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, 'member', ?)`,
			)
			.bind(acmeId, person.stableUserId, now)
			.run()
	}
	const storeCredential = async (input: {
		ownerId: OwnerId
		name: string
		value: string
		kind?: string
		hosts?: Array<string>
	}) => {
		await saveSecret({
			env,
			userId: input.ownerId,
			scope: 'user',
			name: input.name,
			value: input.value,
			audit: null,
		})
		const row = await db
			.prepare(
				`UPDATE secret_entries SET kind = ?, allowed_hosts = ?
				WHERE name = ? AND bucket_id IN (
					SELECT id FROM secret_buckets WHERE user_id = ? AND scope = 'user'
				)
				RETURNING id`,
			)
			.bind(
				input.kind ?? 'url',
				JSON.stringify(input.hosts ?? ['hooks.example.com']),
				input.name,
				input.ownerId,
			)
			.first<{ id: string }>()
		return row!.id
	}
	const requestAs = (
		person: keyof typeof people,
		role: OrgRole | null,
		orgId: OwnerId = acmeId,
	) =>
		deriveRequestContext({
			user: { userId: people[person].personId, username: person },
			source: { kind: 'mcp-oauth' },
			orgBinding: { org: { id: orgId, slug: 'acme-hooks' }, role },
		})
	const resolveUrl = (input: {
		actor: ReturnType<typeof requestAs>
		credentialId: string
		path?: string
		orgId?: OwnerId
	}) =>
		resolveCredential({
			env,
			orgId: input.orgId ?? acmeId,
			actor: input.actor,
			baseUrl: 'https://example.com',
			credential: {
				use: 'url',
				credentialId: input.credentialId,
				path: input.path ?? '',
			},
		})
	const grantUse = (credentialId: string, person: keyof typeof people) =>
		upsertGrant({
			db,
			orgId: acmeId,
			resourceType: 'credential',
			resourceId: credentialId,
			family: 'secret',
			subject: { type: 'user', id: people[person].stableUserId },
			preset: 'use',
			permissions: null,
			createdByUserId: people.bea.stableUserId,
			audit: createTestOrgAuditWriter(),
		})
	const auditDetails = async () => {
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
	return {
		db,
		auditDetails,
		env,
		people,
		acmeId,
		storeCredential,
		requestAs,
		resolveUrl,
		grantUse,
	}
}

test('a url credential sends the relative path to its own URL, for an actor with Use', async () => {
	const t = await setup()
	const id = await t.storeCredential({
		ownerId: t.acmeId,
		name: 'deploy-hook',
		value: hookUrl,
	})
	const resolved = await t.resolveUrl({
		actor: t.requestAs('bea', 'owner'),
		credentialId: id,
		path: '/extra?thread=1',
	})
	expect(resolved.url.href).toBe(`${hookUrl}/extra?thread=1`)
	expect(resolved.substitutedValues).toContain(hookUrl)
	expect(valueReads.count).toBe(1)

	await expect(
		t.resolveUrl({ actor: t.requestAs('ann', 'member'), credentialId: id }),
	).rejects.toBeInstanceOf(AuthorizationError)
	expect(valueReads.count).toBe(1)
	await t.grantUse(id, 'ann')
	const asAnn = await t.resolveUrl({
		actor: t.requestAs('ann', 'member'),
		credentialId: id,
	})
	expect(asAnn.url.href).toBe(hookUrl)
	const audits = await t.auditDetails()
	expect(audits.map((row) => row.result)).toEqual([
		'success',
		'denied',
		'success',
	])
	expect(JSON.stringify(audits)).not.toContain('hook-secret-part')
})

test('the value must be HTTPS on one of the credential hosts, and no hosts sends nothing', async () => {
	const t = await setup()
	const actor = t.requestAs('bea', 'owner')
	const offHost = await t.storeCredential({
		ownerId: t.acmeId,
		name: 'off-host',
		value: 'https://evil.example.net/collect',
	})
	await expect(
		t.resolveUrl({ actor, credentialId: offHost }),
	).rejects.toMatchObject({ code: 'host_not_allowed' })
	const plain = await t.storeCredential({
		ownerId: t.acmeId,
		name: 'plain-http',
		value: 'http://hooks.example.com/services/x',
	})
	await expect(
		t.resolveUrl({ actor, credentialId: plain }),
	).rejects.toMatchObject({ code: 'insecure_transport' })
	const wildcard = await t.storeCredential({
		ownerId: t.acmeId,
		name: 'wildcard',
		value: 'https://eu.hooks.example.com/services/x',
		hosts: ['*.hooks.example.com'],
	})
	await expect(
		t.resolveUrl({ actor, credentialId: wildcard }),
	).resolves.toMatchObject({
		url: new URL('https://eu.hooks.example.com/services/x'),
	})
	const reads = valueReads.count
	const noHosts = await t.storeCredential({
		ownerId: t.acmeId,
		name: 'no-hosts',
		value: hookUrl,
		hosts: [],
	})
	await expect(
		t.resolveUrl({ actor, credentialId: noHosts }),
	).rejects.toMatchObject({ code: 'host_not_allowed' })
	expect(valueReads.count).toBe(reads)
})

test('a path that names another origin or climbs out is refused before any lookup', async () => {
	const t = await setup()
	const id = await t.storeCredential({
		ownerId: t.acmeId,
		name: 'deploy-hook',
		value: hookUrl,
	})
	for (const path of [
		'https://evil.example.net/x',
		'//evil.example.net/x',
		'/../../other',
		'/%2e%2e/other',
		'relative',
		'/a\\b',
	]) {
		await expect(
			t.resolveUrl({
				actor: t.requestAs('bea', 'owner'),
				credentialId: id,
				path,
			}),
		).rejects.toBeInstanceOf(CredentialRequestRefusedError)
	}
	expect(valueReads.count).toBe(0)
})

test('a secret is not a url credential, and placeholders never fill a url credential', async () => {
	const t = await setup()
	const actor = t.requestAs('bea', 'owner')
	const secretId = await t.storeCredential({
		ownerId: t.acmeId,
		name: 'plain-secret',
		value: hookUrl,
		kind: 'secret',
	})
	await expect(
		t.resolveUrl({ actor, credentialId: secretId }),
	).rejects.toBeInstanceOf(CredentialNotFoundError)
	await expect(
		t.resolveUrl({ actor, credentialId: 'missing-id' }),
	).rejects.toBeInstanceOf(CredentialNotFoundError)
	await t.storeCredential({
		ownerId: t.acmeId,
		name: 'deploy-hook',
		value: hookUrl,
	})
	const placeholder = await resolveCredential({
		env: t.env,
		orgId: t.acmeId,
		actor,
		baseUrl: 'https://example.com',
		credential: {
			use: 'secret',
			name: 'deploy-hook',
			storageContext: { sessionId: null, appId: null, packageId: null },
		},
	})
	expect(placeholder.found).toBe(false)
	expect(valueReads.count).toBe(0)
	// Existence and grant checks still see it, so a delete by name is held to
	// the same package grant as any credential.
	await expect(
		findSecret({
			env: t.env,
			userId: t.acmeId,
			name: 'deploy-hook',
			scope: 'user',
		}),
	).resolves.toMatchObject({ found: true })
})

test('the gateway redacts the joined request URL and the stored path and query', async () => {
	const t = await setup()
	const value = 'https://hooks.example.com/bot123:secret-token?key=query-secret'
	const id = await t.storeCredential({
		ownerId: t.acmeId,
		name: 'bot',
		value,
	})
	const resolved = await t.resolveUrl({
		actor: t.requestAs('bea', 'owner'),
		credentialId: id,
		path: '/sendMessage?chat_id=5',
	})
	expect(resolved.url.href).toBe(
		'https://hooks.example.com/bot123:secret-token/sendMessage?key=query-secret&chat_id=5',
	)
	expect(resolved.substitutedValues).toEqual(
		expect.arrayContaining([
			value,
			resolved.url.href,
			'/bot123:secret-token',
			'?key=query-secret',
		]),
	)
})

test("a personal url credential works only in its owner's runs, through a live org grant", async () => {
	const t = await setup()
	const annOrgId = personalOrgId(t.people.ann.personId)
	const id = await t.storeCredential({
		ownerId: annOrgId,
		name: 'my-hook',
		value: hookUrl,
	})
	await expect(
		t.resolveUrl({ actor: t.requestAs('ann', 'member'), credentialId: id }),
	).rejects.toBeInstanceOf(AuthorizationError)
	await grantPersonalCredentialToOrg({
		db: t.db,
		ownerPersonId: t.people.ann.personId,
		credentialId: id,
		orgId: t.acmeId,
	})
	await expect(
		t.resolveUrl({ actor: t.requestAs('ann', 'member'), credentialId: id }),
	).resolves.toMatchObject({ url: new URL(hookUrl) })
	// Not the org Owner, not another member: both see it exactly as a
	// credential id that does not exist.
	for (const [person, role, error] of [
		['bea', 'owner', CredentialNotFoundError],
		['cy', 'member', AuthorizationError],
	] as const) {
		for (const credentialId of [id, 'missing-id']) {
			await expect(
				t.resolveUrl({ actor: t.requestAs(person, role), credentialId }),
			).rejects.toBeInstanceOf(error)
		}
	}
	// In her personal org it is an org credential of that org.
	await expect(
		t.resolveUrl({
			actor: t.requestAs('ann', 'owner', annOrgId),
			credentialId: id,
			orgId: annOrgId,
		}),
	).resolves.toMatchObject({ url: new URL(hookUrl) })
})

test('joinCredentialUrl appends the path and adds the query to the credential URL', () => {
	const base = new URL('https://api.telegram.org/bot123:abc?x=1')
	expect(joinCredentialUrl(base, '/sendMessage?chat_id=5').href).toBe(
		'https://api.telegram.org/bot123:abc/sendMessage?x=1&chat_id=5',
	)
	expect(joinCredentialUrl(new URL('https://h.example.com/'), '/a').href).toBe(
		'https://h.example.com/a',
	)
	expect(joinCredentialUrl(base, '').href).toBe(base.href)
})

/**
 * credential-client builds path from `requestUrl.pathname + requestUrl.search`.
 * URL.pathname is never empty, so fetch(''), fetch('/'), and fetch('?a=1') all
 * arrive here as '/' or '/?a=1'. A bare '/' must not rewrite the stored path.
 */
test('joinCredentialUrl keeps the stored path for bare "/" and query-only refs', () => {
	const file = new URL('https://example.com/path/file.ext')
	const fileSlash = new URL('https://example.com/path/file.ext/')
	const dir = new URL('https://example.com/path/')
	const dirNoSlash = new URL('https://example.com/path')

	expect(joinCredentialUrl(file, '/').href).toBe(
		'https://example.com/path/file.ext',
	)
	expect(joinCredentialUrl(file, '/?a=1').href).toBe(
		'https://example.com/path/file.ext?a=1',
	)
	expect(joinCredentialUrl(fileSlash, '/').href).toBe(
		'https://example.com/path/file.ext/',
	)
	expect(joinCredentialUrl(fileSlash, '/?a=1').href).toBe(
		'https://example.com/path/file.ext/?a=1',
	)
	expect(joinCredentialUrl(dir, '/').href).toBe('https://example.com/path/')
	expect(joinCredentialUrl(dirNoSlash, '/').href).toBe(
		'https://example.com/path',
	)
	expect(joinCredentialUrl(dir, '/sub').href).toBe(
		'https://example.com/path/sub',
	)
	expect(joinCredentialUrl(dirNoSlash, '/sub').href).toBe(
		'https://example.com/path/sub',
	)
})
