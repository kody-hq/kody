import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	createIsolatedPublishWorkRunner,
	createPublishSnapshotCheckWorkspace,
	loadStagedPublishWorkFiles,
	stagePublishWorkFiles,
	type PublishWorkRequest,
} from './publish-work.ts'
import { type EntitySourceRow } from './types.ts'

const userId = ownerIdFromStored('user-1')

function createFakeKv() {
	const store = new Map<string, unknown>()
	const kv = {
		store,
		get: vi.fn(async (key: string, type?: string) => {
			const value = store.get(key)
			if (value === undefined) return null
			if (type === 'json') return JSON.parse(value as string)
			return value
		}),
		put: vi.fn(async (key: string, value: unknown) => {
			store.set(key, value)
		}),
		delete: vi.fn(async (key: string) => {
			store.delete(key)
		}),
	}
	return kv
}

const source = {
	id: 'source-1',
	user_id: 'user-1',
	entity_kind: 'package',
	entity_id: 'package-1',
	repo_id: 'repo-1',
	published_commit: 'commit-1',
	manifest_path: 'package.json',
	source_root: '/',
} as unknown as EntitySourceRow

test('publish work staging round-trips a tree larger than one KV value, binary bytes included', async () => {
	const kv = createFakeKv()
	const png = String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x00, 0xff)
	const files = {
		'package.json': '{"name":"@user/demo"}',
		// Past the 20 MiB chunk size, so staging must split it.
		'src/big.ts': `export const big = '${'é'.repeat(11 * 1024 * 1024)}'\n`,
		'assets/logo.png': png,
	}
	const stagingKey = await stagePublishWorkFiles({
		kv: kv as unknown as KVNamespace,
		userId,
		files,
	})
	expect(stagingKey.startsWith('repo-checks-staging:v1:user-1:')).toBe(true)
	const chunkPuts = kv.put.mock.calls.filter(([key]) =>
		String(key).includes(':chunk:'),
	)
	expect(chunkPuts.length).toBeGreaterThan(1)
	for (const [, value] of chunkPuts) {
		expect((value as ArrayBuffer).byteLength).toBeLessThanOrEqual(
			20 * 1024 * 1024,
		)
	}
	await expect(
		loadStagedPublishWorkFiles({
			kv: kv as unknown as KVNamespace,
			stagingKey,
		}),
	).resolves.toEqual(files)
	kv.store.delete(`${stagingKey}:chunk:1`)
	await expect(
		loadStagedPublishWorkFiles({
			kv: kv as unknown as KVNamespace,
			stagingKey,
		}),
	).resolves.toBeNull()
})

test('the snapshot check workspace passes binary blobs by size only, like kody dev check', async () => {
	const workspace = createPublishSnapshotCheckWorkspace({
		'package.json': '{"name":"@user/demo"}',
		'assets/logo.png': String.fromCharCode(0x89, 0x50, 0x00, 0xff),
	})
	await expect(workspace.readFile('package.json')).resolves.toBe(
		'{"name":"@user/demo"}',
	)
	await expect(workspace.readFile('assets/logo.png')).resolves.toBe('')
	await expect(workspace.stat('assets/logo.png')).resolves.toEqual({
		size: 4,
	})
	expect((await workspace.glob()).map((entry) => entry.path).sort()).toEqual([
		'assets/logo.png',
		'package.json',
	])
})

function createFakeNamespace(
	handler: (input: {
		name: string
		request: PublishWorkRequest
	}) => Promise<unknown>,
	lastStep: string | null = null,
) {
	const names: Array<string> = []
	return {
		names,
		namespace: {
			idFromName: (name: string) => ({ name }),
			get: (id: { name: string }) => {
				names.push(id.name)
				return {
					runIsolatedPublishWork: async (request: PublishWorkRequest) =>
						await handler({ name: id.name, request }),
					takeLastCheckStep: async () => lastStep,
				}
			},
		},
	}
}

