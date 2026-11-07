import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import {
	collectPackageCheckFiles,
	createKodyIgnoreMatcher,
	listPackageCheckPaths,
} from '../src/package-check-files.js'

const execFileAsync = promisify(execFile)
const packageCheckBodyLimitBytes = 5 * 1024 * 1024

async function writeTree(root: string, files: Record<string, string>) {
	for (const [path, content] of Object.entries(files)) {
		await mkdir(join(root, path, '..'), { recursive: true })
		await writeFile(join(root, path), content)
	}
}

const baseTree = {
	'package.json': JSON.stringify({
		name: '@example/notes-demo',
		exports: { '.': './src/index.ts' },
		kody: { id: 'notes-demo', description: 'Synthetic notes package.' },
	}),
	'README.md': '# notes-demo\n',
	'AGENTS.md': '# Agents\n',
	'src/index.ts': 'export default async () => null\n',
}

for (const useGit of [false, true]) {
	test(`dev check upload omits a .kodyignore'd file over 5 MiB (${useGit ? 'git checkout' : 'plain folder'})`, async () => {
		const root = await mkdtemp(join(tmpdir(), 'kody-kodyignore-'))
		try {
			await writeTree(root, {
				...baseTree,
				'.kodyignore': 'notes/\n',
				'notes/research.md': 'n'.repeat(Math.round(9.4 * 1024 * 1024)),
			})
			if (useGit) await execFileAsync('git', ['init', '-q', root])
			const tree = await collectPackageCheckFiles(root)

			assert.deepEqual(Object.keys(tree.files).sort(), [
				'.kodyignore',
				'AGENTS.md',
				'README.md',
				'package.json',
				'src/index.ts',
			])
			const body = JSON.stringify({ files: tree.files })
			assert.ok(Buffer.byteLength(body) < packageCheckBodyLimitBytes)
			assert.ok(
				!(await listPackageCheckPaths(root)).includes('notes/research.md'),
			)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
}

test('without .kodyignore the large notes file is still uploaded (no silent drop)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'kody-kodyignore-'))
	try {
		await writeTree(root, { ...baseTree, 'notes/research.md': 'notes\n' })
		const tree = await collectPackageCheckFiles(root)
		assert.equal(tree.files['notes/research.md'], 'notes\n')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('CLI .kodyignore matcher matches the server semantics', () => {
	assert.equal(createKodyIgnoreMatcher(null), null)
	assert.equal(createKodyIgnoreMatcher('  \n'), null)
	const matches = createKodyIgnoreMatcher(
		'*\n!src/\n!src/**\n**/__tests__/\n!types/__tests__/\n',
	)!
	// package.json and .kodyignore are always kept, even under `*`.
	assert.equal(matches('package.json'), false)
	assert.equal(matches('.kodyignore'), false)
	assert.equal(matches('/package.json'), false)
	assert.equal(matches('notes/research.md'), true)
	assert.equal(matches('src/index.ts'), false)
	assert.equal(matches('src/__tests__/case.ts'), true)
	const negated = createKodyIgnoreMatcher('**/__tests__/\n!types/__tests__/\n')!
	assert.equal(negated('src/__tests__/case.ts'), true)
	assert.equal(negated('types/__tests__/runtime.d.ts'), false)
	assert.equal(negated(''), false)
})
