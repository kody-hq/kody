import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { runDevCheck } from '../src/dev-command.js'
import {
	formatUnpublishedBundleInputMessage,
	listPackageCheckPaths,
	unpublishedBundleInputPaths,
} from '../src/package-check-files.js'

const execFileAsync = promisify(execFile)

async function git(root: string, ...args: Array<string>) {
	await execFileAsync('git', ['-C', root, ...args], {
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'kody-test',
			GIT_AUTHOR_EMAIL: 'kody-test@example.com',
			GIT_COMMITTER_NAME: 'kody-test',
			GIT_COMMITTER_EMAIL: 'kody-test@example.com',
		},
	})
}

async function writeGeneratedImportPackage(
	root: string,
	options?: { prebuild?: boolean },
) {
	await writeFile(
		join(root, 'package.json'),
		JSON.stringify({
			name: '@local/gen-export',
			type: 'module',
			exports: { './run': './src/index.ts' },
			kody: {
				id: 'gen-export',
				...(options?.prebuild
					? { dev: { prebuild: 'node scripts/gen.mjs' } }
					: {}),
			},
		}),
	)
	await writeFile(join(root, 'README.md'), '# gen-export\n')
	await writeFile(join(root, 'AGENTS.md'), '# Agents\n')
	await writeFile(join(root, '.gitignore'), 'src/generated.js\n')
	await mkdir(join(root, 'src'), { recursive: true })
	await writeFile(
		join(root, 'src/index.ts'),
		`import { value } from './generated.js'\nexport default async () => value\n`,
	)
	await writeFile(join(root, 'src/generated.js'), `export const value = 42\n`)
}

function capture() {
	let stdout = ''
	return {
		io: {
			stdout: (text: string) => {
				stdout += text
			},
			stderr: () => {},
		},
		get stdout() {
			return stdout
		},
	}
}

test('listPackageCheckPaths omits gitignored files', async () => {
	const root = await mkdtemp(join(tmpdir(), 'kody-check-paths-'))
	try {
		await writeGeneratedImportPackage(root)
		await git(root, 'init')
		await git(
			root,
			'add',
			'package.json',
			'README.md',
			'AGENTS.md',
			'.gitignore',
			'src/index.ts',
		)
		await git(root, 'commit', '-m', 'init')
		const paths = await listPackageCheckPaths(root)
		assert.ok(paths.includes('src/index.ts'))
		assert.ok(!paths.includes('src/generated.js'))
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 10 })
	}
})

test('unpublishedBundleInputPaths flags inputs outside the snapshot set', () => {
	assert.deepEqual(
		unpublishedBundleInputPaths({
			absoluteInputs: [
				join('/pkg', 'src/index.ts'),
				join('/pkg', 'src/generated.js'),
			],
			packageRoot: '/pkg',
			snapshotPaths: new Set(['src/index.ts']),
		}),
		['src/generated.js'],
	)
})

test('formatUnpublishedBundleInputMessage mentions prebuild only when declared', () => {
	assert.match(
		formatUnpublishedBundleInputMessage('src/generated.js'),
		/will not be in the published snapshot/,
	)
	assert.doesNotMatch(
		formatUnpublishedBundleInputMessage('src/generated.js'),
		/prebuild/,
	)
	assert.match(
		formatUnpublishedBundleInputMessage('src/generated.js', {
			hasPrebuild: true,
		}),
		/kody\.dev\.prebuild runs only in `kody dev`/,
	)
})

test('kody dev check --offline fails when an export imports a gitignored file', async () => {
	const root = await mkdtemp(join(tmpdir(), 'kody-check-gitignore-'))
	try {
		await writeGeneratedImportPackage(root)
		await git(root, 'init')
		await git(
			root,
			'add',
			'package.json',
			'README.md',
			'AGENTS.md',
			'.gitignore',
			'src/index.ts',
		)
		await git(root, 'commit', '-m', 'init')
		const out = capture()
		const code = await runDevCheck({
			target: 'mock',
			cwd: root,
			offline: true,
			io: out.io,
			runPublishChecks: async () => {
				throw new Error('must not be called offline')
			},
		})
		assert.equal(code, 1)
		assert.match(out.stdout, /^FAIL\s+export:\.\/run/m)
		assert.match(
			out.stdout,
			/src\/generated\.js is imported but will not be in the published snapshot/,
		)
		assert.doesNotMatch(out.stdout, /kody\.dev\.prebuild/)
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 10 })
	}
})

test('kody dev check --offline hints that prebuild is serve-only when declared', async () => {
	const root = await mkdtemp(join(tmpdir(), 'kody-check-prebuild-hint-'))
	try {
		await writeGeneratedImportPackage(root, { prebuild: true })
		await git(root, 'init')
		await git(
			root,
			'add',
			'package.json',
			'README.md',
			'AGENTS.md',
			'.gitignore',
			'src/index.ts',
		)
		await git(root, 'commit', '-m', 'init')
		const out = capture()
		const code = await runDevCheck({
			target: 'mock',
			cwd: root,
			offline: true,
			io: out.io,
		})
		assert.equal(code, 1)
		assert.match(out.stdout, /kody\.dev\.prebuild runs only in `kody dev`/)
		assert.match(out.stdout, /commit generated output/)
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 10 })
	}
})

test('kody dev check --offline passes when the generated import is committed', async () => {
	const root = await mkdtemp(join(tmpdir(), 'kody-check-committed-gen-'))
	try {
		await writeGeneratedImportPackage(root)
		await writeFile(join(root, '.gitignore'), 'node_modules/\n')
		await git(root, 'init')
		await git(
			root,
			'add',
			'package.json',
			'README.md',
			'AGENTS.md',
			'.gitignore',
			'src/index.ts',
			'src/generated.js',
		)
		await git(root, 'commit', '-m', 'init')
		const out = capture()
		const code = await runDevCheck({
			target: 'mock',
			cwd: root,
			offline: true,
			io: out.io,
		})
		assert.equal(code, 0)
		assert.match(out.stdout, /kody dev check passed/)
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 10 })
	}
})
