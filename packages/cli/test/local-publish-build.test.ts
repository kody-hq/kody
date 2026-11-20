import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
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
	gitMissingMessage,
	publishBuildUploadUrl,
	runContextPublishBuild,
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
	publishBuilderVersion: 2,
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

function repoWithKodyRemote(files: Record<string, string>) {
	const local = repo(files)
	const remote = mkdtempSync(join(tmpdir(), 'kody-publish-remote-'))
	git(remote, 'init', '--quiet', '--bare')
	git(local.dir, 'remote', 'add', 'kody', remote)
	git(local.dir, 'push', '--quiet', '-u', 'kody', 'HEAD:main')
	return { ...local, remote }
}

function fakePublishCall(input: {
	remote: string
	confirm?: (expected: string) => string
}) {
	const calls: Array<{ operationId: string; params: Record<string, unknown> }> =
		[]
	const call = async (operationId: string, params: Record<string, unknown>) => {
		calls.push({ operationId, params })
		if (operationId === 'packageGetGitRemote') {
			return {
				remote: input.remote,
				git_extra_header: 'Authorization: Bearer minted-for-this-publish',
			}
		}
		if (operationId === 'packagePublishBuildCreate') {
			const expected = String(params.expected_commit)
			// Kody resolves the commit from its own copy of the repo.
			const serverHead = git(input.remote, 'rev-parse', 'refs/heads/main')
			return {
				build_id: 'pb_1',
				package_id: 'pkg-1',
				commit: input.confirm ? input.confirm(expected) : serverHead,
				upload_path: '/v1/publish-builds/pb_1',
				upload_ticket: 'kpb_ticket',
			}
		}
		return { status: 'published' }
	}
	return { call, calls }
}

test('--build local refuses a dirty tree before pushing or asking Kody', async () => {
	const { dir, remote } = repoWithKodyRemote({
		'package.json': '{}',
		'index.ts': 'export default 1',
	})
	writeFileSync(join(dir, 'index.ts'), 'export default 2')
	const kody = fakePublishCall({ remote })
	await assert.rejects(
		runPublishWithBuild({
			build: 'local',
			target: { kody_id: '@me/pkg' },
			call: kody.call,
			apiUrl: 'https://kody.test',
			cwd: dir,
			interactive: false,
			writeErr: () => {},
			fetchFn: fakeServer().fetchFn,
			loadBuilder: fakeBuilder,
		}),
		/clean working tree/,
	)
	assert.equal(kody.calls.length, 0)
})

test('--build local pushes an unpushed HEAD, has Kody confirm it, then builds it', async () => {
	const {
		dir,
		remote,
		commit: pushedBefore,
	} = repoWithKodyRemote({
		'package.json': '{}',
		'index.ts': 'export default 1',
	})
	writeFileSync(join(dir, 'index.ts'), 'export default 2')
	git(dir, 'commit', '--quiet', '-am', 'local change')
	const head = git(dir, 'rev-parse', 'HEAD')
	assert.notEqual(head, pushedBefore)
	assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), pushedBefore)
	const kody = fakePublishCall({ remote })
	const server = fakeServer()
	const result = await runPublishWithBuild({
		build: 'local',
		target: { kody_id: '@me/pkg' },
		call: kody.call,
		apiUrl: 'https://kody.test',
		cwd: dir,
		interactive: false,
		writeErr: () => {},
		fetchFn: server.fetchFn,
		loadBuilder: fakeBuilder,
	})
	assert.deepEqual(result, { status: 'published' })
	// Pushed as-is: no new commit, and the remote is at HEAD.
	assert.equal(git(dir, 'rev-parse', 'HEAD'), head)
	assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), head)
	assert.deepEqual(
		kody.calls.map((entry) => entry.operationId),
		[
			'packageGetGitRemote',
			'packagePublishBuildCreate',
			'packagePublishExternalPush',
		],
	)
	assert.deepEqual(kody.calls[0]!.params, {
		kody_id: '@me/pkg',
		scope: 'write',
		ttl_seconds: 900,
	})
	assert.equal(kody.calls[1]!.params.expected_commit, head)
	assert.equal((server.sealed() as { commit: string }).commit, head)
})

