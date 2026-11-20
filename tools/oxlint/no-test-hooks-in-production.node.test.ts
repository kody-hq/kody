import { spawnSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from 'vitest'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const ruleName = 'no-test-hooks-in-production'
const diagnostic = `kody-custom(${ruleName})`
const fixtureDir = path.join(
	repoRoot,
	'packages/worker/src',
	`.${ruleName}-${String(process.pid)}`,
)

async function lint(fileName: string, lines: Array<string>) {
	await mkdir(fixtureDir, { recursive: true })
	const fixturePath = path.join(fixtureDir, fileName)
	await writeFile(fixturePath, [...lines, ''].join('\n'))
	try {
		const result = spawnSync(
			path.join(repoRoot, 'node_modules', 'oxlint', 'bin', 'oxlint'),
			[fixturePath],
			{ cwd: repoRoot, encoding: 'utf8' },
		)
		return {
			output: `${result.stdout}\n${result.stderr}`,
			status: result.status,
		}
	} finally {
		await rm(fixtureDir, { recursive: true, force: true })
	}
}

const hookLines = [
	'export function resetCacheForTests() {}',
	'export const clearForTesting = () => {}',
	"export const isTest = process.env.NODE_ENV === 'test'",
	'export const isVitest = Boolean(process.env.VITEST)',
]

test('production files reject test hooks and test-runner checks', async () => {
	const result = await lint('cache.ts', hookLines)
	expect(result.output.split(diagnostic).length - 1).toBe(4)
	expect(result.status).not.toBe(0)
})

test('and test-support files may use them', async () => {
	for (const fileName of ['cache.node.test.ts', 'cache-test-support.ts']) {
		const result = await lint(fileName, hookLines)
		expect(result.output).not.toContain(diagnostic)
	}
})

test('ordinary names and env reads pass', async () => {
	const result = await lint('cache.ts', [
		'export function resetCache() {}',
		'export const contestForTeams = 1',
		"export const isProduction = process.env.NODE_ENV === 'production'",
	])
	expect(result.output).not.toContain(diagnostic)
})
