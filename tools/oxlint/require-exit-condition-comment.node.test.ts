import { spawnSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from 'vitest'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const ruleName = 'require-exit-condition-comment'
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

const unmarked = [
	'// Legacy hosts keep serving here.',
	'export const a = 1',
	'/** Kept for backward compatibility with old clients. */',
	'export const b = 2',
]

test('production comments about legacy paths must say how they end', async () => {
	const result = await lint('paths.ts', unmarked)
	expect(result.output.split(diagnostic).length - 1).toBe(2)
	expect(result.status).not.toBe(0)
})

test('Remove when, Permanent, code spans, and test files pass', async () => {
	const marked = await lint('paths.ts', [
		'// Legacy hosts keep serving here.',
		'// Remove when: legacy host traffic stays at zero.',
		'export const a = 1',
		'/** Kept for backward compatibility. Permanent: public wire contract. */',
		'export const b = 2',
		'/** Pass `legacy` for the old ladder. */',
		'export const c = 3',
	])
	expect(marked.output).not.toContain(diagnostic)
	const testFile = await lint('paths.node.test.ts', unmarked)
	expect(testFile.output).not.toContain(diagnostic)
})