test('every publish work step runs on its own fresh throwaway isolate', async () => {
	const kv = createFakeKv()
	const fake = createFakeNamespace(async ({ request }) =>
		request.op === 'store-credential-stamp' ? { stamped: true } : null,
	)
	const runner = createIsolatedPublishWorkRunner({
		REPO_SESSION: fake.namespace,
		BUNDLE_ARTIFACTS_KV: kv,
	} as unknown as Env)
	expect(runner?.isolated).toBe(true)
	const stagingKey = await runner!.stage({
		userId,
		files: { 'package.json': '{}' },
	})
	await runner!.run({
		op: 'store-credential-needs',
		stagingKey,
		userId,
		input: { source, publishedCommit: 'commit-2' },
	})
	await expect(
		runner!.run({
			op: 'store-credential-stamp',
			stagingKey,
			userId,
			input: { source, publishedCommit: 'commit-2' },
		}),
	).resolves.toEqual({ stamped: true })
	expect(fake.names).toHaveLength(2)
	expect(new Set(fake.names).size).toBe(2)
	expect(fake.names[0]).toMatch(
		/^isolated-publish-store-credential-needs-user-1-/,
	)
	await runner!.discard(stagingKey)
	expect([...kv.store.keys()]).toEqual([])
	expect(
		createIsolatedPublishWorkRunner({ APP_DB: {} } as unknown as Env),
	).toBeNull()
})

test('a compute-limit error lists the largest staged files runtime code does not import', async () => {
	const fake = createFakeNamespace(async () => {
		throw new Error(
			"Durable Object's isolate exceeded its memory limit and was reset.",
		)
	}, 'credentials')
	const runner = createIsolatedPublishWorkRunner({
		REPO_SESSION: fake.namespace,
		BUNDLE_ARTIFACTS_KV: createFakeKv(),
	} as unknown as Env)!
	const stagingKey = await runner.stage({
		userId,
		files: {
			'package.json': JSON.stringify({
				name: '@example/demo',
				exports: { '.': './src/index.ts' },
			}),
			'src/index.ts': 'export default async () => null',
			'scripts/generate.ts': 'x'.repeat(4096),
		},
	})
	const error = await runner
		.run({
			op: 'store-credential-stamp',
			stagingKey,
			userId,
			input: { source, publishedCommit: 'commit-2' },
		})
		.catch((caught: unknown) => caught as Error)
	expect((error as Error).message).toContain('exceeded a Kody compute limit')
	expect((error as Error).message).toContain('the credential stamp scan')
	expect((error as Error).message).toContain('`scripts/generate.ts`')
	expect((error as Error).message).toContain('`.kodyignore`')
})

test('a step that still hits the CPU limit on its own fails with a compute-limit message naming the step', async () => {
	const cpuReset = new Error(
		'Durable Object exceeded its CPU time limit and was reset.',
	)
	const fake = createFakeNamespace(async () => {
		throw cpuReset
	}, 'credentials')
	const runner = createIsolatedPublishWorkRunner({
		REPO_SESSION: fake.namespace,
		BUNDLE_ARTIFACTS_KV: createFakeKv(),
	} as unknown as Env)!
	const error = await runner
		.run({
			op: 'store-credential-stamp',
			stagingKey: 'repo-checks-staging:v1:user-1:key',
			userId,
			input: { source, publishedCommit: 'commit-2' },
		})
		.catch((caught: unknown) => caught as Error)
	expect(error).toBeInstanceOf(Error)
	expect((error as Error).message).toContain('exceeded a Kody compute limit')
	expect((error as Error).message).toContain('the credential stamp scan')
	expect((error as Error).cause).toBe(cpuReset)

	// Checks report the limit as a failed check, like packageCheck.
	await expect(
		runner.run({
			op: 'checks',
			stagingKey: 'repo-checks-staging:v1:user-1:key',
			userId,
			input: {
				mode: 'authoring',
				manifestPath: 'package.json',
				sourceRoot: '/',
				baseUrl: 'https://kody.test',
			},
		}),
	).resolves.toMatchObject({
		ok: false,
		manifest: null,
		results: [
			expect.objectContaining({
				kind: 'credentials',
				ok: false,
				message: expect.stringContaining('ran out of memory or CPU time'),
			}),
		],
	})

	// Deploy resets keep propagating so idempotent callers retry.
	const deployReset = new Error(
		'Durable Object reset because its code was updated.',
	)
	const deployFake = createFakeNamespace(async () => {
		throw deployReset
	})
	await expect(
		createIsolatedPublishWorkRunner({
			REPO_SESSION: deployFake.namespace,
			BUNDLE_ARTIFACTS_KV: createFakeKv(),
		} as unknown as Env)!.run({
			op: 'notices',
			stagingKey: 'repo-checks-staging:v1:user-1:key',
			userId,
			input: { source, nextCommit: 'commit-2', baseUrl: 'https://kody.test' },
		}),
	).rejects.toBe(deployReset)
})
