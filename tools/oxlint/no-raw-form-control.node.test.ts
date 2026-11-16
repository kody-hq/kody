import { spawnSync } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from 'vitest'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const ruleName = 'no-raw-form-control'
const diagnostic = `kody-custom(${ruleName})`

async function lint(lines: Array<string>) {
	const fixturePath = path.join(
		repoRoot,
		'packages/worker/start/pages',
		`${ruleName}-fixture-${String(process.pid)}-${String(Date.now())}.tsx`,
	)
	await writeFile(fixturePath, [...lines, ''].join('\n'))
	try {
		const result = spawnSync(
			path.join(repoRoot, 'node_modules', 'oxlint', 'bin', 'oxlint'),
			[fixturePath],
			{ cwd: repoRoot, encoding: 'utf8' },
		)
		return `${result.stdout}\n${result.stderr}`
	} finally {
		await rm(fixturePath, { force: true })
	}
}

test('oxlint points raw form controls at the shared components', async () => {
	const output = await lint([
		'export const a = <input name="q" />',
		'export const b = <input type="email" />',
		'export const c = <input type="checkbox" />',
		'export const d = <input type="radio" />',
		'export const e = <select><option>One</option></select>',
		'export const f = <textarea />',
	])
	expect(output.split(diagnostic).length - 1).toBe(6)
	expect(output).toContain('Render <Input>')
	expect(output).toContain('Render <Checkbox>')
	expect(output).toContain('Render <Radio>')
	expect(output).toContain('Render <Select>')
	expect(output).toContain('Render <Textarea>')
})

test('oxlint allows native-only inputs and the shared components', async () => {
	const output = await lint([
		"import { Input, Select } from '../components/input.tsx'",
		'export const a = <input type="hidden" name="intent" value="save" />',
		'export const b = <input type="file" />',
		'export const c = <input type="range" />',
		'export const d = <Input name="q" />',
		'export const e = <Select><option>One</option></Select>',
	])
	expect(output).not.toContain(diagnostic)
})
