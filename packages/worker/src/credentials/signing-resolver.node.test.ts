import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import type { OrgRole } from '@kody-internal/shared/request-context.ts'
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
import { computeWebhookHmacSignature } from '#worker/webhooks/crypto.ts'
import { saveSecret } from '#mcp/secrets/service.ts'
import type { AuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	loadCredentialRawSigningView,
	setCredentialRawSigning,
} from '#app/credential-raw-signing.ts'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import {
	listRawSigningEvents,
	readRawSigningSetting,
} from './raw-signing-store.ts'
import {
	CredentialNotFoundError,
	CredentialRequestRefusedError,
} from './credential-request.ts'
import { resolveCredential } from './resolve-credential.ts'
import type { SigningOperation } from './signing-resolver.ts'

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
const hmacKey = 'whsec-signing-key-material-0123456789'
const hmac: SigningOperation = {
	type: 'hmac',
	algorithm: 'hmac-sha256',
	message: '1700000000.{"id":1}',
	encoding: 'hex',
	prefix: 'sha256=',
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
			slug: 'acme-signing',
			displayName: 'Acme',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const acme = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'acme-signing'`)
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
		value: string
		kind?: string
		hosts?: Array<string>
	}) => {
		await saveSecret({
			env,
			userId: acmeId,
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
				input.kind ?? 'signing',
				JSON.stringify(input.hosts ?? ['api.example.com']),
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
			orgBinding: { org: { id: acmeId, slug: 'acme-signing' }, role },
		})
	const sign = (input: {
		actor: ReturnType<typeof requestAs>
		credentialId: string
		requestHost?: string
		operation?: SigningOperation
	}) =>
		resolveCredential({
			env,
			orgId: acmeId,
			actor: input.actor,
			baseUrl: 'https://example.com',
			credential: {
				use: 'signing',
				credentialId: input.credentialId,
				requestHost: input.requestHost ?? 'api.example.com',
				operation: input.operation ?? hmac,
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
	return { storeCredential, requestAs, sign, grantUse, audits, db, acmeId, env }
}

test('a signing credential returns only an HMAC signature, for an actor with Use', async () => {
	const t = await setup()
	const id = await t.storeCredential({ name: 'webhook-key', value: hmacKey })
	const expected = await computeWebhookHmacSignature({
		algorithm: 'hmac-sha256',
		secret: hmacKey,
		body: new TextEncoder().encode('1700000000.{"id":1}').buffer as ArrayBuffer,
		encoding: 'hex',
		prefix: 'sha256=',
	})
	const signed = await t.sign({
		actor: t.requestAs('bea', 'owner'),
		credentialId: id,
	})
	expect(signed).toEqual({ signature: expected })
	expect(valueReads.count).toBe(1)

	await expect(
		t.sign({ actor: t.requestAs('ann', 'member'), credentialId: id }),
	).rejects.toBeInstanceOf(AuthorizationError)
	expect(valueReads.count).toBe(1)
	await t.grantUse(id)
	await expect(
		t.sign({ actor: t.requestAs('ann', 'member'), credentialId: id }),
	).resolves.toEqual({ signature: expected })

	const rows = await t.audits()
	expect(rows.map((row) => row.result)).toEqual([
		'success',
		'denied',
		'success',
	])
	expect(JSON.parse(rows[0]!.details_json)).toMatchObject({
		use: 'signing',
		operation: 'hmac',
		algorithm: 'hmac-sha256',
	})
	expect(JSON.stringify(rows)).not.toContain(hmacKey)
})

test('HMAC sign accepts a Key (secret kind); JWT still requires signing', async () => {
	const t = await setup()
	const expected = await computeWebhookHmacSignature({
		algorithm: 'hmac-sha256',
		secret: hmacKey,
		body: new TextEncoder().encode('1700000000.{"id":1}').buffer as ArrayBuffer,
		encoding: 'hex',
		prefix: 'sha256=',
	})
	const keyId = await t.storeCredential({
		name: 'xClientSecret',
		value: hmacKey,
		kind: 'secret',
	})
	await expect(
		t.sign({
			actor: t.requestAs('bea', 'owner'),
			credentialId: keyId,
		}),
	).resolves.toEqual({ signature: expected })
	await expect(
		t.sign({
			actor: t.requestAs('bea', 'owner'),
			credentialId: keyId,
			operation: {
				type: 'jwt',
				algorithm: 'HS256',
				claims: { sub: 'user-1', iat: 1700000000 },
			},
		}),
	).rejects.toBeInstanceOf(CredentialNotFoundError)
})

test('a signing credential signs a JWT the same way secretJwtSign does', async () => {
	const t = await setup()
	const key = btoa('k'.repeat(32))
	const id = await t.storeCredential({ name: 'jwt-key', value: key })
	const operation = {
		type: 'jwt',
		algorithm: 'HS256',
		claims: { sub: 'user-1', iat: 1700000000 },
	} as const
	const signed = await t.sign({
		actor: t.requestAs('bea', 'owner'),
		credentialId: id,
		operation,
	})
	const parts = signed.signature.split('.')
	expect(parts).toHaveLength(3)
	expect(
		JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()),
	).toMatchObject({
		sub: 'user-1',
		iat: 1700000000,
	})
	const hmacKey = await crypto.subtle.importKey(
		'raw',
		Buffer.from(key, 'base64'),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['verify'],
	)
	expect(
		await crypto.subtle.verify(
			'HMAC',
			hmacKey,
			Buffer.from(parts[2]!, 'base64url'),
			new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
		),
	).toBe(true)
})

test('HMAC refuses credentials without hosts; missing ids stay not-found', async () => {
	const t = await setup()
	const actor = t.requestAs('bea', 'owner')
	await expect(
		t.sign({ actor, credentialId: 'missing-id' }),
	).rejects.toBeInstanceOf(CredentialNotFoundError)
	const noHosts = await t.storeCredential({
		name: 'no-hosts',
		value: hmacKey,
		hosts: [],
	})
	await expect(t.sign({ actor, credentialId: noHosts })).rejects.toBeInstanceOf(
		CredentialRequestRefusedError,
	)
	const keyNoHosts = await t.storeCredential({
		name: 'plain-key-no-hosts',
		value: hmacKey,
		kind: 'secret',
		hosts: [],
	})
	await expect(
		t.sign({ actor, credentialId: keyNoHosts }),
	).rejects.toBeInstanceOf(CredentialRequestRefusedError)
	expect(valueReads.count).toBe(0)
})

test('a signature is only made for a request to one of the credential hosts', async () => {
	const t = await setup()
	const actor = t.requestAs('bea', 'owner')
	const id = await t.storeCredential({
		name: 'webhook-key',
		value: hmacKey,
		hosts: ['*.example.com'],
	})
	await expect(
		t.sign({ actor, credentialId: id, requestHost: 'evil.example.net' }),
	).rejects.toMatchObject({ code: 'host_not_allowed' })
	expect(valueReads.count).toBe(0)
	await expect(
		t.sign({ actor, credentialId: id, requestHost: 'eu.example.com' }),
	).resolves.toHaveProperty('signature')
	const rows = await t.audits()
	expect(rows.map((row) => row.result)).toEqual(['denied', 'success'])
	expect(JSON.parse(rows[0]!.details_json)).toMatchObject({
		host: 'evil.example.net',
	})
})

// Generated for this test file only; never a real key.
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
const rsaPem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const rsaPemBody = rsaPem.split('\n')[1]!
const oracleHost = 'iaas.us-phoenix-1.oraclecloud.com'
const oracleGet: SigningOperation = {
	type: 'http-signature',
	keyId: 'ocid1.tenancy.oc1..t/ocid1.user.oc1..u/aa:bb',
	method: 'GET',
	url: `https://${oracleHost}/20160918/instances?compartmentId=c1`,
	headers: { date: 'Thu, 05 Jan 2014 21:31:40 GMT' },
}
const rawMessage = 'sensitive-payload-for-raw-signing'

