import { spawnSync } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from 'vitest'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const ruleName = 'no-raw-dialog'
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

test('oxlint points raw dialogs at the shared Dialog', async () => {
	const output = await lint([
		'export const a = <dialog open>Hi</dialog>',
		'export const b = <Dialog open aria-label="Hi">Hi</Dialog>',
		'declare const Dialog: (props: Record<string, unknown>) => null',
	])
	expect(output.split(diagnostic).length - 1).toBe(1)
	expect(output).toContain('Render <Dialog> from start/components/dialog.tsx')
})
