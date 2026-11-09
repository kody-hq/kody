import { spawnSync } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const ruleName = 'user-meter-budget-check-via-helper'
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

test('oxlint rejects UserMeter budget check calls outside the helper', async () => {
	const direct = await lint([
		'declare const meter: any',
		'export const a = meter.checkBudgetAndRecord({})',
		"export const b = meter['assertWithinBudgetAndRecord']({})",
		'export const { checkBudgetAndRecord: c } = meter',
		'export const d = Reflect.get(meter, `checkBudgetAndRecord`)',
	])
	expect(direct.output.split(diagnostic).length - 1).toBe(4)
	expect(direct.status).not.toBe(0)

	const viaHelper = await lint([
		'declare const checkUserMeterBudgetAndRecord: (input: unknown) => unknown',
		'export const a = checkUserMeterBudgetAndRecord({})',
	])
	expect(viaHelper.output).not.toContain(diagnostic)
	expect(viaHelper.status).toBe(0)
})