function rsaVerify(message: string, signature: string) {
	const verifier = createVerify('RSA-SHA256')
	verifier.update(message)
	return verifier.verify(rsa.publicKey, signature, 'base64')
}

async function setupRsa() {
	const t = await setup()
	const id = await t.storeCredential({
		name: 'oracle-api-key',
		value: rsaPem,
		hosts: [oracleHost, '*.objectstorage.oraclecloud.com'],
	})
	const session = (person: 'ann' | 'bea', role: OrgRole) =>
		({
			request: deriveRequestContext({
				user: {
					userId: personIdFromStored(
						testStableUserIdFromEmail(`${person}@example.com`),
					),
					username: person,
				},
				source: { kind: 'session' },
				orgBinding: { org: { id: t.acmeId, slug: 'acme-signing' }, role },
			}),
			mcpUser: { userId: t.acmeId },
		}) as unknown as AuthenticatedAppUser
	return { ...t, id, session }
}

test('http-signature returns only headers for an allowed host, and the audit has no key or signature', async () => {
	const t = await setupRsa()
	const signed = (await t.sign({
		actor: t.requestAs('bea', 'owner'),
		credentialId: t.id,
		requestHost: oracleHost,
		operation: oracleGet,
	})) as { signature: string; headers: Record<string, string> }
	expect(Object.keys(signed.headers)).toEqual(['authorization'])
	expect(signed.signature).toBe(signed.headers.authorization)
	const signature = /signature="([^"]+)"/.exec(signed.signature)![1]!
	expect(
		rsaVerify(
			[
				'date: Thu, 05 Jan 2014 21:31:40 GMT',
				'(request-target): get /20160918/instances?compartmentId=c1',
				`host: ${oracleHost}`,
			].join('\n'),
			signature,
		),
	).toBe(true)
	expect(JSON.stringify(signed)).not.toContain(rsaPemBody)
	const rows = await t.audits()
	expect(rows.map((row) => row.result)).toEqual(['success'])
	expect(JSON.parse(rows[0]!.details_json)).toMatchObject({
		use: 'signing',
		host: oracleHost,
		operation: 'http-signature',
		algorithm: 'rsa-sha256',
		scheme: 'draft-cavage',
		profile: 'oracle',
	})
	expect(JSON.stringify(rows)).not.toContain(rsaPemBody)
	expect(JSON.stringify(rows)).not.toContain(signature)
})

