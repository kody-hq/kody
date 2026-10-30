/**
 * secretSet `sealed_token` with `login_exchange` (ADR 0090): a sealed refresh
 * token from this run is saved as a login credential the host opened, against
 * a fully migrated APP_DB.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { sealTokenResponse } from '#worker/credentials/sealed-token.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { decryptSecretValue, userSecretContext } from '#mcp/secrets/crypto.ts'
import { secretSetCapability } from './secret-set.ts'

const now = '2026-10-28T00:00:00.000Z'
const refreshToken = 'dummy-refresh-token-1'

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	const db = createD1FromSqlite(sqlite)
	const auditDb = createAuditTestDb()
	const ownerId = testStableUserIdFromEmail('owner@example.com')!
	await db
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, created_at, updated_at, stable_user_id)
			 VALUES (1, 'owneruser', 'owneruser@example.com', 'h', ?, ?, ?)`,
		)
		.bind(now, now, ownerId)
		.run()
	await provisionPersonalOrg(db, {
		stableUserId: ownerId,
		username: 'owneruser',
		createdAt: now,
	})
	const env = {
		APP_DB: db,
		AUDIT_DB: auditDb,
		...createInMemoryUserMeterEnv().env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	const org = ownerIdFromStored(ownerId)
	const ctx = (
		binding: string | undefined = 'run:1',
		packageId: string | null = null,
	) => ({
		env,
		openApiPrincipal: { kind: 'mcp' } as const,
		...(binding ? { credentialClientBinding: binding } : {}),
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored(ownerId),
				email: 'owneruser@example.com',
				displayName: 'owneruser',
				username: 'owneruser',
			},
			orgBinding: { org: { id: org, slug: 'owneruser' }, role: 'owner' },
			...(packageId
				? {
						storageContext: {
							sessionId: null,
							appId: null,
							packageId,
							storageId: null,
						},
					}
				: {}),
		}),
	})
	const entry = async (name: string) =>
		await db
			.prepare(
				`SELECT e.id, e.kind, e.allowed_hosts, e.placement_json, e.encrypted_value
				 FROM secret_entries e JOIN secret_buckets b ON b.id = e.bucket_id
				 WHERE b.user_id = ? AND b.scope = 'user' AND e.name = ? AND e.deleted_at IS NULL`,
			)
			.bind(ownerId, name)
			.first<{
				id: string
				kind: string
				allowed_hosts: string
				placement_json: string | null
				encrypted_value: string
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
	/** A refresh token request through the gateway, as `sealTokenResponse` seals it. */
	const exchange = async (input: { binding?: string } = {}) => {
		const response = await sealTokenResponse({
			env,
			response: Response.json({
				access_token: 'dummy-access-token',
				refresh_token: refreshToken,
			}),
			requestUrl: 'https://auth.example.com/oauth/token',
			approvedHosts: ['auth.example.com', 'api.example.com'],
			filledValues: ['dummy-client-secret'],
			org,
			binding: input.binding ?? 'run:1',
		})
		const body = (await response.json()) as { refresh_token: string }
		return body.refresh_token
	}
	const set = (input: Record<string, unknown>, as = ctx()) =>
		secretSetCapability.handler({ scope: 'user', ...input } as never, as)
	return { env, db, org, ctx, entry, audits, exchange, set }
}

const loginExchange = {
	url: 'https://auth.example.com/oauth/token',
	bodyFormat: 'form',
	body: {
		grant_type: 'refresh_token',
		client_id: 'token-demo',
		refresh_token: '{refresh_token}',
	},
	tokenPath: 'access_token',
	expiresInPath: 'expires_in',
}

