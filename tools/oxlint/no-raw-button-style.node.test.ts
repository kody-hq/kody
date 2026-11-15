import { spawnSync } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const ruleName = 'no-raw-button-style'
const diagnostic = `kody-custom(${ruleName})`

async function lint(lines: Array<string>) {
	const fixturePath = path.join(
		os.tmpdir(),
		`${ruleName}-${String(process.pid)}-${String(Date.now())}.tsx`,
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

test('oxlint rejects pill radii on clickable styles', async () => {
	const pills = await lint([
		"import { radius } from '#universal/styles/tokens.ts'",
		"export const a = { cursor: 'pointer', borderRadius: radius.full }",
		"export const b = { borderRadius: '999px', cursor: 'pointer' }",
	])
	expect(pills.output.split(diagnostic).length - 1).toBe(2)
	expect(pills.status).not.toBe(0)
})

test('oxlint rejects getButtonCss on raw button elements', async () => {
	const raw = await lint([
		"import { getButtonCss } from '#universal/styles/style-primitives.ts'",
		"export const a = <button css={getButtonCss({ variant: 'primary' })} />",
		'export const b = <a href="/" css={[getButtonCss(), { width: \'100%\' }]} />',
	])
	expect(raw.output.split(diagnostic).length - 1).toBe(2)
	expect(raw.status).not.toBe(0)
})

test('oxlint allows badges and the shared squircle helper', async () => {
	const allowed = await lint([
		"import { radius } from '#universal/styles/tokens.ts'",
		"import { getSquircleCss } from '#universal/styles/style-primitives.ts'",
		'export const badge = { borderRadius: radius.full }',
		"export const tab = { cursor: 'pointer', ...getSquircleCss('xs') }",
	])
	expect(allowed.output).not.toContain(diagnostic)
})
