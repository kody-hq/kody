/**
 * secretSet `sealed_token` (ADR 0068, 2026-10-28): a sealed token from this
 * run is saved as a Key the host opened, against a fully migrated APP_DB.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { effectiveFillPlacement } from '#worker/credentials/fill-placement-enforcement.ts'
import { readCredentialFillPlacement } from '#worker/credentials/fill-placement.ts'
import { readFillPlacementOptIn } from '#worker/credentials/fill-placement-opt-ins.ts'
import {
	sealToken,
	sealTokenResponse,
} from '#worker/credentials/sealed-token.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { decryptSecretValue, userSecretContext } from '#mcp/secrets/crypto.ts'
import { secretSetManyCapability } from './secret-set-many.ts'
import { secretSetCapability } from './secret-set.ts'

const now = '2026-10-28T00:00:00.000Z'
const plaidToken = 'access-sandbox-plaid-item-token-value'

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
	const ctx = (binding: string | undefined = 'run:1') => ({
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
	/** A Plaid token exchange through the gateway, as `sealTokenResponse` seals it. */
	const exchange = async (
		input: {
			binding?: string
			org?: string
			filledValues?: Array<string>
		} = {},
	) => {
		const response = await sealTokenResponse({
			env,
			response: Response.json({ access_token: plaidToken, item_id: 'item-1' }),
			requestUrl: 'https://sandbox.plaid.com/item/public_token/exchange',
			approvedHosts: ['sandbox.plaid.com', 'production.plaid.com'],
			filledValues: input.filledValues ?? ['plaid-client-secret'],
			org: input.org ?? org,
			binding: input.binding ?? 'run:1',
		})
		const body = (await response.json()) as { access_token: string }
		return body.access_token
	}
	const set = (input: Record<string, unknown>, as = ctx()) =>
		secretSetCapability.handler({ scope: 'user', ...input } as never, as)
	return { env, db, org, ctx, entry, audits, exchange, set }
}

test('a sealed Plaid access_token saves as a Key on its hosts, body-placed, never returned', async () => {
	const t = await setup()
	const sealed = await t.exchange()
	const saved = await t.set({ name: 'plaidAccessToken', sealed_token: sealed })
	expect(JSON.stringify(saved)).not.toContain(plaidToken)
	expect(saved).toMatchObject({
		name: 'plaidAccessToken',
		allowed_hosts: ['production.plaid.com', 'sandbox.plaid.com'],
		placement: { headers: true, body: true },
		kind: 'secret',
	})
	const row = await t.entry('plaidAccessToken')
	expect(row).toMatchObject({ kind: 'secret' })
	await expect(
		decryptSecretValue(t.env, row!.encrypted_value, userSecretContext(t.org)),
	).resolves.toBe(plaidToken)
	const optIn = await readFillPlacementOptIn(t.db, row!.id)
	expect(optIn).toEqual({ query: false, path: false, body: true })
	const source = await t.db
		.prepare(
			`SELECT source FROM credential_fill_placement_opt_ins WHERE credential_id = ?`,
		)
		.bind(row!.id)
		.first<{ source: string }>()
	expect(source?.source).toBe('sealed_token')
	expect(
		effectiveFillPlacement(
			readCredentialFillPlacement(row!.placement_json),
			optIn,
		),
	).toEqual({ headers: true, body: true })
	expect(await t.audits('credential.kind_set')).toEqual([
		{
			resourceId: row!.id,
			details: {
				kind: { before: null, after: 'secret' },
				hosts: {
					before: null,
					after: ['sandbox.plaid.com', 'production.plaid.com'],
				},
				placement: { before: null, after: { headers: true, body: true } },
				savedFrom: 'sealed_token',
			},
		},
	])
	expect(await t.audits('credential.created')).toHaveLength(1)

	// Re-linking the Item replaces the value under the same name.
	const relinked = await t.exchange()
	await t.set({ name: 'plaidAccessToken', sealed_token: relinked })
	expect((await t.entry('plaidAccessToken'))!.id).toBe(row!.id)
})

