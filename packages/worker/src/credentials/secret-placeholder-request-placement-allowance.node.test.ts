import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { secretSetCapability } from '#mcp/capabilities/secrets/secret-set.ts'
import { partitionSecretPlaceholderRequestPlacementHits } from './secret-placeholder-request-placement-allowance.ts'
import {
	findSecretPlaceholderRequestPlacements,
	formatSecretPlaceholderRequestPlacementNotice,
} from './secret-placeholder-request-placement.ts'

const now = '2026-11-17T00:00:00.000Z'
const baseUrl = 'https://heykody.dev'

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
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
		AUDIT_DB: createAuditTestDb(),
		...createInMemoryUserMeterEnv().env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	const owner = {
		env,
		openApiPrincipal: { kind: 'mcp' } as const,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl,
			user: {
				userId: personIdFromStored(ownerId),
				email: 'owneruser@example.com',
				displayName: 'owneruser',
				username: 'owneruser',
			},
			orgBinding: {
				org: { id: ownerIdFromStored(ownerId), slug: 'owneruser' },
				role: 'owner',
			},
		}),
	}
	/** Saves a Key with `placement_json` and, when given, an opt-in row. */
	const key = async (
		name: string,
		placement: string | null,
		optIn?: { body?: boolean; query?: boolean; source: 'owner' | 'observed' },
	) => {
		await secretSetCapability.handler(
			{ scope: 'user', name, value: `${name}_value` } as never,
			owner as never,
		)
		const row = await db
			.prepare(
				`SELECT e.id FROM secret_entries e JOIN secret_buckets b ON b.id = e.bucket_id
				 WHERE b.user_id = ? AND b.scope = 'user' AND e.name = ? AND e.deleted_at IS NULL`,
			)
			.bind(ownerId, name)
			.first<{ id: string }>()
		const id = row!.id
		await db
			.prepare(`UPDATE secret_entries SET placement_json = ? WHERE id = ?`)
			.bind(placement, id)
			.run()
		if (optIn) {
			await db
				.prepare(
					`INSERT INTO credential_fill_placement_opt_ins (credential_id, query, path, body, source, updated_at)
					 VALUES (?, ?, 0, ?, ?, ?)`,
				)
				.bind(id, optIn.query ? 1 : 0, optIn.body ? 1 : 0, optIn.source, now)
				.run()
		}
		return id
	}
	const partition = async (source: string) =>
		await partitionSecretPlaceholderRequestPlacementHits({
			db,
			ownerId,
			baseUrl,
			hits: await findSecretPlaceholderRequestPlacements({
				'src/index.ts': source,
			}),
		})
	return { key, partition }
}

const bodyFetch = (name: string) =>
	`export const go = () => fetch('https://api.example.com', { method: 'POST', body: JSON.stringify({ v: '{{secret:${name}}}' }) })`

test('a body placeholder the Key does not allow blocks and links its approval page', async () => {
	const t = await setup()
	const id = await t.key('apiKey', JSON.stringify({ headers: true }))
	const { blocked, allowed } = await t.partition(bodyFetch('apiKey'))
	expect(allowed).toEqual([])
	expect(blocked).toHaveLength(1)
	const link = new URL(blocked[0]!.approvalUrl!)
	expect(link.pathname).toBe('/connect/secrets')
	expect(link.searchParams.get('name')).toBe('apiKey')
	expect(link.searchParams.get('placement')).toBe('body')
	expect(link.searchParams.get('org')).toBe('owneruser')
	expect(link.searchParams.get('credential')).toBe(id)
	const message = formatSecretPlaceholderRequestPlacementNotice({
		hits: blocked,
		allowed,
		mode: 'fail',
	})
	expect(message).toContain('Publish failed:')
	expect(message).toContain(`  Owner approval: ${blocked[0]!.approvalUrl}`)
	expect(message).toContain('This blocks publish.')
})

test('a body placeholder the owner allowed passes with a warning', async () => {
	const t = await setup()
	await t.key('apiKey', JSON.stringify({ headers: true, body: true }), {
		body: true,
		source: 'owner',
	})
	const { blocked, allowed } = await t.partition(bodyFetch('apiKey'))
	expect(blocked).toEqual([])
	expect(allowed).toEqual([
		expect.objectContaining({ name: 'apiKey', part: 'body' }),
	])
	expect(allowed[0]!.approvalUrl).toBeUndefined()
	const message = formatSecretPlaceholderRequestPlacementNotice({
		hits: blocked,
		allowed,
		mode: 'fail',
	})
	expect(message).toContain('WARNING:')
	expect(message).toContain('This does not block publish.')
	expect(message).not.toContain('Publish failed:')
})

test('a legacy Key with no stored placement and an observed body opt-in passes', async () => {
	const t = await setup()
	await t.key('throttlePassword', null, { body: true, source: 'observed' })
	const { blocked, allowed } = await t.partition(bodyFetch('throttlePassword'))
	expect(blocked).toEqual([])
	expect(allowed).toEqual([
		expect.objectContaining({ name: 'throttlePassword', part: 'body' }),
	])
})

test('a legacy Key blocks the parts it was never observed in', async () => {
	const t = await setup()
	await t.key('throttlePassword', null, { body: true, source: 'observed' })
	const { blocked, allowed } = await t.partition(
		[
			"export const q = () => fetch('https://api.example.com/items?key={{secret:throttlePassword}}')",
			"export const p = () => fetch('https://api.example.com/bot{{secret:throttlePassword}}/send')",
		].join('\n'),
	)
	expect(allowed).toEqual([])
	expect(blocked.map((hit) => hit.part)).toEqual(['query', 'path'])
	expect(
		blocked.map((hit) =>
			new URL(hit.approvalUrl!).searchParams.get('placement'),
		),
	).toEqual(['query', 'path'])
})

test('a query placeholder the owner allowed passes', async () => {
	const t = await setup()
	await t.key('queryKey', JSON.stringify({ headers: true, query: true }), {
		query: true,
		source: 'owner',
	})
	const { blocked, allowed } = await t.partition(
		"export const q = () => fetch('https://api.example.com/items?key={{secret:queryKey}}')",
	)
	expect(blocked).toEqual([])
	expect(allowed.map((hit) => hit.part)).toEqual(['query'])
})

test('a placement the code set without the owner opting in still blocks', async () => {
	const t = await setup()
	await t.key('apiKey', JSON.stringify({ headers: true, body: true }))
	const { blocked } = await t.partition(bodyFetch('apiKey'))
	expect(blocked).toHaveLength(1)
})

test('a Key this org has not saved blocks and links the approval page by name', async () => {
	const t = await setup()
	const { blocked } = await t.partition(bodyFetch('missingKey'))
	expect(blocked).toHaveLength(1)
	const link = new URL(blocked[0]!.approvalUrl!)
	expect(link.searchParams.get('name')).toBe('missingKey')
	expect(link.searchParams.has('credential')).toBe(false)
})
