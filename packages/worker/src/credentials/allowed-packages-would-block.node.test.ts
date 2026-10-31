import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

vi.mock(
	'#worker/test-support/apply-all-migrations.ts',
	async (importOriginal) =>
		(await import('./cached-migrations.test-support.ts')).withCachedMigrations(
			await importOriginal(),
		),
)

const scheduled = vi.hoisted(() => [] as Array<Promise<unknown>>)

vi.mock('cloudflare:workers', () => ({
	waitUntil: (promise: Promise<unknown>) => {
		scheduled.push(promise)
	},
}))

const {
	buildAllowedPackagesWouldBlockReport,
	recordAllowedPackagesWouldBlock,
	scheduleAllowedPackagesWouldBlock,
} = await import('./allowed-packages-would-block.ts')

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

async function drain() {
	const pending = scheduled.splice(0)
	await Promise.all(pending)
}

const marker = {
	ownerId: 'owner-1',
	credentialId: 'cred-1',
	packageId: 'pkg-1',
	accessKind: 'self_authored' as const,
}

test('would-block table stores ids and counts only, never values', () => {
	const { sqlite } = createDb()
	const columns = sqlite
		.prepare(`PRAGMA table_info(credential_allowed_packages_would_block)`)
		.all()
		.map((row) => String((row as { name: unknown }).name))
	expect(columns).toEqual([
		'day',
		'owner_id',
		'credential_id',
		'package_id',
		'access_kind',
		'first_seen_at',
		'last_seen_at',
		'observations',
	])
})

test('recordAllowedPackagesWouldBlock upserts one row per day, owner, credential, and package', async () => {
	const { sqlite, db } = createDb()
	await recordAllowedPackagesWouldBlock({
		db,
		marker,
		firstSeenAt: '2026-10-23T12:00:00.000Z',
	})
	await recordAllowedPackagesWouldBlock({
		db,
		marker,
		firstSeenAt: '2026-10-23T09:00:00.000Z',
		lastSeenAt: '2026-10-23T15:00:00.000Z',
		observations: 4,
	})
	await recordAllowedPackagesWouldBlock({
		db,
		marker,
		firstSeenAt: '2026-10-24T01:00:00.000Z',
	})
	const rows = sqlite
		.prepare(
			`SELECT day, first_seen_at, last_seen_at, observations
			 FROM credential_allowed_packages_would_block ORDER BY day`,
		)
		.all()
	expect(rows).toEqual([
		{
			day: '2026-10-23',
			first_seen_at: '2026-10-23T09:00:00.000Z',
			last_seen_at: '2026-10-23T15:00:00.000Z',
			observations: 5,
		},
		{
			day: '2026-10-24',
			first_seen_at: '2026-10-24T01:00:00.000Z',
			last_seen_at: '2026-10-24T01:00:00.000Z',
			observations: 1,
		},
	])
})

test('scheduleAllowedPackagesWouldBlock coalesces repeats into one deferred batch', async () => {
	const { sqlite, db } = createDb()
	const prepare = vi.spyOn(db, 'prepare')
	const batch = vi.spyOn(db, 'batch')
	const env = { APP_DB: db }
	scheduleAllowedPackagesWouldBlock({
		env,
		marker,
		now: '2026-10-23T12:00:00.000Z',
		flushDelayMs: 0,
	})
	scheduleAllowedPackagesWouldBlock({
		env,
		marker,
		now: '2026-10-23T12:00:01.000Z',
		flushDelayMs: 0,
	})
	scheduleAllowedPackagesWouldBlock({
		env,
		marker: { ...marker, packageId: 'pkg-2', accessKind: 'adopted' },
		now: '2026-10-23T12:00:02.000Z',
		flushDelayMs: 0,
	})
	// Nothing touched D1 on the caller's path.
	expect(prepare).not.toHaveBeenCalled()
	expect(scheduled).toHaveLength(1)
	await drain()
	expect(prepare).toHaveBeenCalledTimes(2)
	expect(batch).toHaveBeenCalledTimes(1)
	const rows = sqlite
		.prepare(
			`SELECT package_id, access_kind, first_seen_at, last_seen_at, observations
			 FROM credential_allowed_packages_would_block ORDER BY package_id`,
		)
		.all()
	expect(rows).toEqual([
		{
			package_id: 'pkg-1',
			access_kind: 'self_authored',
			first_seen_at: '2026-10-23T12:00:00.000Z',
			last_seen_at: '2026-10-23T12:00:01.000Z',
			observations: 2,
		},
		{
			package_id: 'pkg-2',
			access_kind: 'adopted',
			first_seen_at: '2026-10-23T12:00:02.000Z',
			last_seen_at: '2026-10-23T12:00:02.000Z',
			observations: 1,
		},
	])
})

