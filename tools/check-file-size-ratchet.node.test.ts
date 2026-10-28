import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	checkFileSizeRatchet,
	countLines,
	formatOptionsFromOxfmtConfig,
	formatSourceWithRepoOxfmt,
	parseFileSizeRatchetSnapshot,
	type FileSizeRatchetSnapshot,
	type FormatSourceForRatchet,
} from './check-file-size-ratchet.ts'

function lines(count: number) {
	return Array.from(
		{ length: count },
		(_, index) => `line-${String(index)}`,
	).join('\n')
}

const identityFormat: FormatSourceForRatchet = async (_path, sourceText) =>
	sourceText

test('countLines treats a trailing newline as one terminator, not an extra line', () => {
	expect(countLines('')).toBe(0)
	expect(countLines('one\n')).toBe(1)
	expect(countLines('one\ntwo\n')).toBe(2)
	expect(countLines(lines(800))).toBe(800)
})

test('parseFileSizeRatchetSnapshot rejects a malformed snapshot', () => {
	expect(() => parseFileSizeRatchetSnapshot('[]')).toThrow(/must be an object/)
	expect(() => parseFileSizeRatchetSnapshot('{"client-routes":[]}')).toThrow(
		/agents-md/,
	)
})

test('formatOptionsFromOxfmtConfig drops ignorePatterns and overrides', () => {
	const options = formatOptionsFromOxfmtConfig({
		printWidth: 80,
		semi: false,
		ignorePatterns: ['**/dist/**'],
		overrides: [{ files: ['**/package.json'], options: { useTabs: false } }],
		$schema: 'https://example.test/schema.json',
	})
	expect(options).toEqual({ printWidth: 80, semi: false })
	expect(options).not.toHaveProperty('ignorePatterns')
	expect(options).not.toHaveProperty('overrides')
	expect(options).not.toHaveProperty('$schema')
})

test('formatSourceWithRepoOxfmt throws when oxfmt returns Error-severity diagnostics', async () => {
	await expect(
		formatSourceWithRepoOxfmt('broken.node.test.ts', 'const x = {\n'),
	).rejects.toThrow(/Oxfmt failed to format broken\.node\.test\.ts/)
	await expect(
		formatSourceWithRepoOxfmt('ok.node.test.ts', 'const x = 1\n'),
	).resolves.toContain('const x = 1')
})

test('checkFileSizeRatchet allows grandfathered files and rejects new over-budget files', async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), 'file-size-ratchet-'))
	try {
		const routesDir = path.join(cwd, 'packages', 'worker', 'client', 'routes')
		const testsDir = path.join(cwd, 'packages', 'worker', 'src')
		await Promise.all([
			mkdir(routesDir, { recursive: true }),
			mkdir(testsDir, { recursive: true }),
		])
		await Promise.all([
			writeFile(path.join(cwd, 'AGENTS.md'), `${lines(10)}\n`),
			writeFile(path.join(routesDir, 'small.tsx'), `${lines(10)}\n`),
			writeFile(path.join(routesDir, 'legacy.tsx'), `${lines(900)}\n`),
			writeFile(path.join(routesDir, 'new-large.tsx'), `${lines(801)}\n`),
			writeFile(path.join(testsDir, 'legacy.node.test.ts'), `${lines(2500)}\n`),
			writeFile(
				path.join(testsDir, 'new-large.node.test.ts'),
				`${lines(2001)}\n`,
			),
			writeFile(path.join(testsDir, 'gone.node.test.ts'), `${lines(10)}\n`),
		])

		const snapshot: FileSizeRatchetSnapshot = {
			'agents-md': [],
			'client-routes': ['packages/worker/client/routes/legacy.tsx'],
			'node-tests': [
				'packages/worker/src/legacy.node.test.ts',
				'packages/worker/src/missing.node.test.ts',
			],
		}

		const result = await checkFileSizeRatchet(cwd, snapshot, identityFormat)
		expect(result.ok).toBe(false)
		expect(result.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					file: 'packages/worker/client/routes/new-large.tsx',
					kind: 'new-over-budget',
					lineCount: 801,
					maxLines: 800,
				}),
				expect.objectContaining({
					file: 'packages/worker/src/new-large.node.test.ts',
					kind: 'new-over-budget',
					lineCount: 2001,
					maxLines: 2000,
				}),
				expect.objectContaining({
					file: 'packages/worker/src/missing.node.test.ts',
					kind: 'stale-snapshot',
				}),
			]),
		)
		expect(result.issues).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					file: 'packages/worker/client/routes/legacy.tsx',
				}),
				expect.objectContaining({
					file: 'packages/worker/src/legacy.node.test.ts',
					kind: 'new-over-budget',
				}),
				expect.objectContaining({
					file: 'AGENTS.md',
				}),
			]),
		)
	} finally {
		await rm(cwd, { recursive: true, force: true })
	}
})

