import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'
import { sharedTestExclude } from '../vitest-shared.ts'

const rootVitestConfigs = [
	'vitest.node.config.ts',
	'vitest.workers.config.ts',
	'vitest.mcp-e2e.config.ts',
] as const

test('shared vitest exclude skips .tmp scratch trees', () => {
	expect(sharedTestExclude).toContain('**/.tmp/**')
})

test('root vitest projects use the shared scratch-tree exclude', async () => {
	for (const file of rootVitestConfigs) {
		const source = await readFile(
			new URL(`../${file}`, import.meta.url),
			'utf8',
		)
		expect(source.includes('sharedTestExclude')).toBe(true)
	}
})
