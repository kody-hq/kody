import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'esbuild'
import { expect, test } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))

test.each([
	'import type { ResolvedDocumentHead }',
	'import { type ResolvedDocumentHead }',
])('lint fixes preserve erased browser imports: %s', async (declaration) => {
	const directory = mkdtempSync(
		join(root, 'packages/worker/client/.type-import-policy-'),
	)
	const file = join(directory, 'fixture.ts')
	try {
		writeFileSync(
			file,
			`${declaration} from '../../universal/document-head-contract.ts'\nexport type Head = ResolvedDocumentHead\n`,
		)
		const fix = () =>
			execFileSync(
				process.execPath,
				[
					join(root, 'node_modules/oxlint/bin/oxlint'),
					'--config',
					'.oxlintrc.json',
					'--no-ignore',
					'--fix',
					relative(root, file),
				],
				{ cwd: root, stdio: 'pipe' },
			)
		fix()
		const first = readFileSync(file, 'utf8')
		fix()
		const second = readFileSync(file, 'utf8')
		expect(second).toBe(first)
		expect(second).toMatch(/import\s+type\s+\{/)
		const emitted = await transform(second, {
			loader: 'ts',
			format: 'esm',
			tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
		})
		expect(emitted.code).not.toMatch(/\bimport\b/)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
})