test('checkFileSizeRatchet measures budget after formatting, not the raw working tree', async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), 'file-size-ratchet-fmt-'))
	try {
		const routesDir = path.join(cwd, 'packages', 'worker', 'client', 'routes')
		const testsDir = path.join(cwd, 'packages', 'worker', 'src')
		await Promise.all([
			mkdir(routesDir, { recursive: true }),
			mkdir(testsDir, { recursive: true }),
			writeFile(path.join(cwd, 'AGENTS.md'), `${lines(10)}\n`),
		])

		// Raw file is under the 2000-line node-test budget, but oxfmt expands
		// the joined expect onto many lines — the pre-#2867 false-green case.
		const padding = Array.from(
			{ length: 1990 },
			(_, index) => `const pad${String(index)} = ${String(index)}`,
		).join('\n')
		const joinedExpect =
			'expect({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10, k: 11, l: 12, m: 13 }).toEqual({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10, k: 11, l: 12, m: 13 })'
		const overAfterFormat = `${padding}\n${joinedExpect}\n`
		expect(countLines(overAfterFormat)).toBeLessThanOrEqual(2000)
		expect(
			countLines(
				await formatSourceWithRepoOxfmt('x.node.test.ts', overAfterFormat),
			),
		).toBeGreaterThan(2000)

		await writeFile(
			path.join(testsDir, 'joined-over.node.test.ts'),
			overAfterFormat,
		)

		// Same shape but already under budget after format.
		const underPadding = Array.from(
			{ length: 10 },
			(_, index) => `const ok${String(index)} = ${String(index)}`,
		).join('\n')
		const underAfterFormat = `${underPadding}\n${joinedExpect}\n`
		expect(
			countLines(
				await formatSourceWithRepoOxfmt('y.node.test.ts', underAfterFormat),
			),
		).toBeLessThanOrEqual(2000)
		await writeFile(
			path.join(testsDir, 'joined-under.node.test.ts'),
			underAfterFormat,
		)

		const snapshot: FileSizeRatchetSnapshot = {
			'agents-md': [],
			'client-routes': [],
			'node-tests': [],
		}

		const identityResult = await checkFileSizeRatchet(
			cwd,
			snapshot,
			identityFormat,
		)
		expect(identityResult.ok).toBe(true)

		const formattedResult = await checkFileSizeRatchet(cwd, snapshot)
		expect(formattedResult.ok).toBe(false)
		expect(formattedResult.issues).toEqual([
			expect.objectContaining({
				file: 'packages/worker/src/joined-over.node.test.ts',
				kind: 'new-over-budget',
				maxLines: 2000,
			}),
		])
		expect(formattedResult.issues[0]?.lineCount).toBeGreaterThan(2000)
		expect(formattedResult.issues).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					file: 'packages/worker/src/joined-under.node.test.ts',
				}),
			]),
		)
	} finally {
		await rm(cwd, { recursive: true, force: true })
	}
})

test('checkFileSizeRatchet rejects oversized AGENTS.md even when snapshot-listed', async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), 'agents-md-ratchet-'))
	try {
		await writeFile(path.join(cwd, 'AGENTS.md'), `${lines(25)}\n`)
		const snapshot: FileSizeRatchetSnapshot = {
			'agents-md': ['AGENTS.md'],
			'client-routes': [],
			'node-tests': [],
		}
		const result = await checkFileSizeRatchet(cwd, snapshot, identityFormat)
		expect(result.ok).toBe(false)
		expect(result.issues).toEqual([
			expect.objectContaining({
				file: 'AGENTS.md',
				groupId: 'agents-md',
				kind: 'new-over-budget',
				lineCount: 25,
				maxLines: 23,
			}),
		])
	} finally {
		await rm(cwd, { recursive: true, force: true })
	}
})
