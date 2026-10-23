import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	createPackageCodemodRun,
	getPackageCodemodRunById,
	getPackageCodemodRunItemById,
	insertPackageCodemodRunItem,
	listPackageCodemodRunItems,
	listPackageCodemodRuns,
	markAbandonedPackageCodemodRuns,
	packageCodemodLedgerTextBounds,
	updatePackageCodemodRunStatus,
} from './ledger.ts'

const codemodId = '0001-ambient-storage-to-package-storage'

let migratedSnapshot: Uint8Array | undefined

function createMigratedSqlite() {
	if (!migratedSnapshot) {
		const seed = new DatabaseSync(':memory:')
		applyAllMigrations(seed, new URL('../../migrations/', import.meta.url))
		migratedSnapshot = seed.serialize()
		seed.close()
	}
	const sqlite = new DatabaseSync(':memory:')
	sqlite.deserialize(migratedSnapshot)
	return sqlite
}

function createLedgerDb() {
	const sqlite = createMigratedSqlite()
	return createD1FromSqlite(sqlite)
}

type RunInput = Parameters<typeof createPackageCodemodRun>[1]

function createRun(db: D1Database, input: Partial<RunInput> & { id: string }) {
	return createPackageCodemodRun(db, {
		codemodId,
		mode: 'scan',
		scopeUserId: null,
		initiatedByUserId: 'admin-1',
		createdAt: '2026-07-30T10:00:00.000Z',
		updatedAt: '2026-07-30T10:00:00.000Z',
		...input,
	})
}

test('package codemod ledger pages runs and items with filters', async () => {
	const db = createLedgerDb()
	await createRun(db, { id: 'run-a', scopeUserId: 'user-1' })
	await createRun(db, {
		id: 'run-b',
		mode: 'apply',
		createdAt: '2026-07-30T11:00:00.000Z',
		updatedAt: '2026-07-30T11:00:00.000Z',
	})
	await createRun(db, {
		id: 'run-c',
		codemodId: '0002-other',
		scopeUserId: 'user-2',
		createdAt: '2026-07-30T12:00:00.000Z',
		updatedAt: '2026-07-30T12:00:00.000Z',
	})

	const runIds = async (filters: Record<string, unknown>) =>
		(await listPackageCodemodRuns(db, { limit: 10, ...filters })).map(
			(run) => run.id,
		)
	expect(await runIds({ codemodId })).toEqual(['run-b', 'run-a'])
	expect(await runIds({ scopeUserId: null })).toEqual(['run-b'])
	expect(await runIds({ scopeUserId: 'user-1' })).toEqual(['run-a'])

	await updatePackageCodemodRunStatus(db, { id: 'run-a', status: 'completed' })
	expect(await getPackageCodemodRunById(db, 'run-a')).toMatchObject({
		id: 'run-a',
		status: 'completed',
	})

	await insertPackageCodemodRunItem(db, {
		id: 'item-1',
		runId: 'run-b',
		userId: ownerIdFromStored('user-1'),
		packageId: 'pkg-1',
		kodyId: 'one',
		status: 'applied',
		beforeCommit: 'c1',
		afterCommit: 'c2',
		changedPaths: ['index.ts'],
		findings: [{ path: 'index.ts', message: 'note' }],
		revertSnapshotKey: 'package-codemod-revert:user-1:item-1',
	})
	for (const [index, status] of [
		[2, 'clean'],
		[3, 'applied'],
	] as const) {
		await insertPackageCodemodRunItem(db, {
			id: `item-${index}`,
			runId: 'run-b',
			userId: ownerIdFromStored(`user-${index}`),
			packageId: `pkg-${index}`,
			kodyId: `kody-${index}`,
			status,
		})
	}

	const firstPage = await listPackageCodemodRunItems(db, {
		runId: 'run-b',
		limit: 2,
	})
	expect(firstPage.map((item) => item.id)).toEqual(['item-1', 'item-2'])
	expect(firstPage[0]).toMatchObject({
		changedPaths: ['index.ts'],
		findings: [{ path: 'index.ts', message: 'note' }],
		beforeCommit: 'c1',
		afterCommit: 'c2',
		revertSnapshotKey: 'package-codemod-revert:user-1:item-1',
	})
	const itemIds = async (filters: Record<string, unknown>) =>
		(
			await listPackageCodemodRunItems(db, {
				runId: 'run-b',
				limit: 10,
				...filters,
			})
		).map((item) => item.id)
	expect(await itemIds({ afterId: 'item-2', limit: 2 })).toEqual(['item-3'])
	expect(await itemIds({ status: 'applied' })).toEqual(['item-1', 'item-3'])
	expect(await itemIds({ userId: ownerIdFromStored('user-1') })).toEqual([
		'item-1',
	])
	expect(
		await itemIds({ userId: ownerIdFromStored('user-1'), status: 'applied' }),
	).toEqual(['item-1'])

	// User-scoped reads only see runs scoped to that user and their own items.
	expect(
		await getPackageCodemodRunById(db, 'run-a', {
			userId: ownerIdFromStored('user-1'),
		}),
	).toMatchObject({ id: 'run-a' })
	expect(
		await getPackageCodemodRunById(db, 'run-a', {
			userId: ownerIdFromStored('user-2'),
		}),
	).toBeNull()
	expect(
		await getPackageCodemodRunById(db, 'run-b', {
			userId: ownerIdFromStored('user-1'),
		}),
	).toBeNull()
	expect(
		await getPackageCodemodRunItemById(db, 'item-1', {
			userId: ownerIdFromStored('user-1'),
		}),
	).toMatchObject({ id: 'item-1' })
	expect(
		await getPackageCodemodRunItemById(db, 'item-1', {
			userId: ownerIdFromStored('user-2'),
		}),
	).toBeNull()
})

