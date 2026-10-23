import { expect, test } from 'vitest'
import {
	buildPackageAgentsDocs,
	findRootPackageDoc,
	validateRequiredPackageDocs,
} from './required-package-docs.ts'

test('validateRequiredPackageDocs requires non-empty root README.md and AGENTS.md', () => {
	expect(validateRequiredPackageDocs({})).toEqual({
		ok: false,
		missing: ['README.md', 'AGENTS.md'],
		message: expect.stringContaining('README.md and AGENTS.md'),
	})
	expect(
		validateRequiredPackageDocs({
			'README.md': '# Hello\n\n## Intent\n\nDoes a thing.\n',
			'nested/AGENTS.md': 'Wrong place.\n',
		}),
	).toMatchObject({
		ok: false,
		missing: ['AGENTS.md'],
	})
	expect(
		validateRequiredPackageDocs({
			'README.md': '   \n',
			'AGENTS.md': '# Agents\n\nImport the root export.\n',
		}),
	).toMatchObject({
		ok: false,
		missing: ['README.md'],
	})
	expect(
		validateRequiredPackageDocs({
			'readme.md': '# Hello\n\nHuman setup.\n',
			'agents.md': '# Agents\n\nSmoke-test the root export.\n',
		}),
	).toEqual({
		ok: true,
		message: 'Validated root README.md and AGENTS.md.',
	})

	expect(
		findRootPackageDoc({ 'docs/README.md': '# Nested' }, 'README.md'),
	).toBe(null)
	expect(
		buildPackageAgentsDocs({
			files: {
				'AGENTS.md': '# Agents\n\nCall the export from execute.\n',
			},
		}),
	).toEqual({
		path: 'AGENTS.md',
		content: '# Agents\n\nCall the export from execute.',
		truncated: false,
	})
	expect(
		buildPackageAgentsDocs({
			files: { 'AGENTS.md': 'x'.repeat(80) },
			maxChars: 20,
		}),
	).toEqual({
		path: 'AGENTS.md',
		content: `${'x'.repeat(19)}…`,
		truncated: true,
	})
})
