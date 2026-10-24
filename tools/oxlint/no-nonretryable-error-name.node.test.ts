import { spawnSync } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const ruleName = 'no-nonretryable-error-name'
const diagnostic = `kody-custom(${ruleName})`

async function lint(lines: Array<string>) {
	const fixturePath = path.join(
		os.tmpdir(),
		`${ruleName}-${String(process.pid)}-${String(Date.now())}.ts`,
	)
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
		await rm(fixturePath, { force: true })
	}
}

test('oxlint rejects a custom name passed to NonRetryableError', async () => {
	const custom = await lint([
		"import { NonRetryableError } from 'cloudflare:workflows'",
		"export const a = new NonRetryableError('refused', 'SomeCode')",
		'export const b = (args: [string, string]) => new NonRetryableError(...args)',
	])
	expect(custom.output.split(diagnostic).length - 1).toBe(2)
	expect(custom.status).not.toBe(0)

	const plain = await lint([
		"import { NonRetryableError } from 'cloudflare:workflows'",
		"export const a = new NonRetryableError('[some-code] refused')",
	])
	expect(plain.output).not.toContain(diagnostic)
	expect(plain.status).toBe(0)
})