test('http-signature refuses other hosts, a host that differs from the url, and redirect targets off the hosts', async () => {
	const t = await setupRsa()
	const actor = t.requestAs('bea', 'owner')
	// A wildcard host signs one label below it.
	await expect(
		t.sign({
			actor,
			credentialId: t.id,
			requestHost: 'ns.objectstorage.oraclecloud.com',
			operation: {
				...oracleGet,
				url: 'https://ns.objectstorage.oraclecloud.com/n/ns',
			},
		}),
	).resolves.toMatchObject({ headers: { authorization: expect.any(String) } })
	const refusedCases: Array<{
		requestHost: string
		url: string
		code: string
	}> = [
		// Not one of the credential's hosts.
		{
			requestHost: 'evil.example.com',
			url: 'https://evil.example.com/x',
			code: 'host_not_allowed',
		},
		// The client names an allowed host but the url points elsewhere.
		{
			requestHost: oracleHost,
			url: 'https://evil.example.com/x',
			code: 'host_not_allowed',
		},
		// A redirect Location on another host is a new request, so it is refused.
		{
			requestHost: 'login.evil.example.com',
			url: 'https://login.evil.example.com/20160918/instances',
			code: 'host_not_allowed',
		},
		// Lookalike and deeper subdomains do not match.
		{
			requestHost: `${oracleHost}.evil.example.com`,
			url: `https://${oracleHost}.evil.example.com/`,
			code: 'host_not_allowed',
		},
		{
			requestHost: 'a.b.objectstorage.oraclecloud.com',
			url: 'https://a.b.objectstorage.oraclecloud.com/',
			code: 'host_not_allowed',
		},
		// Downgrade to http.
		{
			requestHost: oracleHost,
			url: `http://${oracleHost}/x`,
			code: 'insecure_transport',
		},
	]
	for (const item of refusedCases) {
		const error = await t
			.sign({
				actor,
				credentialId: t.id,
				requestHost: item.requestHost,
				operation: { ...oracleGet, url: item.url },
			})
			.then(
				() => null,
				(caught: unknown) => caught,
			)
		expect(error, item.url).toBeInstanceOf(CredentialRequestRefusedError)
		expect((error as CredentialRequestRefusedError).code, item.url).toBe(
			item.code,
		)
	}
	// A refused request never reads the key.
	expect(valueReads.count).toBe(1)
})

test('raw RSA signing is refused by default and the refusal is listed without the message', async () => {
	const t = await setupRsa()
	await expect(
		t.sign({
			actor: t.requestAs('bea', 'owner'),
			credentialId: t.id,
			requestHost: oracleHost,
			operation: { type: 'rsa-sha256', message: rawMessage },
		}),
	).rejects.toMatchObject({ code: 'raw_signing_off' })
	expect(valueReads.count).toBe(0)
	const events = await listRawSigningEvents({ db: t.db, credentialId: t.id })
	expect(events).toEqual([
		expect.objectContaining({
			actorUsername: 'bea',
			via: 'mcp-oauth',
			outcome: 'refused',
			refusalReason: 'raw_signing_off',
			messageBytes: null,
		}),
	])
	const rows = await t.audits()
	expect(rows.map((row) => row.result)).toEqual(['denied'])
	expect(JSON.stringify([events, rows])).not.toContain(rawMessage)
})

