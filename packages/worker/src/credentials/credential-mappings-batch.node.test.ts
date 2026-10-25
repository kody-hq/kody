/**
 * Concurrent per-need-key mapping loads coalesce into one D1 read (KODY-AZ).
 * Sequential loads with a RequestContext share one unfiltered scope read
 * (KODY-BF).
 */
import { maxD1BoundParameters } from '@kody-internal/shared/chunk.ts'
import { DatabaseSync } from 'node:sqlite'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	buildWriteCredentialMappingStatement,
	loadCredentialMappings,
	type CredentialMappingRowTarget,
} from './credential-mappings.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const now = '2026-10-23T20:00:00.000Z'
const orgId = 'org-mapping-batch'
const packageId = 'pkg-mapping-batch'
const personId = 'person-mapping-batch'

function isCredentialMappingLookup(query: string) {
	const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
	return (
		normalized.includes('from credential_mappings') &&
		normalized.includes('org_id = ?') &&
		normalized.includes('package_id = ?') &&
		normalized.startsWith('select ')
	)
}

function isSingleNeedKeyLookup(query: string) {
	const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
	return (
		isCredentialMappingLookup(normalized) &&
		normalized.includes('need_key = ?') &&
		!normalized.includes('need_key in (')
	)
}

function isMultiNeedKeyLookup(query: string) {
	const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
	return (
		isCredentialMappingLookup(normalized) &&
		normalized.includes('need_key in (')
	)
}

async function writeMapping(input: {
	db: D1Database
	needKey: string
	target: CredentialMappingRowTarget
	credentialIds: ReadonlyArray<string>
}) {
	await buildWriteCredentialMappingStatement({
		db: input.db,
		orgId,
		packageId,
		needKey: input.needKey,
		target: input.target,
		credentialIds: input.credentialIds,
		updatedByUserId: personId,
		now,
	}).run()
}

test('loadCredentialMappings batches concurrent need keys into one IN read (KODY-AZ)', async () => {
	const queries: Array<string> = []
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite, { queries })
	const orgTarget = { target: 'org' as const }
	const mineTarget = { target: 'mine' as const, personId }
	await writeMapping({
		db,
		needKey: 'mail',
		target: orgTarget,
		credentialIds: ['cred-mail'],
	})
	await writeMapping({
		db,
		needKey: 'chat',
		target: mineTarget,
		credentialIds: ['cred-chat'],
	})
	await writeMapping({
		db,
		needKey: 'docs',
		target: orgTarget,
		credentialIds: ['cred-docs'],
	})
	queries.length = 0

	const keys = ['mail', 'chat', 'docs'] as const
	const results = await Promise.all(
		keys.map((needKey) =>
			loadCredentialMappings({
				db,
				orgId,
				packageId,
				personId,
				needKey,
			}),
		),
	)

	expect(results.map((rows) => rows.map((row) => row.needKey))).toEqual([
		['mail'],
		['chat'],
		['docs'],
	])
	expect(results[0]![0]).toMatchObject({
		needKey: 'mail',
		target: { target: 'org' },
		credentialIds: ['cred-mail'],
	})
	expect(results[1]![0]).toMatchObject({
		needKey: 'chat',
		target: { target: 'mine', personId },
		credentialIds: ['cred-chat'],
	})
	expect(queries.filter(isCredentialMappingLookup)).toHaveLength(1)
	expect(queries.filter(isSingleNeedKeyLookup)).toHaveLength(0)
	expect(queries.filter(isMultiNeedKeyLookup)).toHaveLength(1)

	queries.length = 0
	await expect(
		loadCredentialMappings({
			db,
			orgId,
			packageId,
			personId,
			needKey: 'mail',
		}),
	).resolves.toEqual([
		expect.objectContaining({
			needKey: 'mail',
			credentialIds: ['cred-mail'],
		}),
	])
	expect(queries.filter(isSingleNeedKeyLookup)).toHaveLength(1)
	expect(queries.filter(isMultiNeedKeyLookup)).toHaveLength(0)
})

test('batched loadCredentialMappings keeps org-before-mine precedence per need key', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite)
	await writeMapping({
		db,
		needKey: 'mail',
		target: { target: 'org' },
		credentialIds: ['org-mail'],
	})
	await writeMapping({
		db,
		needKey: 'mail',
		target: { target: 'mine', personId },
		credentialIds: ['mine-mail'],
	})
	await writeMapping({
		db,
		needKey: 'chat',
		target: { target: 'org' },
		credentialIds: ['org-chat'],
	})

	const [mail, chat] = await Promise.all([
		loadCredentialMappings({
			db,
			orgId,
			packageId,
			personId,
			needKey: 'mail',
		}),
		loadCredentialMappings({
			db,
			orgId,
			packageId,
			personId,
			needKey: 'chat',
		}),
	])

	expect(mail.map((row) => [row.target.target, row.credentialIds])).toEqual([
		['mine', ['mine-mail']],
		['org', ['org-mail']],
	])
	expect(chat.map((row) => [row.target.target, row.credentialIds])).toEqual([
		['org', ['org-chat']],
	])
})

