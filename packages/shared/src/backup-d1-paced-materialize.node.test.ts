import { DatabaseSync } from 'node:sqlite'

import { expect, test } from 'vitest'

import {
	pacedD1TargetPageSql,
	planPacedD1Restore,
	runPacedD1RestoreUnit,
	scanPacedD1TargetPage,
	type PacedD1RestoreUnit,
	type PacedD1TargetScan,
} from './backup-d1-paced-materialize.ts'
import { emitUpsertStatements } from './backup-d1-paced-restore.ts'
import {
	loadVerifiedPacedD1NightChain,
	type PacedD1ObjectReader,
} from './backup-d1-paced-read.ts'
import {
	buildSealedPacedChain,
	pacedTestBaseDay,
	pacedTestSource,
	pacedTestTable,
	pacedTestTipDay,
} from './backup-d1-paced-test-support.ts'
import {
	pacedD1BackupMaxSqlStatementBytes,
	pacedD1RetentionTierForDay,
	pacedD1SealedDataPartKey,
} from './backup-d1-paced.ts'

async function restoreInto(
	db: DatabaseSync,
	units?: Array<PacedD1RestoreUnit>,
) {
	const { reader } = await buildSealedPacedChain()
	const chain = await loadVerifiedPacedD1NightChain({
		reader,
		source: pacedTestSource,
		day: pacedTestTipDay,
	})
	const planned =
		units ??
		(await planPacedD1Restore({
			reader,
			source: pacedTestSource,
			chain,
			partsPerUnit: 1,
		}))
	let rows = 0
	for (const unit of planned) {
		const result = await runPacedD1RestoreUnit({
			reader,
			source: pacedTestSource,
			chain,
			unit,
			maxChunkBytes: 1024,
			importChunk: async (sql) => {
				db.exec(sql)
			},
		})
		rows += result.rows
	}
	return { planned, rows, tip: chain[chain.length - 1]!.manifest }
}

async function scanTarget(db: DatabaseSync, cols: Array<string>) {
	let scan: PacedD1TargetScan = {
		count: 0,
		checksum: '0'.repeat(16),
		lastRowid: null,
		done: false,
	}
	while (!scan.done) {
		const sql = pacedD1TargetPageSql({
			table: pacedTestTable,
			cols,
			afterRowid: scan.lastRowid,
			limit: 2,
		})
		scan = await scanPacedD1TargetPage({
			cols,
			rows: db.prepare(sql).all() as Array<Record<string, unknown>>,
			limit: 2,
			scan,
		})
	}
	return scan
}

test('a sealed base plus deltas restores into SQLite and matches the tip manifest', async () => {
	const db = new DatabaseSync(':memory:')
	const { planned, rows, tip } = await restoreInto(db)
	expect(planned).toEqual([
		{ kind: 'schema' },
		{ kind: 'base', table: pacedTestTable, partStart: 0, partEnd: 1 },
		{ kind: 'base', table: pacedTestTable, partStart: 1, partEnd: 2 },
		{ kind: 'delta', table: pacedTestTable },
		{ kind: 'finish' },
	])
	expect(rows).toBe(4)
	expect(db.prepare('SELECT id, body FROM items ORDER BY id').all()).toEqual([
		{ id: 1, body: 'v1' },
		{ id: 2, body: 'v2' },
		{ id: 4, body: 'v1' },
		{ id: 5, body: 'v2' },
	])
	const manifest = tip.tables[pacedTestTable]!
	const scan = await scanTarget(db, manifest.cols)
	expect(scan.count).toBe(manifest.count)
	expect(scan.checksum).toBe(manifest.checksum)
	db.prepare("UPDATE items SET body = 'changed' WHERE id = 4").run()
	expect((await scanTarget(db, manifest.cols)).checksum).not.toBe(
		manifest.checksum,
	)
})

test('a retried finish unit reinstalls indexes instead of failing', async () => {
	const db = new DatabaseSync(':memory:')
	await restoreInto(db)
	await restoreInto(db, [{ kind: 'finish' }])
	expect(
		db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all(),
	).toEqual([{ name: 'items_body' }])
})

test('oversized JSON and BLOB cells restore whole under CHECK constraints', () => {
	const db = new DatabaseSync(':memory:')
	db.exec(
		'CREATE TABLE docs (id INTEGER PRIMARY KEY, body TEXT CHECK (json_valid(body)), data BLOB)',
	)
	const json = JSON.stringify({ value: 'x'.repeat(120_000) })
	const blob = Uint8Array.from({ length: 80_000 }, (_, index) => index % 251)
	const statements: Array<string> = []
	emitUpsertStatements({
		table: 'docs',
		cols: ['id', 'body', 'data'],
		vals: [1, json, { $b: Buffer.from(blob).toString('base64') }],
		push: (statement) => statements.push(statement),
		stats: { statements: 0, splitRows: 0, maxStmtBytes: 0 },
	})
	for (const statement of statements) {
		expect(Buffer.byteLength(statement)).toBeLessThanOrEqual(
			pacedD1BackupMaxSqlStatementBytes,
		)
	}
	db.exec(statements.join('\n'))
	const row = db
		.prepare('SELECT body, typeof(data) AS kind, data FROM docs WHERE id = 1')
		.get() as { body: string; kind: string; data: Uint8Array }
	expect(row.body).toBe(json)
	expect(row.kind).toBe('blob')
	expect(new Uint8Array(row.data)).toEqual(blob)
})

test('a corrupt base part fails the unit instead of restoring it', async () => {
	const { reader } = await buildSealedPacedChain()
	const chain = await loadVerifiedPacedD1NightChain({
		reader,
		source: pacedTestSource,
		day: pacedTestTipDay,
	})
	const tampered: PacedD1ObjectReader = {
		getText: reader.getText,
		async getBytes(key) {
			const bytes = await reader.getBytes(key)
			return key ===
				pacedD1SealedDataPartKey(
					pacedD1RetentionTierForDay(pacedTestBaseDay),
					pacedTestSource.id,
					pacedTestBaseDay,
					pacedTestTable,
					1,
				) && bytes
				? new TextEncoder().encode('U\tbad\n')
				: bytes
		},
	}
	await expect(
		runPacedD1RestoreUnit({
			reader: tampered,
			source: pacedTestSource,
			chain,
			unit: { kind: 'base', table: pacedTestTable, partStart: 1, partEnd: 2 },
			maxChunkBytes: 1024,
			importChunk: async () => {},
		}),
	).rejects.toThrow()
})
