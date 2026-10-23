import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	buildBudgetHitEmailContent,
	orgBudgetHitClaimTtlSeconds,
	orgBudgetHitKvKey,
	sendBudgetHitEmail,
} from './org-budget-hit-emails.ts'

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: vi.fn(async () => ({ ok: true as const })),
}))

const { sendCloudflareEmail } = await import('#app/email/cloudflare-email.ts')

const now = new Date('2026-03-15T12:00:00.000Z')
const month = '2026-03'

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	await db
		.prepare(
			`CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				stable_user_id TEXT NOT NULL UNIQUE,
			personal_org_id TEXT,
				email TEXT NOT NULL,
				username TEXT NOT NULL,
				deleting_at TEXT,
				deleted_at TEXT
			)`,
		)
		.run()
	return db
}

function createKv() {
	const store = new Map<string, string>()
	const kv = {
		get: async (key: string) => store.get(key) ?? null,
		put: async (
			key: string,
			value: string,
			options?: { expirationTtl?: number },
		) => {
			store.set(key, value)
			void options
		},
		delete: async (key: string) => {
			store.delete(key)
		},
	} as unknown as KVNamespace
	return { kv, store }
}

function baseEnv(kv: KVNamespace) {
	return {
		BUNDLE_ARTIFACTS_KV: kv,
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.com/client/v4',
		CLOUDFLARE_API_TOKEN: 'token',
		APP_BASE_URL: 'https://kody.test',
		SYSTEM_EMAIL_DOMAIN: 'kody.codes',
	}
}

test('buildBudgetHitEmailContent HTML-escapes slug and usernames', () => {
	const malicious = '<img src=x onerror=alert(1)>'
	const { html } = buildBudgetHitEmailContent({
		details: {
			code: 'org_budget_limit_exceeded',
			kind: 'user',
			orgSlug: malicious,
			actorUsername: malicious,
			spentMicroUsd: 1,
			budgetMicroUsd: 1,
		},
		appBaseUrl: 'https://kody.test',
	})
	expect(html).not.toContain('<img')
	expect(html).toContain('&lt;img')
})

test('sendBudgetHitEmail claims once per org actor per UTC month', async () => {
	const db = await createDb()
	const orgId = ownerIdFromStored('org-budget-hit')
	const owner = testStableUserIdFromEmail('owner-budget@example.com')
	const seededAt = '2026-01-02T00:00:00.000Z'
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
			 VALUES (?, ?, 'pro', ?, ?)`,
		)
		.bind(orgId, 'acme', seededAt, seededAt)
		.run()
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', ?)`,
		)
		.bind(orgId, owner, seededAt)
		.run()
	await db
		.prepare(
			`INSERT INTO users (stable_user_id, email, username, deleting_at)
			 VALUES (?, ?, ?, NULL)`,
		)
		.bind(owner, 'owner-budget@example.com', 'owner')
		.run()

	const { kv, store } = createKv()
	const env = baseEnv(kv)
	const details = {
		code: 'org_budget_limit_exceeded' as const,
		kind: 'user' as const,
		orgSlug: 'acme',
		actorUsername: 'sam',
		spentMicroUsd: 50_000_000,
		budgetMicroUsd: 50_000_000,
	}
	const key = orgBudgetHitKvKey({
		orgId,
		kind: 'user',
		actorKey: owner,
		month,
	})

	vi.mocked(sendCloudflareEmail).mockClear()
	expect(
		await sendBudgetHitEmail({
			env,
			db,
			orgId,
			details,
			actorUserId: owner,
			now,
		}),
	).toBe(1)
	expect(sendCloudflareEmail).toHaveBeenCalledOnce()
	expect(store.get(key)).toBe(now.toISOString())

	vi.mocked(sendCloudflareEmail).mockClear()
	expect(
		await sendBudgetHitEmail({
			env,
			db,
			orgId,
			details,
			actorUserId: owner,
			now,
		}),
	).toBe(0)
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
})

test('sendBudgetHitEmail fail-open still sends when claim put fails', async () => {
	const db = await createDb()
	const orgId = ownerIdFromStored('org-fail-open')
	const owner = testStableUserIdFromEmail('fail-open@example.com')
	const seededAt = '2026-01-02T00:00:00.000Z'
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
			 VALUES (?, ?, 'pro', ?, ?)`,
		)
		.bind(orgId, 'acme', seededAt, seededAt)
		.run()
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', ?)`,
		)
		.bind(orgId, owner, seededAt)
		.run()
	await db
		.prepare(
			`INSERT INTO users (stable_user_id, email, username, deleting_at)
			 VALUES (?, ?, ?, NULL)`,
		)
		.bind(owner, 'fail-open@example.com', 'owner')
		.run()

	const { kv } = createKv()
	const originalPut = kv.put.bind(kv)
	const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	kv.put = async (
		key: string,
		value: string,
		options?: { expirationTtl?: number },
	) => {
		if (key.includes('org-budget-hit')) {
			throw new Error('kv put failed')
		}
		return originalPut(key, value, options)
	}

	vi.mocked(sendCloudflareEmail).mockClear()
	expect(
		await sendBudgetHitEmail({
			env: baseEnv(kv),
			db,
			orgId,
			details: {
				code: 'org_budget_limit_exceeded',
				kind: 'automation',
				orgSlug: 'acme',
				spentMicroUsd: 1,
				budgetMicroUsd: 1,
			},
			actorUserId: null,
			now,
		}),
	).toBe(1)
	expect(sendCloudflareEmail).toHaveBeenCalledOnce()
	expect(consoleWarn).toHaveBeenCalledWith(
		'org-budget-hit-claim-failed',
		expect.objectContaining({ phase: 'put' }),
	)
	consoleWarn.mockRestore()
	void orgBudgetHitClaimTtlSeconds
})