test('--build local never builds or uploads a commit Kody does not confirm', async () => {
	const { dir, remote } = repoWithKodyRemote({
		'package.json': '{}',
		'index.ts': 'export default 1',
	})
	let builderStarted = false
	const loadBuilder = async () => {
		builderStarted = true
		return await fakeBuilder()
	}
	const server = fakeServer()
	const kody = fakePublishCall({ remote, confirm: () => '0'.repeat(40) })
	await assert.rejects(
		runPublishWithBuild({
			build: 'local',
			target: { kody_id: '@me/pkg' },
			call: kody.call,
			apiUrl: 'https://kody.test',
			cwd: dir,
			interactive: false,
			writeErr: () => {},
			fetchFn: server.fetchFn,
			loadBuilder,
		}),
		/Nothing was built or uploaded/,
	)
	// The server's own refusal (expected_commit mismatch) stops it the same way.
	await assert.rejects(
		runPublishWithBuild({
			build: 'local',
			target: { kody_id: '@me/pkg' },
			call: async () => {
				throw new Error(
					'Kody sees abc, not your commit def. Nothing was built.',
				)
			},
			apiUrl: 'https://kody.test',
			cwd: dir,
			interactive: false,
			writeErr: () => {},
			fetchFn: server.fetchFn,
			loadBuilder,
		}),
		/Nothing was built/,
	)
	assert.equal(builderStarted, false)
	assert.equal(server.puts.length, 0)
	assert.equal(server.sealed(), null)
	assert.deepEqual(
		kody.calls.map((entry) => entry.operationId),
		['packageGetGitRemote', 'packagePublishBuildCreate'],
	)
})

test('--build local pushes with a remote Kody mints, not the expired credential the clone stored', async () => {
	const { dir, remote } = repoWithKodyRemote({
		'package.json': '{}',
		'index.ts': 'export default 1',
	})
	// The clone's remote answers 403 the way an Artifacts remote does once
	// the token the checkout stored has expired.
	const expired = createServer((_request, response) => {
		response.writeHead(403).end('token expired')
	})
	await new Promise<void>((resolve) => expired.listen(0, '127.0.0.1', resolve))
	try {
		const { port } = expired.address() as AddressInfo
		git(
			dir,
			'remote',
			'set-url',
			'kody',
			`http://x:expired-token@127.0.0.1:${port}/package.git`,
		)
		writeFileSync(join(dir, 'index.ts'), 'export default 2')
		git(dir, 'commit', '--quiet', '-am', 'local change')
		const head = git(dir, 'rev-parse', 'HEAD')
		const kody = fakePublishCall({ remote })
		const result = await runPublishWithBuild({
			build: 'local',
			target: { kody_id: '@me/pkg' },
			call: kody.call,
			apiUrl: 'https://kody.test',
			cwd: dir,
			interactive: false,
			writeErr: () => {},
			fetchFn: fakeServer().fetchFn,
			loadBuilder: fakeBuilder,
		})
		assert.deepEqual(result, { status: 'published' })
		assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), head)
	} finally {
		await new Promise((resolve) => expired.close(resolve))
	}
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
	assert.match(stderr, /--context <name>/)
	assert.match(stderr, /execution-contexts#try-publishing-from-a-context/)
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

test('--context asks Kody to build on that context and is refused with --build local', async () => {
	const calls: Array<{ operationId: string; params: Record<string, unknown> }> =
		[]
	const call = async (operationId: string, params: Record<string, unknown>) => {
		calls.push({ operationId, params })
		return { status: 'published' }
	}
	const base = {
		target: { kody_id: '@me/pkg' },
		call,
		apiUrl: 'https://kody.test',
		cwd: tmpdir(),
		interactive: false,
		writeErr: () => {},
	}
	assert.deepEqual(
		await runPublishWithBuild({ ...base, build: null, context: 'build-box' }),
		{ status: 'published' },
	)
	assert.deepEqual(calls, [
		{
			operationId: 'packagePublishExternalPush',
			params: { kody_id: '@me/pkg', context: 'build-box' },
		},
	])
	await assert.rejects(
		runPublishWithBuild({ ...base, build: 'local', context: 'build-box' }),
		/cannot be combined with --build local/,
	)
	assert.equal(calls.length, 1)
})

test('a context publish build on a machine without git says so', async () => {
	const path = process.env.PATH
	process.env.PATH = mkdtempSync(join(tmpdir(), 'kody-no-git-'))
	try {
		await assert.rejects(
			runContextPublishBuild({
				source: {
					buildId: 'pb_1',
					packageId: 'pkg-1',
					commit: 'a'.repeat(40),
					clone: { remote: 'https://example.com/repo.git', token: 'token' },
					upload: { path: '/v1/publish-builds/pb_1', ticket: 'ticket' },
				},
				userId: 'user-1',
				apiUrl: 'https://kody.example',
			}),
			{ message: gitMissingMessage },
		)
	} finally {
		process.env.PATH = path
	}
})
