import { spawnSync } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from 'vitest'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const ruleName = 'no-raw-overlay'
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

test('oxlint points raw menus, tooltips, and tabs at the shared components', async () => {
	const output = await lint([
		"import { Menu } from '@base-ui/react/menu'",
		"import { Tooltip } from '@base-ui/react/tooltip'",
		'export const a = <div role="menu">Hi</div>',
		'export const b = <span role="tooltip">Hi</span>',
		'export const c = <div role="tablist">Hi</div>',
		'export const d = <div role="group">Hi</div>',
		'export const e = [Menu, Tooltip]',
	])
	expect(output.split(diagnostic).length - 1).toBe(5)
	expect(output).toContain('start/components/menu.tsx')
	expect(output).toContain('start/components/tooltip.tsx')
	expect(output).toContain('start/components/tabs.tsx')
})