test('a sealed refresh token with a login exchange saves as a login credential on its save hosts, never returned', async () => {
	const t = await setup()
	const sealed = await t.exchange()
	expect(sealed).not.toContain(refreshToken)
	const saved = await t.set({
		name: 'token-demo',
		sealed_token: sealed,
		login_exchange: loginExchange,
	})
	expect(JSON.stringify(saved)).not.toContain(refreshToken)
	expect(saved).toMatchObject({ name: 'token-demo', kind: 'login' })
	const row = await t.entry('token-demo')
	expect(row).toMatchObject({ kind: 'login' })
	expect(JSON.parse(row!.allowed_hosts).sort()).toEqual([
		'api.example.com',
		'auth.example.com',
	])
	await expect(
		decryptSecretValue(t.env, row!.encrypted_value, userSecretContext(t.org)),
	).resolves.toBe(JSON.stringify({ refresh_token: refreshToken }))
	const audits = await t.audits('credential.kind_set')
	expect(audits).toEqual([
		{
			resourceId: row!.id,
			details: expect.objectContaining({
				kind: { before: null, after: 'login' },
				loginExchangeHost: { before: null, after: 'auth.example.com' },
				savedFrom: 'sealed_token',
			}),
		},
	])
	expect(JSON.stringify(audits)).not.toContain(refreshToken)

	// The next run's refresh token replaces the value under the same name.
	await t.set(
		{
			name: 'token-demo',
			sealed_token: await t.exchange({ binding: 'run:2' }),
			login_exchange: loginExchange,
		},
		t.ctx('run:2'),
	)
	expect((await t.entry('token-demo'))!.id).toBe(row!.id)
})

test('the exchange must go to a save host and send the sealed token as a login field', async () => {
	const t = await setup()
	await expect(
		t.set({
			name: 'token-demo',
			sealed_token: await t.exchange(),
			login_exchange: {
				...loginExchange,
				url: 'https://other.example.com/token',
			},
		}),
	).rejects.toThrow(
		"The login exchange url's host must be one of the credential's hosts.",
	)
	await expect(
		t.set({
			name: 'token-demo',
			sealed_token: await t.exchange(),
			login_exchange: {
				...loginExchange,
				body: { grant_type: 'client_credentials', client_id: 'token-demo' },
			},
		}),
	).rejects.toThrow('login_exchange.body must send the sealed refresh token')
	await expect(
		t.set({
			name: 'token-demo',
			sealed_token: await t.exchange(),
			login_exchange: {
				...loginExchange,
				body: {
					...loginExchange.body,
					client_secret: '{client_secret}',
				},
			},
		}),
	).rejects.toThrow('no other login field')
	expect(await t.entry('token-demo')).toBeNull()
})

test('a sealed login never takes over a Key, and replacing a login keeps its narrower hosts', async () => {
	const t = await setup()
	await t.set({ name: 'demo-key', value: 'dummy-key-value' })
	await expect(
		t.set({
			name: 'demo-key',
			sealed_token: await t.exchange(),
			login_exchange: loginExchange,
		}),
	).rejects.toThrow('is a secret credential')

	await t.set({
		name: 'token-demo',
		sealed_token: await t.exchange(),
		login_exchange: loginExchange,
	})
	await t.db
		.prepare(`UPDATE secret_entries SET allowed_hosts = ? WHERE id = ?`)
		.bind(
			JSON.stringify(['auth.example.com']),
			(await t.entry('token-demo'))!.id,
		)
		.run()
	await t.set({
		name: 'token-demo',
		sealed_token: await t.exchange(),
		login_exchange: loginExchange,
	})
	expect(JSON.parse((await t.entry('token-demo'))!.allowed_hosts)).toEqual([
		'auth.example.com',
	])
})

test('another run, package code, and explicit hosts or kind are still refused', async () => {
	const t = await setup()
	const sealed = await t.exchange()
	await expect(
		t.set(
			{
				name: 'token-demo',
				sealed_token: sealed,
				login_exchange: loginExchange,
			},
			t.ctx('run:2'),
		),
	).rejects.toThrow('This sealed token belongs to another run.')
	await expect(
		t.set(
			{
				name: 'token-demo',
				sealed_token: sealed,
				login_exchange: loginExchange,
			},
			t.ctx('run:1', 'package-token-demo'),
		),
	).rejects.toThrow('Package code cannot keep a sealed token')
	await expect(
		t.set({
			name: 'token-demo',
			sealed_token: sealed,
			login_exchange: loginExchange,
			hosts: ['api.example.com'],
		}),
	).rejects.toThrow(
		'sealed_token sets the value, hosts, and placement from the sealed token',
	)
	expect(await t.entry('token-demo')).toBeNull()
})
