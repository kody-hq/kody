import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	isResourceLimitRefusal,
	offloadCommandsText,
	publishLargePackagesDocsUrl,
	runPublishWithBuild,
} from '../src/publish-offload.js'
import { runLocalPublishBuild } from '../src/local-publish-build.js'

function git(dir: string, ...args: Array<string>) {
	return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
}

function repo(files: Record<string, string>) {
	const dir = mkdtempSync(join(tmpdir(), 'kody-publish-build-'))
	git(dir, 'init', '--quiet')
	git(dir, 'config', 'user.email', 'test@example.com')
	git(dir, 'config', 'user.name', 'Test')
	for (const [path, content] of Object.entries(files)) {
		writeFileSync(join(dir, path), content)
	}
	git(dir, 'add', '-A')
	git(dir, 'commit', '--quiet', '-m', 'init')
	return { dir, commit: git(dir, 'rev-parse', 'HEAD') }
}

const encoder = new TextEncoder()
const fakeBuilder = async () => ({
	publishBuilderVersion: 1,
	close: async () => {},
	buildPublishTargets: async (input: {
		sourceFiles: Record<string, string>
	}) => [
		{
			target: {
				kind: 'module',
				bundleKind: 'module' as const,
				entryPoint: 'index.ts',
			},
			mainModule: 'index.js',
			modules: {
				'index.js': encoder.encode(
					`js\0${input.sourceFiles['index.ts'] ?? ''}`,
				),
			},
			inlinedPackageIds: [],
		},
	],
})

function fakeServer(alreadyUploaded: Array<string> = []) {
	const puts: Array<string> = []
	let sealed: Record<string, unknown> | null = null
	const fetchFn = (async (url: string, init?: RequestInit) => {
		assert.equal(
			new Headers(init?.headers).get('authorization'),
			'Bearer kpb_ticket',
		)
		if (!init?.method) {
			return Response.json({ uploaded_chunks: alreadyUploaded })
		}
		if (init.method === 'PUT') {
			puts.push(url.split('/').at(-1)!)
			return Response.json({ ok: true })
		}
		sealed = JSON.parse(String(init.body))
		return Response.json({ ok: true, status: 'sealed' })
	}) as typeof fetch
	return { fetchFn, puts, sealed: () => sealed }
}

const ticket = (commit: string) => ({
	buildId: 'pb_1',
	packageId: 'pkg-1',
	commit,
	userId: '',
	uploadUrl: 'https://kody.test/v1/publish-builds/pb_1',
	ticket: 'kpb_ticket',
})

test('local publish build uploads content-addressed chunks and seals the manifest', async () => {
	const { dir, commit } = repo({
		'package.json': '{}',
		'index.ts': 'export default 1',
	})
	const server = fakeServer()
	const result = await runLocalPublishBuild({
		dir,
		ticket: ticket(commit),
		apiUrl: 'https://kody.test',
		fetchFn: server.fetchFn,
		loadBuilder: fakeBuilder,
	})
	assert.equal(result.targets, 1)
	assert.equal(server.puts.length, 1)
	const sealed = server.sealed() as {
		commit: string
		files: Array<{ path: string }>
	}
	assert.equal(sealed.commit, commit)
	assert.deepEqual(sealed.files.map((file) => file.path).sort(), [
		'index.ts',
		'package.json',
	])
})

test('a rerun resumes: chunks Kody already has are not uploaded again', async () => {
	const { dir, commit } = repo({
		'package.json': '{}',
		'index.ts': 'export default 1',
	})
	const first = fakeServer()
	await runLocalPublishBuild({
		dir,
		ticket: ticket(commit),
		apiUrl: 'https://kody.test',
		fetchFn: first.fetchFn,
		loadBuilder: fakeBuilder,
	})
	const second = fakeServer(first.puts)
	const result = await runLocalPublishBuild({
		dir,
		ticket: ticket(commit),
		apiUrl: 'https://kody.test',
		fetchFn: second.fetchFn,
		loadBuilder: fakeBuilder,
	})
	assert.equal(second.puts.length, 0)
	assert.equal(result.reusedChunks, 1)
})

test('local publish build refuses a dirty tree or a HEAD that is not the pushed commit', async () => {
	const { dir, commit } = repo({
		'package.json': '{}',
		'index.ts': 'export default 1',
	})
	writeFileSync(join(dir, 'index.ts'), 'export default 2')
	await assert.rejects(
		runLocalPublishBuild({
			dir,
			ticket: ticket(commit),
			apiUrl: 'https://kody.test',
			fetchFn: fakeServer().fetchFn,
			loadBuilder: fakeBuilder,
		}),
		/clean working tree/,
	)
	git(dir, 'checkout', '--quiet', '--', 'index.ts')
	await assert.rejects(
		runLocalPublishBuild({
			dir,
			ticket: ticket('0'.repeat(40)),
			apiUrl: 'https://kody.test',
			fetchFn: fakeServer().fetchFn,
			loadBuilder: fakeBuilder,
		}),
		/not the pushed commit/,
	)
})

test('a cloud resource-limit refusal prints the offload commands and docs link for agents', async () => {
	const refusal = {
		status: 'refused',
		message: `Out of memory. See ${publishLargePackagesDocsUrl}`,
	}
	assert.equal(isResourceLimitRefusal(refusal), true)
	assert.equal(isResourceLimitRefusal({ status: 'published' }), false)
	let stderr = ''
	const result = await runPublishWithBuild({
		build: null,
		target: { kody_id: '@me/big' },
		call: async () => refusal,
		apiUrl: 'https://kody.test',
		cwd: process.cwd(),
		interactive: false,
		writeErr: (text) => {
			stderr += text
		},
	})
	assert.equal(result, refusal)
	assert.match(stderr, /--build local/)
	assert.match(stderr, /--build context/)
	assert.ok(stderr.includes(publishLargePackagesDocsUrl))
	assert.ok(offloadCommandsText('@me/big').includes('@me/big'))
})

test('--build rejects unknown values', async () => {
	await assert.rejects(
		runPublishWithBuild({
			build: 'cloud',
			target: {},
			call: async () => ({}),
			apiUrl: 'https://kody.test',
			cwd: process.cwd(),
			interactive: false,
			writeErr: () => {},
		}),
		/--build must be local or context/,
	)
})
