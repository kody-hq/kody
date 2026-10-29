import { execFileSync } from 'node:child_process'
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'esbuild'
import { expect, test } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))

test.each([
	'import type { ResolvedDocumentHead }',
	'import { type ResolvedDocumentHead }',
])(
	'lint fixes preserve erased imports at the shared data boundary: %s',
	async (declaration) => {
		const directory = mkdtempSync(join(tmpdir(), 'kody-type-import-policy-'))
		const relativeFile = 'packages/worker/universal/loader-data.ts'
		const file = join(directory, relativeFile)
		try {
			const config = JSON.parse(
				readFileSync(join(root, '.oxlintrc.json'), 'utf8'),
			)
			config.extends = config.extends.map((path: string) => resolve(root, path))
			writeFileSync(join(directory, '.oxlintrc.json'), JSON.stringify(config))
			mkdirSync(dirname(file), { recursive: true })
			writeFileSync(
				join(dirname(file), 'document-head-contract.ts'),
				'export type ResolvedDocumentHead = { title: string }\n',
			)
			writeFileSync(
				file,
				`${declaration} from './document-head-contract.ts'\nexport type Head = ResolvedDocumentHead\n`,
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
						relativeFile,
					],
					{ cwd: directory, stdio: 'pipe' },
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
	},
)
