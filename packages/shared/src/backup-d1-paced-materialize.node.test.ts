import { expect, test } from 'vitest'

import {
	addPacedD1Checksums,
	planPacedD1Restore,
	runPacedD1RestoreUnit,
} from './backup-d1-paced-materialize.ts'
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
	pacedD1RetentionTierForDay,
	pacedD1SealedDataPartKey,
} from './backup-d1-paced.ts'

test('a sealed base plus deltas restores unit by unit to the tip manifest', async () => {
	const { reader, expectedChecksum } = await buildSealedPacedChain()
	const chain = await loadVerifiedPacedD1NightChain({
		reader,
		source: pacedTestSource,
		day: pacedTestTipDay,
	})
	const units = await planPacedD1Restore({
		reader,
		source: pacedTestSource,
		chain,
		partsPerUnit: 1,
	})
	expect(units).toEqual([
		{ kind: 'schema' },
		{ kind: 'base', table: pacedTestTable, partStart: 0, partEnd: 1 },
		{ kind: 'base', table: pacedTestTable, partStart: 1, partEnd: 2 },
		{ kind: 'delta', table: pacedTestTable },
		{ kind: 'finish' },
	])
	const sql: Array<string> = []
	let rows = 0
	let checksum = '0'.repeat(16)
	for (const unit of units) {
		const result = await runPacedD1RestoreUnit({
			reader,
			source: pacedTestSource,
			chain,
			unit,
			maxChunkBytes: 1024,
			importChunk: async (chunk) => {
				sql.push(chunk)
			},
		})
		rows += result.rows
		checksum = addPacedD1Checksums(checksum, result.checksumSum)
	}
	expect(rows).toBe(4)
	expect(checksum).toBe(expectedChecksum)
	const script = sql.join('')
	expect(script).toContain('DROP TABLE IF EXISTS "items";')
	expect(script).toContain("'v2'")
	expect(script).not.toMatch(/VALUES \(3,/)
	expect(
		script.trim().endsWith('CREATE INDEX items_body ON items(body);'),
	).toBe(true)
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
