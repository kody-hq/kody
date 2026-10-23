import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'
import {
	collectStartupBundleOverages,
	readStartupBundleBudget,
} from './check-worker-startup-bundles.ts'

test('bundle budget file rejects non-integer and infinite ceilings', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'startup-bundle-budget-'))
	try {
		const budgetPath = path.join(dir, 'budget.json')
		await writeFile(
			budgetPath,
			JSON.stringify({
				origin: 1,
				platform: Number.POSITIVE_INFINITY,
				runtime: 1,
			}),
		)
		await expect(readStartupBundleBudget(budgetPath)).rejects.toThrow(
			/Invalid startup bundle budget for platform/,
		)
		await writeFile(
			budgetPath,
			JSON.stringify({ origin: 1.5, platform: 1, runtime: 1 }),
		)
		await expect(readStartupBundleBudget(budgetPath)).rejects.toThrow(
			/Invalid startup bundle budget for origin/,
		)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('byte overages are collected for reporting instead of treated as fatal', () => {
	expect(
		collectStartupBundleOverages([
			{ name: 'runtime', size: 3_912_588, maxEntryBytes: 3_912_500 },
		]),
	).toHaveLength(1)
	expect(
		collectStartupBundleOverages([
			{ name: 'runtime', size: 3_912_500, maxEntryBytes: 3_912_500 },
		]),
	).toEqual([])
})