test('package codemod ledger marks only stale running runs abandoned', async () => {
	const db = createLedgerDb()
	await createRun(db, { id: 'run-stale-running' })
	await createRun(db, {
		id: 'run-fresh-running',
		updatedAt: '2026-07-30T12:30:00.000Z',
	})
	await createRun(db, {
		id: 'run-stale-completed',
		mode: 'apply',
		status: 'completed',
	})

	expect(
		await markAbandonedPackageCodemodRuns(db, {
			updatedBefore: '2026-07-30T12:00:00.000Z',
			updatedAt: '2026-07-30T13:00:00.000Z',
		}),
	).toBe(1)
	expect(await getPackageCodemodRunById(db, 'run-stale-running')).toMatchObject(
		{ status: 'abandoned', updatedAt: '2026-07-30T13:00:00.000Z' },
	)
	expect(await getPackageCodemodRunById(db, 'run-fresh-running')).toMatchObject(
		{ status: 'running', updatedAt: '2026-07-30T12:30:00.000Z' },
	)
	expect(
		await getPackageCodemodRunById(db, 'run-stale-completed'),
	).toMatchObject({
		status: 'completed',
		updatedAt: '2026-07-30T10:00:00.000Z',
	})
	expect(
		await markAbandonedPackageCodemodRuns(db, {
			updatedBefore: '2026-07-30T12:00:00.000Z',
		}),
	).toBe(0)

	// Conditional status write: a run that already left `running` is not
	// overwritten when the caller expected `running`.
	expect(
		await updatePackageCodemodRunStatus(db, {
			id: 'run-stale-completed',
			status: 'abandoned',
			expectedStatus: 'running',
		}),
	).toBe(0)
	expect(
		await getPackageCodemodRunById(db, 'run-stale-completed'),
	).toMatchObject({ status: 'completed' })
	expect(
		await updatePackageCodemodRunStatus(db, {
			id: 'run-fresh-running',
			status: 'abandoned',
			expectedStatus: 'running',
		}),
	).toBe(1)
	expect(await getPackageCodemodRunById(db, 'run-fresh-running')).toMatchObject(
		{ status: 'abandoned' },
	)
})

test('package codemod ledger bounds stored JSON/text columns', async () => {
	const db = createLedgerDb()
	await createRun(db, { id: 'run-bound', scopeUserId: 'user-1' })
	const revertSnapshotKey = 'package-codemod-revert:user-1:item-bound'
	const item = await insertPackageCodemodRunItem(db, {
		id: 'item-bound',
		runId: 'run-bound',
		userId: ownerIdFromStored('user-1'),
		packageId: 'pkg-1',
		kodyId: 'one',
		status: 'detected',
		changedPaths: Array.from(
			{ length: 500 },
			(_, index) => `path-${index}-${'x'.repeat(200)}`,
		),
		findings: Array.from({ length: 200 }, (_, index) => ({
			path: `file-${index}.ts`,
			message: 'm'.repeat(2_000),
		})),
		checkSummaryJson: JSON.stringify({
			ok: false,
			newFailures: ['x'.repeat(100_000)],
		}),
		error: 'e'.repeat(100_000),
		revertSnapshotKey,
	})
	const byteLength = (value: unknown) =>
		new TextEncoder().encode(JSON.stringify(value)).byteLength
	const { maxRestorableTextColumnBytes } = packageCodemodLedgerTextBounds
	expect(byteLength(item.changedPaths)).toBeLessThanOrEqual(
		maxRestorableTextColumnBytes,
	)
	expect(byteLength(item.findings)).toBeLessThanOrEqual(
		maxRestorableTextColumnBytes,
	)
	expect(item.error?.includes('[truncated]')).toBe(true)
	expect(item.revertSnapshotKey).toBe(revertSnapshotKey)
	const listed = await listPackageCodemodRunItems(db, {
		runId: 'run-bound',
		limit: 10,
	})
	expect(listed[0]?.revertSnapshotKey).toBe(revertSnapshotKey)
})