test('re-linking an existing Key never widens its hosts, placement, or opt-ins', async () => {
	const t = await setup()
	await t.set({ name: 'plaidAccessToken', sealed_token: await t.exchange() })
	const row = await t.entry('plaidAccessToken')
	// The owner narrowed the Key to production and headers, and turned the body off.
	await t.db
		.prepare(
			`UPDATE secret_entries SET allowed_hosts = ?, placement_json = ? WHERE id = ?`,
		)
		.bind('["production.plaid.com"]', '{"headers":true}', row!.id)
		.run()
	await t.db
		.prepare(
			`UPDATE credential_fill_placement_opt_ins SET body = 0, source = 'owner' WHERE credential_id = ?`,
		)
		.bind(row!.id)
		.run()
	const saved = await t.set({
		name: 'plaidAccessToken',
		sealed_token: await t.exchange(),
	})
	expect(saved).toMatchObject({
		allowed_hosts: ['production.plaid.com'],
		placement: { headers: true },
	})
	const after = await t.entry('plaidAccessToken')
	expect(after).toMatchObject({
		id: row!.id,
		allowed_hosts: '["production.plaid.com"]',
		placement_json: '{"headers":true}',
	})
	await expect(readFillPlacementOptIn(t.db, row!.id)).resolves.toEqual({
		query: false,
		path: false,
		body: false,
	})
	const source = await t.db
		.prepare(
			`SELECT source FROM credential_fill_placement_opt_ins WHERE credential_id = ?`,
		)
		.bind(row!.id)
		.first<{ source: string }>()
	expect(source?.source).toBe('owner')

	// A Key on hosts the sealed token may not reach is refused, not re-pointed.
	await t.db
		.prepare(`UPDATE secret_entries SET allowed_hosts = ? WHERE id = ?`)
		.bind('["api.example.com"]', row!.id)
		.run()
	await expect(
		t.set({ name: 'plaidAccessToken', sealed_token: await t.exchange() }),
	).rejects.toThrow(/approved for hosts this sealed token may not go to/)
	await t.db
		.prepare(
			`UPDATE secret_entries SET allowed_hosts = ?, placement_json = ? WHERE id = ?`,
		)
		.bind('["production.plaid.com"]', '{"query":true}', row!.id)
		.run()
	await expect(
		t.set({ name: 'plaidAccessToken', sealed_token: await t.exchange() }),
	).rejects.toThrow(/may not fill a header or the body/)
})

test('a sealed token from another run, another account, or past its expiry is refused', async () => {
	const t = await setup()
	await expect(
		t.set({ name: 'k', sealed_token: await t.exchange({ binding: 'run:2' }) }),
	).rejects.toThrow(
		'This sealed token belongs to another run. Mint a new one in this run.',
	)
	await expect(
		t.set({ name: 'k', sealed_token: await t.exchange() }, t.ctx('')),
	).rejects.toThrow(/another run/)
	await expect(
		t.set({ name: 'k', sealed_token: await t.exchange({ org: 'org-else' }) }),
	).rejects.toThrow('This sealed token belongs to another account.')
	const expired = await sealToken({
		env: t.env,
		value: plaidToken,
		to: {
			org: t.org,
			binding: 'run:1',
			domains: ['plaid.com'],
			source: 'token-response',
			saveHosts: ['sandbox.plaid.com'],
		},
		now: 0,
	})
	await expect(t.set({ name: 'k', sealed_token: expired })).rejects.toThrow(
		'This sealed token expired. Mint a new one.',
	)
	await expect(
		t.set({ name: 'k', sealed_token: 'kody-sealed.not-real.handle' }),
	).rejects.toThrow('This sealed token was not issued by this Kody.')
	await expect(
		t.set({ name: 'k', sealed_token: 'plain-text' }),
	).rejects.toThrow(/sealed_token must be the/)
	expect(await t.entry('k')).toBeNull()
})

test('a signed JWT, an echoed credential, and a pre-save token cannot be saved', async () => {
	const t = await setup()
	const jwt = await sealToken({
		env: t.env,
		value: 'header.claims.signature',
		to: { org: t.org, binding: 'run:1', domains: ['*'], source: 'jwt-sign' },
	})
	await expect(t.set({ name: 'k', sealed_token: jwt })).rejects.toThrow(
		/signed JWT cannot be saved/,
	)
	const echoed = await t.exchange({ filledValues: [plaidToken] })
	await expect(t.set({ name: 'k', sealed_token: echoed })).rejects.toThrow(
		/repeats a credential/,
	)
	const legacy = await sealToken({
		env: t.env,
		value: plaidToken,
		to: { org: t.org, binding: 'run:1', domains: ['plaid.com'] },
	})
	await expect(t.set({ name: 'k', sealed_token: legacy })).rejects.toThrow(
		/cannot be saved/,
	)
	expect(await t.entry('k')).toBeNull()
})

test('a sealed token as a plain value is refused and points at sealed_token', async () => {
	const t = await setup()
	const sealed = await t.exchange()
	await expect(t.set({ name: 'k', value: sealed })).rejects.toThrow(
		/Pass it as secretSet\(\{ name, scope: "user", sealed_token \}\)/,
	)
	await expect(
		secretSetManyCapability.handler(
			{ secrets: [{ name: 'k', scope: 'user', value: sealed }] } as never,
			t.ctx(),
		),
	).rejects.toThrow(/sealed_token/)
	expect(await t.entry('k')).toBeNull()
})

test('sealed_token brings its own hosts and placement and saves only user scope', async () => {
	const t = await setup()
	const sealed = await t.exchange()
	await expect(
		t.set({ name: 'k', sealed_token: sealed, hosts: ['evil.test'] }),
	).rejects.toThrow(/drop hosts/)
	await expect(
		t.set({ name: 'k', sealed_token: sealed, placement: { query: true } }),
	).rejects.toThrow(/drop placement/)
	await expect(
		t.set({ name: 'k', sealed_token: sealed, scope: 'session' }),
	).rejects.toThrow(/scope to "user"/)
	await t.set({
		name: 'hook',
		value: 'https://hooks.example.com/x',
		kind: 'url',
		hosts: ['hooks.example.com'],
	})
	await expect(t.set({ name: 'hook', sealed_token: sealed })).rejects.toThrow(
		/"hook" is a url credential/,
	)
})
