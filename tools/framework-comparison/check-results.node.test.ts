import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, test } from 'vitest'

test('page CSS budgets count inlined asset CSS and reject missing style evidence', () => {
	const directory = mkdtempSync(join(tmpdir(), 'kody-page-budget-'))
	try {
		const inventory = join(directory, 'inventory.json')
		const runs = join(directory, 'runs.json')
		writeFileSync(
			inventory,
			JSON.stringify({ inventories: [{ label: 'fixed', assets: [] }] }),
		)
		const check = (inlineStylesheetBytes: number) => {
			writeFileSync(
				runs,
				JSON.stringify({
					runs: Array.from({ length: 5 }, () => ({
						label: 'fixed',
						errors: [],
						steps: [],
						initial: {
							inlineStylesheetBytes,
							resources: [{ path: '/assets/client.js', encodedBytes: 100 }],
						},
					})),
				}),
			)
			return spawnSync(
				process.execPath,
				[
					join(import.meta.dirname, 'check-results.mjs'),
					runs,
					inventory,
					'fixed',
				],
				{ encoding: 'utf8' },
			)
		}
		expect(check(100).status).toBe(0)
		const oversized = check(135_001)
		expect(oversized.status).toBe(1)
		expect(oversized.stdout).toContain('Initial CSS 135001 > 135000')
		const missing = check(0)
		expect(missing.status).toBe(1)
		expect(missing.stderr).toContain('stylesheet evidence is missing')
	} finally {
		rmSync(directory, { recursive: true })
	}
})
