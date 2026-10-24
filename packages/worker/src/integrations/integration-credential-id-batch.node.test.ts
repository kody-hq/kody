import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { maxD1BoundParameters } from '@kody-internal/shared/chunk.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { getIntegrationCredentialId } from './repo.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

function createIntegrationsDb(options?: {
	maxBindings?: number
	queries?: Array<string>
}) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	sqlite.exec(`
		INSERT INTO platform_oauth_apps (
			slug, provider, label, client_id, token_url, authorize_url,
			api_base_url, flow, enabled
		) VALUES (
			'github', 'github', 'GitHub', 'client-id',
			'https://github.com/login/oauth/access_token',
			'https://github.com/login/oauth/authorize',
			'https://api.github.com', 'confidential', 1
		);
	`)
	return {
		sqlite,
		db: createD1FromSqlite(sqlite, options),
	}
}

function isIntegrationCredentialIdSingleLookup(query: string) {
	const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
	return (
		normalized.includes('from user_integrations') &&
		normalized.includes('user_id = ?') &&
		normalized.includes('name = ?') &&
		!normalized.includes('name in (')
	)
}

function isIntegrationCredentialIdBatchLookup(query: string) {
	const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
	return (
		normalized.includes('from user_integrations') &&
		normalized.includes('user_id = ?') &&
		normalized.includes('name in (')
	)
}

function insertIntegration(
	sqlite: DatabaseSync,
	input: {
		id?: string
		userId: string
		name: string
		deletedAt?: string | null
	},
) {
	sqlite
		.prepare(
			`INSERT INTO user_integrations (
				id, user_id, name, platform_app_slug, deleted_at
			) VALUES (?, ?, ?, 'github', ?)`,
		)
		.run(
			input.id ?? null,
			input.userId,
			input.name,
			input.deletedAt === undefined ? null : input.deletedAt,
		)
}

test('getIntegrationCredentialId batches concurrent names for one owner into one IN read (KODY-AT)', async () => {
	const queries: Array<string> = []
	const { sqlite, db } = createIntegrationsDb({ queries })
	const userId = ownerIdFromStored('org-webhook-batch')
	for (const [id, name] of [
		['cred-a', 'alpha'],
		['cred-b', 'bravo'],
		['cred-c', 'charlie'],
		['cred-d', 'delta'],
	] as const) {
		insertIntegration(sqlite, { id, userId, name })
	}
	queries.length = 0

	const names = ['alpha', 'bravo', 'charlie', 'delta']
	const results = await Promise.all(
		names.map((name) => getIntegrationCredentialId({ db, userId, name })),
	)
	expect(results).toEqual(['cred-a', 'cred-b', 'cred-c', 'cred-d'])
	expect(queries.filter(isIntegrationCredentialIdSingleLookup)).toHaveLength(0)
	expect(queries.filter(isIntegrationCredentialIdBatchLookup)).toHaveLength(1)

	queries.length = 0
	await expect(
		getIntegrationCredentialId({ db, userId, name: 'alpha' }),
	).resolves.toBe('cred-a')
	expect(queries.filter(isIntegrationCredentialIdSingleLookup)).toHaveLength(1)
	expect(queries.filter(isIntegrationCredentialIdBatchLookup)).toHaveLength(0)
})

test('batched getIntegrationCredentialId skips missing and soft-deleted names', async () => {
	const queries: Array<string> = []
	const { sqlite, db } = createIntegrationsDb({ queries })
	const userId = ownerIdFromStored('org-webhook-missing')
	insertIntegration(sqlite, { id: 'cred-live', userId, name: 'live' })
	insertIntegration(sqlite, {
		id: 'cred-gone',
		userId,
		name: 'gone',
		deletedAt: '2026-10-01T00:00:00.000Z',
	})
	queries.length = 0

	const results = await Promise.all([
		getIntegrationCredentialId({ db, userId, name: 'live' }),
		getIntegrationCredentialId({ db, userId, name: 'gone' }),
		getIntegrationCredentialId({ db, userId, name: 'never' }),
		getIntegrationCredentialId({ db, userId, name: 'live' }),
	])
	expect(results).toEqual(['cred-live', null, null, 'cred-live'])
	expect(queries.filter(isIntegrationCredentialIdSingleLookup)).toHaveLength(0)
	expect(queries.filter(isIntegrationCredentialIdBatchLookup)).toHaveLength(1)
})

test('batched getIntegrationCredentialId isolates owners and keeps per-owner IN reads', async () => {
	const queries: Array<string> = []
	const { sqlite, db } = createIntegrationsDb({ queries })
	const orgId = ownerIdFromStored('org-a')
	const personalId = ownerIdFromStored('personal-a')
	insertIntegration(sqlite, { id: 'cred-org', userId: orgId, name: 'shared' })
	insertIntegration(sqlite, {
		id: 'cred-personal',
		userId: personalId,
		name: 'shared',
	})
	insertIntegration(sqlite, {
		id: 'cred-org-other',
		userId: orgId,
		name: 'other',
	})
	queries.length = 0

	const results = await Promise.all([
		getIntegrationCredentialId({ db, userId: orgId, name: 'shared' }),
		getIntegrationCredentialId({ db, userId: personalId, name: 'shared' }),
		getIntegrationCredentialId({ db, userId: orgId, name: 'other' }),
		getIntegrationCredentialId({ db, userId: personalId, name: 'missing' }),
	])
	expect(results).toEqual(['cred-org', 'cred-personal', 'cred-org-other', null])
	expect(queries.filter(isIntegrationCredentialIdSingleLookup)).toHaveLength(0)
	expect(queries.filter(isIntegrationCredentialIdBatchLookup)).toHaveLength(2)
})

test('batched getIntegrationCredentialId chunks names to stay within the D1 binding limit', async () => {
	const queries: Array<string> = []
	const { sqlite, db } = createIntegrationsDb({
		queries,
		maxBindings: maxD1BoundParameters,
	})
	const userId = ownerIdFromStored('org-many-names')
	const names = Array.from(
		{ length: maxD1BoundParameters },
		(_, index) => `name-${String(index).padStart(3, '0')}`,
	)
	insertIntegration(sqlite, {
		id: 'cred-first',
		userId,
		name: names[0] ?? 'name-000',
	})
	insertIntegration(sqlite, {
		id: 'cred-last',
		userId,
		name: names.at(-1) ?? 'name-099',
	})
	queries.length = 0

	const results = await Promise.all(
		names.map((name) => getIntegrationCredentialId({ db, userId, name })),
	)
	expect(results[0]).toBe('cred-first')
	expect(results.at(-1)).toBe('cred-last')
	expect(results.filter((id) => id != null)).toHaveLength(2)
	expect(queries.filter(isIntegrationCredentialIdSingleLookup)).toHaveLength(0)
	expect(
		queries.filter(isIntegrationCredentialIdBatchLookup).length,
	).toBeGreaterThan(1)
})
