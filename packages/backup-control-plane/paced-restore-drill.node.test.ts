import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import { expect, test, vi } from 'vitest'

import {
	pacedD1RetentionTierForDay,
	pacedD1SealedManifestKey,
} from '@kody-internal/shared/backup-d1-paced.ts'
import {
	buildSealedPacedChain,
	pacedTestSource,
	pacedTestTable,
	pacedTestTipDay,
} from '@kody-internal/shared/backup-d1-paced-test-support.ts'

import {
	MemoryBucket,
	environment,
} from './backup-control-plane-test-support.ts'
import {
	pacedDrillRunId,
	readPacedDrillProgress,
	runPacedRestoreDrill,
} from './paced-restore-drill.ts'

/** Fake drill-account D1 API backed by a real SQLite database. */
function fakeDrillD1() {
	const db = new DatabaseSync(':memory:')
	const deleted: Array<string> = []
	let upload = ''
	const ok = (result: unknown) => Response.json({ success: true, result })
	const fetcher: typeof fetch = async (input, init) => {
		const url = String(input)
		if (url.includes('upload.example')) {
			upload = await new Response(init?.body).text()
			const md5 = createHash('md5').update(upload).digest('hex')
			return new Response(null, { headers: { etag: `"${md5}"` } })
		}
		if (init?.method === 'DELETE') {
			deleted.push(url)
			return ok({})
		}
		if (url.endsWith('/d1/database')) {
			return ok({
				uuid: '33333333-3333-4333-8333-333333333333',
				name: 'drill',
				created_at: '2026-11-18T00:00:00.000Z',
			})
		}
		const body = JSON.parse(String(init?.body ?? '{}')) as {
			sql?: string
			action?: string
		}
		if (url.endsWith('/query')) {
			return ok([{ results: db.prepare(body.sql ?? '').all() }])
		}
		switch (body.action) {
			case 'init':
				return ok({
					upload_url: 'https://upload.example/sql',
					filename: 'import.sql',
				})
			case 'ingest':
				db.exec(upload)
				return ok({ at_bookmark: 'bookmark', type: 'import' })
			case 'poll':
				return ok({ status: 'complete' })
			default:
				throw new Error(`unexpected D1 API call ${url}`)
		}
	}
	return { fetcher, db, deleted }
}

async function drillEnv(tamper?: (objects: Map<string, string>) => void) {
	const { objects } = await buildSealedPacedChain()
	tamper?.(objects)
	const bucket = new MemoryBucket()
	for (const [key, text] of objects) await bucket.put(key, text)
	const env = environment(bucket)
	env.D1_PACED_SOURCES = JSON.stringify([pacedTestSource])
	env.SOURCE_DATABASE_ID = pacedTestSource.id
	env.ALLOWED_SOURCE_DATABASE_IDS = pacedTestSource.id
	return env
}

const step = { do: async <T>(_name: string, run: () => Promise<T>) => run() }

async function runDrill(env: Awaited<ReturnType<typeof drillEnv>>) {
	const d1 = fakeDrillD1()
	const runId = pacedDrillRunId(
		pacedTestTipDay,
		new Date('2026-11-18T15:00:00Z'),
	)
	const progress = await runPacedRestoreDrill({
		env,
		payload: { runId, day: pacedTestTipDay },
		step,
		options: {
			fetcher: d1.fetcher,
			sleep: async () => undefined,
			pollDelayMs: 1,
		},
	})
	return { progress, d1, runId }
}

test('the paced drill restores the sealed chain into an isolated database and passes', async () => {
	const env = await drillEnv()
	const { progress, d1, runId } = await runDrill(env)
	expect(progress.status).toBe('passed')
	const [source] = progress.sources
	expect(source?.phase).toBe('passed')
	expect(source?.tables).toEqual([
		expect.objectContaining({
			table: pacedTestTable,
			manifestCount: 4,
			importedRows: 4,
			targetCount: 4,
			ok: true,
		}),
	])
	expect(source?.tables[0]?.targetChecksum).toBe(
		source?.tables[0]?.manifestChecksum,
	)
	expect(d1.db.prepare('SELECT id FROM items ORDER BY id').all()).toEqual([
		{ id: 1 },
		{ id: 2 },
		{ id: 4 },
		{ id: 5 },
	])
	expect(d1.deleted).toHaveLength(1)
	expect((await readPacedDrillProgress(env, runId))?.status).toBe('passed')
})

test('a checksum mismatch fails the table clearly and keeps the target', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const env = await drillEnv((objects) => {
		const key = pacedD1SealedManifestKey(
			pacedD1RetentionTierForDay(pacedTestTipDay),
			pacedTestSource.id,
			pacedTestTipDay,
		)
		const manifest = JSON.parse(objects.get(key)!)
		manifest.tables[pacedTestTable].checksum = '0'.repeat(16)
		objects.set(key, JSON.stringify(manifest))
	})
	const { progress, d1 } = await runDrill(env)
	expect(progress.status).toBe('failed')
	const [source] = progress.sources
	expect(source?.phase).toBe('failed')
	expect(source?.keptForInspection).toBe(true)
	expect(source?.tables[0]?.ok).toBe(false)
	expect(source?.error).toBe(`count or checksum mismatch: ${pacedTestTable}`)
	expect(d1.deleted).toHaveLength(0)
	expect(consoleError).toHaveBeenCalled()
	consoleError.mockRestore()
})

test('a missing paced seal fails the source without creating a database', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const env = environment(new MemoryBucket())
	env.D1_PACED_SOURCES = JSON.stringify([pacedTestSource])
	env.SOURCE_DATABASE_ID = pacedTestSource.id
	env.ALLOWED_SOURCE_DATABASE_IDS = pacedTestSource.id
	const { progress } = await runDrill(env)
	expect(progress.status).toBe('failed')
	expect(progress.sources[0]?.error).toContain('no sealed paced manifest')
	expect(progress.sources[0]?.targetDatabaseId).toBeNull()
	expect(consoleError).toHaveBeenCalled()
	consoleError.mockRestore()
})