test('only the owner on a website session turns raw signing on; then each signature is listed; turning it off stops new ones', async () => {
	const t = await setupRsa()
	await t.grantUse(t.id)
	await upsertGrant({
		db: t.db,
		orgId: t.acmeId,
		resourceType: 'credential',
		resourceId: t.id,
		family: 'secret',
		subject: { type: 'user', id: testStableUserIdFromEmail('ann@example.com') },
		preset: 'manage',
		permissions: null,
		createdByUserId: testStableUserIdFromEmail('bea@example.com'),
		audit: createTestOrgAuditWriter(),
	})
	const viaMcp = {
		request: t.requestAs('bea', 'owner'),
		mcpUser: { userId: t.acmeId },
	} as unknown as AuthenticatedAppUser
	const attempts = [
		await setCredentialRawSigning({
			env: t.env,
			user: viaMcp,
			credentialId: t.id,
			enabled: true,
		}),
		await setCredentialRawSigning({
			env: t.env,
			user: t.session('ann', 'member'),
			credentialId: t.id,
			enabled: true,
		}),
	]
	expect(attempts.map((attempt) => attempt.status)).toEqual([403, 403])
	expect(await readRawSigningSetting(t.db, t.id)).toBeNull()
	const memberView = await loadCredentialRawSigningView({
		env: t.env,
		request: t.session('ann', 'member').request,
		credentialId: t.id,
	})
	expect(memberView).toMatchObject({ canChange: false, enabled: false })

	const owner = await setCredentialRawSigning({
		env: t.env,
		user: t.session('bea', 'owner'),
		credentialId: t.id,
		enabled: true,
	})
	expect(owner.status).toBe(200)
	const signed = (await t.sign({
		actor: t.requestAs('ann', 'member'),
		credentialId: t.id,
		requestHost: oracleHost,
		operation: { type: 'rsa-sha256', message: rawMessage },
	})) as { signature: string }
	expect(rsaVerify(rawMessage, signed.signature)).toBe(true)

	const off = await setCredentialRawSigning({
		env: t.env,
		user: t.session('bea', 'owner'),
		credentialId: t.id,
		enabled: false,
	})
	expect(off.status).toBe(200)
	await expect(
		t.sign({
			actor: t.requestAs('ann', 'member'),
			credentialId: t.id,
			requestHost: oracleHost,
			operation: { type: 'rsa-sha256', message: rawMessage },
		}),
	).rejects.toMatchObject({ code: 'raw_signing_off' })

	const ownerView = await loadCredentialRawSigningView({
		env: t.env,
		request: t.session('bea', 'owner').request,
		credentialId: t.id,
	})
	expect(ownerView).toMatchObject({ canChange: true, enabled: false })
	expect(ownerView?.lastSignedAt).toEqual(expect.any(String))
	expect(
		ownerView?.signatures?.map((row) => [
			row.who,
			row.signed,
			row.refusal,
			row.messageBytes,
		]),
	).toEqual([
		['ann', false, 'Raw signing was off', null],
		['ann', true, null, rawMessage.length],
	])
	const events = await listRawSigningEvents({ db: t.db, credentialId: t.id })
	const stored = JSON.stringify(events)
	expect(stored).not.toContain(rawMessage)
	expect(stored).not.toContain(signed.signature)
	expect(stored).not.toContain(rsaPemBody)
	const rows = await t.audits()
	expect(rows.map((row) => row.result)).toEqual(['success', 'denied'])
	expect(JSON.stringify(rows)).not.toContain(signed.signature)
	expect(JSON.stringify(rows)).not.toContain(rawMessage)
})

test('package code cannot sign raw strings without the switch, and signing other kinds of key is refused', async () => {
	const t = await setupRsa()
	const keyId = await t.storeCredential({
		name: 'plain-key',
		value: rsaPem,
		kind: 'secret',
		hosts: [oracleHost],
	})
	for (const operation of [
		oracleGet,
		{ type: 'rsa-sha256', message: 'x' },
	] as Array<SigningOperation>) {
		await expect(
			t.sign({
				actor: t.requestAs('bea', 'owner'),
				credentialId: keyId,
				requestHost: oracleHost,
				operation,
			}),
		).rejects.toBeInstanceOf(CredentialNotFoundError)
	}
	expect(valueReads.count).toBe(0)
})
