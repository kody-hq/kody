import { spawnSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from 'vitest'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const ruleName = 'no-isolate-promise-memo'
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
		return `${result.stdout}\n${result.stderr}`
	} finally {
		await rm(fixtureDir, { recursive: true, force: true })
	}
}

test('module-scope promise memos are rejected; request-scoped ones pass', async () => {
	const output = await lint('memo.ts', [
		'let moduleMemo: Promise<unknown> | null = null',
		'export const keyed = new Map<string, Promise<number>>()',
		'const wrapped = keep(new Map<string, { pending: Promise<void> }>())',
		'const annotated: Map<string, Promise<number>> = new Map()',
		'const byRequest = new WeakMap<Request, Promise<number>>()',
		'const values = new Map<string, number>()',
		'export function perCall() {',
		'	let local: Promise<unknown> | null = null',
		'	return [local, moduleMemo, keyed, wrapped, annotated, byRequest, values]',
		'}',
		'function keep<T>(value: T) {',
		'	return value',
		'}',
	])
	expect(output.split(diagnostic).length - 1).toBe(4)
})