test('scheduleAllowedPackagesWouldBlock never throws when the write fails', async () => {
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
	const db = {
		prepare() {
			throw new Error('d1 down')
		},
		batch() {
			throw new Error('d1 down')
		},
	} as unknown as D1Database
	expect(() =>
		scheduleAllowedPackagesWouldBlock({
			env: { APP_DB: db },
			marker,
			flushDelayMs: 0,
		}),
	).not.toThrow()
	await drain()
	expect(errorSpy).toHaveBeenCalledWith(
		'credential-allowed-packages-would-block-record-failed',
		expect.objectContaining({ credentialId: 'cred-1', packageId: 'pkg-1' }),
	)
	errorSpy.mockRestore()
})

test('buildAllowedPackagesWouldBlockReport returns distinct totals and per-owner detail', async () => {
	const { db } = createDb()
	const rows = [
		{ ...marker, at: '2026-10-20T10:00:00.000Z', n: 3 },
		{ ...marker, at: '2026-10-21T10:00:00.000Z', n: 2 },
		{
			...marker,
			packageId: 'pkg-2',
			accessKind: 'adopted' as const,
			at: '2026-10-21T11:00:00.000Z',
			n: 1,
		},
		{
			ownerId: 'owner-2',
			credentialId: 'cred-9',
			packageId: 'pkg-9',
			accessKind: 'self_authored' as const,
			at: '2026-10-22T10:00:00.000Z',
			n: 1,
		},
		// Outside the window.
		{
			...marker,
			credentialId: 'cred-old',
			at: '2026-10-10T10:00:00.000Z',
			n: 9,
		},
	]
	for (const row of rows) {
		await recordAllowedPackagesWouldBlock({
			db,
			marker: row,
			firstSeenAt: row.at,
			observations: row.n,
		})
	}
	const report = await buildAllowedPackagesWouldBlockReport({
		db,
		since: '2026-10-16',
	})
	expect(report.totals).toEqual({
		owners: 2,
		credentials: 2,
		packages: 3,
		credentialPackagePairs: 3,
		selfAuthoredPackages: 2,
		adoptedPackages: 1,
		observations: 7,
	})
	expect(report.ownersTruncated).toBe(false)
	expect(report.owners.map((owner) => owner.ownerId)).toEqual([
		'owner-1',
		'owner-2',
	])
	const [first] = report.owners
	expect(first).toMatchObject({
		credentials: 1,
		packages: 2,
		observations: 6,
		firstSeenAt: '2026-10-20T10:00:00.000Z',
		lastSeenAt: '2026-10-21T11:00:00.000Z',
	})
	expect(first?.pairs[0]).toMatchObject({
		credentialId: 'cred-1',
		packageId: 'pkg-1',
		accessKind: 'self_authored',
		days: 2,
		observations: 5,
	})

	const limited = await buildAllowedPackagesWouldBlockReport({
		db,
		since: '2026-10-16',
		until: '2026-10-22',
		ownerLimit: 1,
	})
	expect(limited.totals.owners).toBe(1)
	expect(limited.ownersTruncated).toBe(false)
	const capped = await buildAllowedPackagesWouldBlockReport({
		db,
		since: '2026-10-16',
		ownerLimit: 1,
	})
	expect(capped.ownersTruncated).toBe(true)
	expect(capped.owners).toHaveLength(1)
	expect(capped.totals.owners).toBe(2)
})
