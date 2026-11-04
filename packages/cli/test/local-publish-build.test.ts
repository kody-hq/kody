import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	isResourceLimitRefusal,
	offloadCommandsText,
	publishLargePackagesDocsUrl,
	runPublishWithBuild,
} from '../src/publish-offload.js'
import {
	buildWorkingTreeLocally,
	contextCloneGitEnv,
	publishBuildUploadUrl,
	runLocalPublishBuild,
} from '../src/local-publish-build.js'
import { OpenApiError } from '../src/open-api-client.js'

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
		files: Array<{ path: string; base64: string }>
	}) => {
		const bytes = (path: string) =>
			Buffer.from(
				input.files.find((file) => file.path === path)?.base64 ?? '',
				'base64',
			)
		return {
			files: input.files.map((file) => ({
				path: file.path,
				size: bytes(file.path).byteLength,
				sha256: createHash('sha256').update(bytes(file.path)).digest('hex'),
			})),
			targets: [
				{
					target: {
						kind: 'module',
						bundleKind: 'module' as const,
						entryPoint: 'index.ts',
					},
					mainModule: 'index.js',
					modules: {
						'index.js': encoder.encode(
							`js\0${bytes('index.ts').toString('utf8')}`,
						),
					},
					inlinedPackageIds: [],
				},
			],
		}
	},
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

test('uploads go to the Open API host the CLI uses, not the app origin', () => {
	assert.equal(
		publishBuildUploadUrl(
			'https://kody-pr-1-api.example.dev',
			'/v1/publish-builds/pb_1',
		),
		'https://kody-pr-1-api.example.dev/v1/publish-builds/pb_1',
	)
	assert.equal(
		publishBuildUploadUrl('http://localhost:3742/', '/v1/publish-builds/pb_1'),
		'http://localhost:3742/v1/publish-builds/pb_1',
	)
})

test('a resource-limit HTTP error still prints the offload commands', async () => {
	const failure = new OpenApiError(
		`Exceeded memory limit. See ${publishLargePackagesDocsUrl}`,
		{ status: 500 },
	)
	let stderr = ''
	await assert.rejects(
		runPublishWithBuild({
			build: null,
			target: { kody_id: '@me/big' },
			call: async () => {
				throw failure
			},
			apiUrl: 'https://kody.test',
			cwd: process.cwd(),
			interactive: false,
			writeErr: (text) => {
				stderr += text
			},
		}),
		(error) => error === failure,
	)
	assert.match(stderr, /--build local/)
	assert.ok(stderr.includes(publishLargePackagesDocsUrl))
	await assert.rejects(
		runPublishWithBuild({
			build: null,
			target: {},
			call: async () => {
				throw new OpenApiError('Unauthorized', { status: 401 })
			},
			apiUrl: 'https://kody.test',
			cwd: process.cwd(),
			interactive: false,
			writeErr: () => {
				throw new Error('should not print offload commands')
			},
		}),
		/Unauthorized/,
	)
})

test('the context clone token goes in git config env, never argv or the URL', () => {
	const env = contextCloneGitEnv('art_secret?expires=123')
	assert.equal(env.GIT_CONFIG_KEY_0, 'http.extraHeader')
	assert.equal(
		env.GIT_CONFIG_VALUE_0,
		`Authorization: Basic ${Buffer.from('x:art_secret').toString('base64')}`,
	)
	assert.equal(env.GIT_TERMINAL_PROMPT, '0')
})

test('a builder that fails to start leaves no temp folder', async () => {
	const { dir } = repo({ 'index.ts': 'export default 1' })
	const leftovers = () =>
		readdirSync(tmpdir()).filter((name) =>
			name.startsWith('kody-publish-builder-'),
		).length
	const before = leftovers()
	const previous = process.env.KODY_PUBLISH_BUILDER_DIR
	process.env.KODY_PUBLISH_BUILDER_DIR = join(dir, 'no-builder-here')
	try {
		await assert.rejects(
			buildWorkingTreeLocally({
				dir,
				packageId: 'pkg-1',
				apiUrl: 'https://kody.test',
			}),
		)
	} finally {
		if (previous === undefined) delete process.env.KODY_PUBLISH_BUILDER_DIR
		else process.env.KODY_PUBLISH_BUILDER_DIR = previous
	}
	assert.equal(leftovers(), before)
})
