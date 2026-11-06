/**
 * Local reads (ADR 0097) against a migrated APP_DB: the switch, Use, the
 * token's local read scope, all-or-nothing reads, and the Local reads list.
 * The fixture value is synthetic; assertions check it never lands in a row.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import type { OrgRole } from '@kody-internal/shared/request-context.ts'
import { expect, test, vi } from 'vitest'
import type { ApiTokenRecord } from '#worker/api-tokens/service.ts'
import { setCredentialLocalReads } from '#app/credential-local-reads.ts'
import type { AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { upsertGrant } from '#worker/orgs/access-writes.ts'
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
import { secretLocalReadDefinition } from '#worker/open-api/secret-local-read-operation.ts'
import { readSecretsLocally } from './local-read.ts'
import {
	listLocalReadEvents,
	readLocalReadSetting,
	setLocalReadEnabled,
} from './local-read-store.ts'

vi.mock(
	'#worker/test-support/apply-all-migrations.ts',
	async (importOriginal) =>
		(await import('./cached-migrations.test-support.ts')).withCachedMigrations(
			await importOriginal(),
		),
)

const fixtureValue = 'synthetic-fixture-value-not-a-secret'
const now = '2026-11-02T00:00:00.000Z'

function token(
	createdVia: string,
	scopes: Array<string> = ['secret:use'],
): ApiTokenRecord {
	return {
		id: `tok_${createdVia}`,
		name: createdVia === 'cli-login' ? 'kody-cli on laptop' : 'agent token',
		created_via: createdVia,
		scopes,
	} as unknown as ApiTokenRecord
}

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const ownerStableId = testStableUserIdFromEmail('owner@example.com')
	const memberId = testStableUserIdFromEmail('member@example.com')
	const orgId = ownerIdFromStored(ownerStableId)
	for (const [stableUserId, username] of [
		[ownerStableId, 'owner'],
		[memberId, 'member'],
	] as const) {
		await provisionPersonalOrg(db, { stableUserId, username, createdAt: now })
	}
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(orgId, memberId, now)
		.run()
	const env = {
		APP_DB: db,
		AUDIT_DB: createAuditTestDb(),
		...createInMemoryUserMeterEnv().env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	for (const name of ['databaseUrl', 'apiKey']) {
		await saveSecret({
			env,
			userId: orgId,
			scope: 'user',
			name,
			value: fixtureValue,
			audit: null,
		})
	}
	const idOf = async (name: string) => {
		const row = await db
			.prepare(`SELECT id FROM secret_entries WHERE name = ?`)
			.bind(name)
			.first<{ id: string }>()
		if (!row) throw new Error(`No secret named ${name}.`)
		return row.id
	}
	const request = (
		stableUserId: string,
		username: string,
		role: OrgRole | null,
		kind: 'api-token' | 'session' = 'api-token',
	) =>
		deriveRequestContext({
			user: { userId: personIdFromStored(stableUserId), username },
			source:
				kind === 'session'
					? { kind: 'session' }
					: { kind: 'api-token', tokenId: 'tok' },
			orgBinding: { org: { id: orgId, slug: 'owner' }, role },
		})
	const read = (input: {
		request: ReturnType<typeof request>
		token: ApiTokenRecord
		names: Array<string>
	}) =>
		readSecretsLocally({
			env,
			baseUrl: 'https://kody.example',
			request: input.request,
			token: input.token,
			names: input.names,
			command: 'get',
			ip: '203.0.113.7',
		})
	const turnOn = async (name: string) =>
		setLocalReadEnabled({
			db,
			credentialId: await idOf(name),
			orgId,
			enabled: true,
			userId: ownerStableId,
		})
	const allEventRows = async () =>
		JSON.stringify(
			(await db.prepare(`SELECT * FROM credential_local_read_events`).all())
				.results,
		)
	return {
		env,
		db,
		orgId,
		ownerStableId,
		memberId,
		idOf,
		request,
		read,
		turnOn,
		allEventRows,
	}
}

test('a secret with local reads off is refused with a link to turn them on, and the refusal is listed', async () => {
	const t = await setup()
	const owner = t.request(t.ownerStableId, 'owner', 'owner')
	const result = await t.read({
		request: owner,
		token: token('cli-login'),
		names: ['databaseUrl'],
	})
	const credentialId = await t.idOf('databaseUrl')
	expect(result).toEqual({
		ok: false,
		refusals: [
			expect.objectContaining({
				name: 'databaseUrl',
				reason: 'local_reads_off',
				approveUrl: `https://kody.example/@owner/-/credentials/${credentialId}/local-reads`,
			}),
		],
	})
	const events = await listLocalReadEvents({ db: t.db, credentialId })
	expect(events).toEqual([
		expect.objectContaining({
			outcome: 'refused',
			refusalReason: 'local_reads_off',
			command: 'get',
			ip: '203.0.113.7',
			actorUsername: 'owner',
			tokenName: 'kody-cli on laptop',
		}),
	])
	expect(await t.allEventRows()).not.toContain(fixtureValue)
})

test('a kody login token reads a secret with local reads on; the read is listed without the value', async () => {
	const t = await setup()
	await t.turnOn('databaseUrl')
	const result = await t.read({
		request: t.request(t.ownerStableId, 'owner', 'owner'),
		token: token('cli-login'),
		names: ['databaseUrl'],
	})
	expect(result.ok).toBe(true)
	if (!result.ok) return
	expect(result.values.map((entry) => entry.name)).toEqual(['databaseUrl'])
	expect(result.values[0]?.value === fixtureValue).toBe(true)
	const credentialId = await t.idOf('databaseUrl')
	const events = await listLocalReadEvents({ db: t.db, credentialId })
	expect(events).toEqual([expect.objectContaining({ outcome: 'allowed' })])
	expect(await t.allEventRows()).not.toContain(fixtureValue)
	expect(
		(await readLocalReadSetting(t.db, credentialId))?.lastReadAt,
	).toBeTruthy()
})

test('an agent-minted token needs secret:read_local', async () => {
	const t = await setup()
	await t.turnOn('databaseUrl')
	const owner = t.request(t.ownerStableId, 'owner', 'owner')
	const refused = await t.read({
		request: owner,
		token: token('cli-bootstrap', ['secret:use']),
		names: ['databaseUrl'],
	})
	expect(refused).toMatchObject({
		ok: false,
		refusals: [{ reason: 'token_scope', approveUrl: null }],
	})
	const allowed = await t.read({
		request: owner,
		token: token('cli-bootstrap', ['secret:use', 'secret:read_local']),
		names: ['databaseUrl'],
	})
	expect(allowed.ok).toBe(true)
})

test('a member without Use on the secret is refused even with local reads on', async () => {
	const t = await setup()
	await t.turnOn('databaseUrl')
	const member = t.request(t.memberId, 'member', 'member')
	const refused = await t.read({
		request: member,
		token: token('cli-login'),
		names: ['databaseUrl'],
	})
	expect(refused).toMatchObject({
		ok: false,
		refusals: [{ reason: 'no_access', approveUrl: null }],
	})
	await upsertGrant({
		db: t.db,
		orgId: t.orgId,
		resourceType: 'credential',
		resourceId: await t.idOf('databaseUrl'),
		family: 'secret',
		subject: { type: 'user', id: t.memberId },
		preset: 'use',
		permissions: null,
		createdByUserId: t.ownerStableId,
		audit: createTestOrgAuditWriter(),
	})
	const allowed = await t.read({
		request: t.request(t.memberId, 'member', 'member'),
		token: token('cli-login'),
		names: ['databaseUrl'],
	})
	expect(allowed.ok).toBe(true)
})

test('reads are all or nothing: one refused secret reads none', async () => {
	const t = await setup()
	await t.turnOn('databaseUrl')
	const result = await t.read({
		request: t.request(t.ownerStableId, 'owner', 'owner'),
		token: token('cli-login'),
		names: ['databaseUrl', 'apiKey', 'missingName'],
	})
	expect(result).toMatchObject({
		ok: false,
		refusals: [
			{ name: 'databaseUrl', reason: 'other_secret_refused' },
			{ name: 'apiKey', reason: 'local_reads_off' },
			{ name: 'missingName', reason: 'not_found' },
		],
	})
	expect(JSON.stringify(result)).not.toContain(fixtureValue)
})

test('the read API refuses the MCP api tool and execution-context runs', async () => {
	for (const principal of [
		{ kind: 'mcp' },
		{ kind: 'mcp-oauth', expiresAtUnix: 0, grantScopes: [] },
	]) {
		await expect(
			secretLocalReadDefinition.handler(
				{ names: ['databaseUrl'], command: 'get' },
				{ principal, callerContext: {}, env: {} } as never,
			),
		).rejects.toMatchObject({ code: 'invalid_request' })
	}
})

test('only a website session with write access turns local reads on', async () => {
	const t = await setup()
	const credentialId = await t.idOf('databaseUrl')
	const user = (request: ReturnType<typeof t.request>) =>
		({
			request,
			mcpUser: { userId: request.actor?.userId },
		}) as unknown as AuthenticatedAppUser
	const viaToken = await setCredentialLocalReads({
		env: t.env,
		user: user(t.request(t.ownerStableId, 'owner', 'owner', 'api-token')),
		credentialId,
		enabled: true,
	})
	expect(viaToken.status).toBe(403)
	const memberSession = await setCredentialLocalReads({
		env: t.env,
		user: user(t.request(t.memberId, 'member', 'member', 'session')),
		credentialId,
		enabled: true,
	})
	expect(memberSession.status).toBe(403)
	expect((await readLocalReadSetting(t.db, credentialId))?.enabled).not.toBe(
		true,
	)
	const ownerSession = await setCredentialLocalReads({
		env: t.env,
		user: user(t.request(t.ownerStableId, 'owner', 'owner', 'session')),
		credentialId,
		enabled: true,
	})
	expect(ownerSession.status).toBe(200)
	expect((await readLocalReadSetting(t.db, credentialId))?.enabled).toBe(true)
})