test('batched loadCredentialMappings falls back to an unfiltered read when need keys would exceed D1 binds', async () => {
	const queries: Array<string> = []
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite, {
		queries,
		maxBindings: maxD1BoundParameters,
	})
	// orgId + packageId + personId leave 97 slots; more need keys than that
	// must not use need_key IN (…).
	const keys = Array.from(
		{ length: maxD1BoundParameters },
		(_, index) => `need-${index}`,
	)
	for (const needKey of keys.slice(0, 3)) {
		await writeMapping({
			db,
			needKey,
			target: { target: 'org' },
			credentialIds: [`cred-${needKey}`],
		})
	}
	queries.length = 0

	const results = await Promise.all(
		keys.map((needKey) =>
			loadCredentialMappings({
				db,
				orgId,
				packageId,
				personId,
				needKey,
			}),
		),
	)
	expect(results[0]![0]?.credentialIds).toEqual(['cred-need-0'])
	expect(results[1]![0]?.credentialIds).toEqual(['cred-need-1'])
	expect(results[2]![0]?.credentialIds).toEqual(['cred-need-2'])
	expect(results[3]).toEqual([])
	expect(queries.filter(isCredentialMappingLookup)).toHaveLength(1)
	expect(queries.filter(isMultiNeedKeyLookup)).toHaveLength(0)
	expect(queries.filter(isSingleNeedKeyLookup)).toHaveLength(0)
	const [lookup] = queries.filter(isCredentialMappingLookup)
	expect(lookup?.toLowerCase()).not.toMatch(/need_key\s*(=|in\s*\()/)
})

test('batched loadCredentialMappings isolates scopes so different packages do not share a read', async () => {
	const queries: Array<string> = []
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite, { queries })
	const otherPackageId = 'pkg-other'
	await writeMapping({
		db,
		needKey: 'mail',
		target: { target: 'org' },
		credentialIds: ['cred-a'],
	})
	await buildWriteCredentialMappingStatement({
		db,
		orgId,
		packageId: otherPackageId,
		needKey: 'mail',
		target: { target: 'org' },
		credentialIds: ['cred-b'],
		updatedByUserId: personId,
		now,
	}).run()
	queries.length = 0

	const [left, right] = await Promise.all([
		loadCredentialMappings({
			db,
			orgId,
			packageId,
			personId,
			needKey: 'mail',
		}),
		loadCredentialMappings({
			db,
			orgId,
			packageId: otherPackageId,
			personId,
			needKey: 'mail',
		}),
	])

	expect(left[0]?.credentialIds).toEqual(['cred-a'])
	expect(right[0]?.credentialIds).toEqual(['cred-b'])
	expect(queries.filter(isCredentialMappingLookup)).toHaveLength(2)
})

test('sequential loadCredentialMappings with request shares one unfiltered scope read (KODY-BF)', async () => {
	const queries: Array<string> = []
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite, { queries })
	const request = {} as RequestContext
	await writeMapping({
		db,
		needKey: 'mail',
		target: { target: 'org' },
		credentialIds: ['cred-mail'],
	})
	await writeMapping({
		db,
		needKey: 'chat',
		target: { target: 'mine', personId },
		credentialIds: ['cred-chat'],
	})
	await writeMapping({
		db,
		needKey: 'docs',
		target: { target: 'org' },
		credentialIds: ['cred-docs'],
	})
	queries.length = 0

	const results: Array<Awaited<ReturnType<typeof loadCredentialMappings>>> = []
	for (const needKey of ['mail', 'chat', 'docs'] as const) {
		results.push(
			await loadCredentialMappings({
				db,
				orgId,
				packageId,
				personId,
				needKey,
				request,
			}),
		)
	}

	expect(results.map((rows) => rows.map((row) => row.needKey))).toEqual([
		['mail'],
		['chat'],
		['docs'],
	])
	expect(queries.filter(isCredentialMappingLookup)).toHaveLength(1)
	expect(queries.filter(isSingleNeedKeyLookup)).toHaveLength(0)
	expect(queries.filter(isMultiNeedKeyLookup)).toHaveLength(0)
	const [lookup] = queries.filter(isCredentialMappingLookup)
	expect(lookup?.toLowerCase()).not.toMatch(/need_key\s*(=|in\s*\()/)

	// A different request must not reuse the prior request's snapshot.
	queries.length = 0
	const otherRequest = {} as RequestContext
	await expect(
		loadCredentialMappings({
			db,
			orgId,
			packageId,
			personId,
			needKey: 'mail',
			request: otherRequest,
		}),
	).resolves.toEqual([
		expect.objectContaining({
			needKey: 'mail',
			credentialIds: ['cred-mail'],
		}),
	])
	expect(queries.filter(isCredentialMappingLookup)).toHaveLength(1)
})
