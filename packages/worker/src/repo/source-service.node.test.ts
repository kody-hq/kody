import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as CloudflareWorkers from 'cloudflare:workers'
import type * as PushSubscriptions from './artifacts-push-subscriptions.ts'

const mocks = vi.hoisted(() => ({
	waitUntil: vi.fn<typeof CloudflareWorkers.waitUntil>((promise) => {
		void promise
	}),
	ensureArtifactsRepoPushSubscription: vi.fn<
		typeof PushSubscriptions.ensureArtifactsRepoPushSubscription
	>(async () => ({
		subscriptionId: null,
		skipped: true,
	})),
}))

vi.mock('cloudflare:workers', async (importOriginal) => {
	const actual = await importOriginal<typeof CloudflareWorkers>()
	return {
		...actual,
		waitUntil: (...args: Parameters<typeof CloudflareWorkers.waitUntil>) =>
			mocks.waitUntil(...args),
	}
})

vi.mock('./artifacts-push-subscriptions.ts', () => ({
	ensureArtifactsRepoPushSubscription: (
		...args: Parameters<
			typeof PushSubscriptions.ensureArtifactsRepoPushSubscription
		>
	) => mocks.ensureArtifactsRepoPushSubscription(...args),
}))

const { ensureEntitySource } = await import('./source-service.ts')

function createEntitySourceRow() {
	return {
		id: 'source-1',
		user_id: ownerIdFromStored('user-1'),
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'package-package-1',
		published_commit: 'abc123',
		serving_commit: null,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
	}
}

function makeDb(existing: ReturnType<typeof createEntitySourceRow> | null) {
	const runs: Array<string> = []
	const db = {
		prepare(query: string) {
			return {
				bind() {
					return {
						async first() {
							return query.includes('FROM entity_sources') ? existing : null
						},
						async run() {
							runs.push(query)
							return { meta: { changes: 1 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database
	return { db, runs }
}

function artifactsEnv(db: D1Database) {
	return {
		APP_DB: db,
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token-123',
		CLOUDFLARE_API_BASE_URL: 'https://api.example.com',
	} as Env
}

function jsonResponse(status: number, body: Record<string, unknown>) {
	return new Response(JSON.stringify({ errors: [], messages: [], ...body }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

function mockArtifactsFetch(repoName: string, missingFirst: boolean) {
	let getRepoCount = 0
	const remote = `https://acct.artifacts.cloudflare.net/git/default/${repoName}.git`
	const fetchMock = vi.spyOn(globalThis, 'fetch')
	fetchMock.mockClear()
	fetchMock.mockImplementation(async (input, init) => {
		const url = new URL(String(input))
		const method = init?.method ?? 'GET'
		if (method === 'GET' && url.pathname.endsWith(`/repos/${repoName}`)) {
			getRepoCount += 1
			if (missingFirst && getRepoCount === 1) {
				return jsonResponse(404, {
					success: false,
					result: null,
					errors: [{ code: 1000, message: 'Repo not found' }],
				})
			}
			return jsonResponse(200, {
				success: true,
				result: {
					id: 'repo-1',
					name: repoName,
					description: null,
					default_branch: 'main',
					created_at: '2026-04-18T00:00:00.000Z',
					updated_at: '2026-04-18T00:00:00.000Z',
					last_push_at: null,
					source: null,
					read_only: false,
					remote,
				},
			})
		}
		if (method === 'POST' && url.pathname.endsWith('/repos')) {
			return jsonResponse(200, {
				success: true,
				result: {
					id: 'repo-1',
					name: repoName,
					description: null,
					default_branch: 'main',
					remote,
					token: 'art_v1_create?expires=1760000000',
				},
			})
		}
		throw new Error(`Unexpected fetch: ${method} ${url.pathname}`)
	})
	return fetchMock
}

function createdAccess(repoName: string) {
	return {
		defaultBranch: 'main',
		remote: `https://acct.artifacts.cloudflare.net/git/default/${repoName}.git`,
		token: 'art_v1_create?expires=1760000000',
		expiresAt: '2025-10-09T08:53:20.000Z',
	}
}

test('ensureEntitySource workflow: fail-closed, bootstrap, recreate missing repo, reuse ready repo', async () => {
	const empty = makeDb(null)
	await expect(
		ensureEntitySource({
			db: empty.db,
			env: { APP_DB: empty.db } as Env,
			userId: ownerIdFromStored('user-1'),
			entityKind: 'package',
			entityId: 'pkg-new',
			sourceRoot: '/',
			requirePersistence: true,
		}),
	).rejects.toThrow(
		'Repo-backed source persistence requires ARTIFACTS binding or CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.',
	)
	expect(empty.runs).toEqual([])

	const newPackage = makeDb(null)
	const newPackageFetch = mockArtifactsFetch('package-pkg-new', true)
	const serverTiming: Array<{ name: string; durationMs: number }> = []
	const newSource = await ensureEntitySource({
		db: newPackage.db,
		env: artifactsEnv(newPackage.db),
		userId: ownerIdFromStored('user-1'),
		entityKind: 'package',
		entityId: 'pkg-new',
		sourceRoot: '/',
		serverTiming,
	})
	expect(newPackageFetch).toHaveBeenCalledTimes(2)
	expect(newPackage.runs).toEqual([
		expect.stringContaining('INSERT INTO entity_sources'),
	])
	expect(newSource.repo_id).toBe('package-pkg-new')
	expect(newSource.manifest_path).toBe('package.json')
	expect(newSource.bootstrapAccess).toEqual(createdAccess('package-pkg-new'))
	expect(serverTiming.map((entry) => entry.name)).toEqual([
		'artifacts-repo-ready',
		'entity-source-insert',
	])
	expect(mocks.waitUntil).toHaveBeenCalledTimes(0)

	const existingRow = createEntitySourceRow()
	const recreate = makeDb(existingRow)
	const recreateFetch = mockArtifactsFetch('package-package-1', true)
	const packageInput = {
		userId: ownerIdFromStored('user-1'),
		entityKind: 'package',
		entityId: 'package-1',
		sourceRoot: '/',
	} as const
	const recreatedSource = await ensureEntitySource({
		db: recreate.db,
		env: artifactsEnv(recreate.db),
		...packageInput,
	})
	expect(recreateFetch).toHaveBeenCalledTimes(2)
	expect(recreate.runs).toHaveLength(1)
	expect(recreatedSource).toMatchObject({
		...existingRow,
		published_commit: null,
		indexed_commit: null,
	})
	expect(recreatedSource.bootstrapAccess).toEqual(
		createdAccess('package-package-1'),
	)

	const reuse = makeDb(existingRow)
	const reuseFetch = mockArtifactsFetch('package-package-1', false)
	const reusedSource = await ensureEntitySource({
		db: reuse.db,
		env: artifactsEnv(reuse.db),
		...packageInput,
	})
	expect(reuseFetch).toHaveBeenCalledTimes(1)
	expect(reuse.runs).toEqual([])
	expect(reusedSource).toEqual(existingRow)
	expect(reusedSource.bootstrapAccess).toBeUndefined()
	expect(mocks.waitUntil).toHaveBeenCalledTimes(0)
})
