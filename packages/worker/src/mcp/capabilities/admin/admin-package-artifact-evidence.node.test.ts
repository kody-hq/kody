import { createD1JobsStore } from '@kody-internal/shared/jobs/store.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { persistPublishedBundleArtifact } from '#worker/package-runtime/published-bundle-artifact-persist.ts'
import {
	buildPackageAppClientPointerKvKey,
	buildPublishedBundleArtifactKvKey,
	buildPublishedSourceManifestSnapshotKvKey,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import type { EntitySourceRow } from '#worker/repo/types.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const mocks = vi.hoisted(() => ({
	refreshSavedPackageProjection: vi.fn(),
	rebuild: vi.fn(() => {
		throw new Error('rebuild must not run')
	}),
}))

vi.mock('#worker/package-registry/service.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	refreshSavedPackageProjection: mocks.refreshSavedPackageProjection,
}))

vi.mock(
	'#worker/mcp/capabilities/repo/package-artifact-rebuild.ts',
	async (importOriginal) => {
		const actual = await importOriginal<Record<string, unknown>>()
		return Object.fromEntries(
			Object.entries(actual).map(([name, value]) => [
				name,
				typeof value === 'function' ? mocks.rebuild : value,
			]),
		)
	},
)

// Assert real `audit_events` rows written through the actual audit pipeline.
vi.unmock('#worker/audit-log.ts')
import { settleFailedPublishRebuild } from '#worker/mcp/capabilities/repo/settle-failed-publish-rebuild.ts'
import { adminPackageArtifactEvidenceCapability } from './admin-package-artifact-evidence.ts'
import { adminPackageJobAttributionRepairCapability } from './admin-package-job-attribution-repair.ts'

const secretMarker = 'S3CRET-MARKER'
const now = '2026-11-01T00:00:00.000Z'
const ownerId = testStableUserIdFromEmail('bob@example.com')
const packageId = 'pkg-bob-factory'
const sourceId = 'src-bob-factory'
const oldCommit = 'b'.repeat(40)
const failedCommit = 'f'.repeat(40)
const newerCommit = 'e'.repeat(40)
const roleIds = { user: 1, admin: 2 } as const
const users = [
	{ username: 'admin', roles: ['admin', 'user'] as const },
	{ username: 'jane', roles: ['user'] as const },
	{ username: 'bob', roles: ['user'] as const },
]

const manifestContent = JSON.stringify({
	name: '@bob/factory',
	exports: {
		'.': './src/index.ts',
		'./readiness': './src/readiness.ts',
	},
	kody: {
		id: 'factory',
		description: 'Synthetic fixture',
		app: { entry: './src/app.ts', client: './src/client.ts' },
		jobs: {
			'reconcile-active': {
				entry: './src/jobs/reconcile.ts',
				schedule: { type: 'interval', every: '1h' },
			},
			'project-a-periodic': {
				entry: './src/jobs/periodic.ts',
				schedule: { type: 'interval', every: '1h' },
			},
		},
	},
})

function createTest() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	applyAllMigrations(
		sqlite,
		new URL('../../../../../jobs-worker/migrations/', import.meta.url),
	)
	const auditSqlite = new DatabaseSync(':memory:')
	auditSqlite.exec(
		readFileSync(
			new URL(
				'../../../../audit-migrations/0001-audit-events.sql',
				import.meta.url,
			),
			'utf8',
		),
	)
	users.forEach((user, index) => {
		const email = `${user.username}@example.com`
		const stableUserId = testStableUserIdFromEmail(email)
		sqlite
			.prepare(
				`INSERT INTO users (id, username, email, password_hash, stable_user_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'hash', ?, ?, ?)`,
			)
			.run(index + 1, user.username, email, stableUserId, now, now)
		sqlite
			.prepare(
				`INSERT INTO orgs (id, slug, plan, created_at, updated_at) VALUES (?, ?, 'free', ?, ?)`,
			)
			.run(stableUserId, user.username, now, now)
		sqlite
			.prepare(
				`INSERT INTO handles (handle, user_id, org_id, created_at) VALUES (?, ?, ?, ?)`,
			)
			.run(user.username, stableUserId, stableUserId, now)
		for (const role of user.roles) {
			sqlite
				.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)`)
				.run(index + 1, roleIds[role])
		}
	})
	sqlite
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
			 VALUES (?, ?, '@bob/factory', 'factory', '', ?)`,
		)
		.run(packageId, ownerId, sourceId)
	sqlite
		.prepare(
			`INSERT INTO entity_sources (id, user_id, entity_kind, entity_id, repo_id, published_commit, serving_commit, created_at, updated_at)
			 VALUES (?, ?, 'package', ?, 'repo-bob-factory', ?, ?, ?, ?)`,
		)
		.run(sourceId, ownerId, packageId, oldCommit, oldCommit, now, now)
	const insertJob = (input: {
		id: string
		name: string
		enabled: boolean
		source?: string
	}) =>
		sqlite
			.prepare(
				`INSERT INTO jobs (id, user_id, name, source_id, published_commit, storage_id, params_json, schedule_json, timezone, enabled, caller_context_json, created_at, updated_at, last_run_at, last_run_status, next_run_at, disabled_reason)
				 VALUES (?, ?, ?, ?, ?, 'storage-1', ?, '{"type":"interval","every":"1h"}', 'UTC', ?, ?, ?, ?, '2026-10-31T00:00:00.000Z', 'success', '2026-11-02T00:00:00.000Z', ?)`,
			)
			.run(
				input.id,
				ownerId,
				input.name,
				input.source ?? sourceId,
				oldCommit,
				JSON.stringify({ apiKey: secretMarker }),
				input.enabled ? 1 : 0,
				JSON.stringify({ token: secretMarker }),
				now,
				now,
				input.enabled ? null : 'turned off by owner',
			)
	insertJob({ id: 'job-reconcile', name: 'reconcile-active', enabled: true })
	insertJob({ id: 'job-periodic', name: 'project-a-periodic', enabled: false })
	// Package job no longer declared by the serving manifest.
	insertJob({ id: 'job-legacy', name: 'legacy-sweep', enabled: true })
	insertJob({
		id: 'job-other-source',
		name: 'other',
		enabled: true,
		source: 'src-other',
	})
	const kvStore = new Map<string, string>()
	const manifestSnapshotKey = buildPublishedSourceManifestSnapshotKvKey({
		sourceId,
		publishedCommit: oldCommit,
	})
	kvStore.set(
		manifestSnapshotKey,
		JSON.stringify({
			version: 1,
			sourceId,
			publishedCommit: oldCommit,
			manifestPath: 'package.json',
			manifestContent,
			createdAt: now,
		}),
	)
	const kvPut = vi.fn()
	const kv = {
		async get(key: string, type?: 'text' | 'json') {
			const value = kvStore.get(key)
			if (value === undefined) return null
			return type === 'json' ? JSON.parse(value) : value
		},
		async put(key: string, value: string | ArrayBuffer | ArrayBufferView) {
			kvPut(key)
			kvStore.set(
				key,
				typeof value === 'string'
					? value
					: Buffer.from(
							value instanceof ArrayBuffer
								? new Uint8Array(value)
								: new Uint8Array(
										value.buffer,
										value.byteOffset,
										value.byteLength,
									),
						).toString('utf8'),
			)
		},
		async delete(key: string) {
			kvStore.delete(key)
		},
	} as unknown as KVNamespace
	const loader = { get: vi.fn(), load: vi.fn() }
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		AUDIT_DB: createD1FromSqlite(auditSqlite),
		BUNDLE_ARTIFACTS_KV: kv,
		LOADER: loader,
	} as unknown as Env
	const contextFor = (username: string, roles: Array<string>) => ({
		env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			user: {
				userId: personIdFromStored(
					testStableUserIdFromEmail(`${username}@example.com`),
				),
				email: `${username}@example.com`,
				displayName: username,
				roles,
			},
		}),
	})
	const sourceAt = (commit: string): EntitySourceRow =>
		({
			id: sourceId,
			user_id: ownerId,
			entity_kind: 'package',
			entity_id: packageId,
			repo_id: 'repo-bob-factory',
			published_commit: commit,
			serving_commit: commit,
			indexed_commit: null,
			manifest_path: 'package.json',
			source_root: '/',
			last_external_check_at: null,
			external_check_until: null,
			created_at: now,
			updated_at: now,
		}) as EntitySourceRow
	const writeArtifact = (input: {
		commit: string
		kind: 'module' | 'importable-module' | 'app' | 'job'
		artifactName?: string | null
		entryPoint: string
		code: string
	}) =>
		persistPublishedBundleArtifact({
			env,
			userId: ownerId,
			source: sourceAt(input.commit),
			kind: input.kind,
			artifactName: input.artifactName ?? null,
			entryPoint: input.entryPoint,
			mainModule: 'index.js',
			modules: {
				'index.js': input.code,
				'chunk.js': { js: `export const chunk = '${input.commit}'` },
			},
			dependencies: [],
		})
	const jobRow = (id: string) =>
		sqlite.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as Record<
			string,
			unknown
		>
	return {
		sqlite,
		env,
		kv,
		kvPut,
		manifestSnapshotKey,
		loader,
		writeArtifact,
		jobRow,
		setSource: (published: string, serving: string | null) =>
			sqlite
				.prepare(
					`UPDATE entity_sources SET published_commit = ?, serving_commit = ? WHERE id = ?`,
				)
				.run(published, serving, sourceId),
		setJobPins: (commit: string) =>
			sqlite
				.prepare(`UPDATE jobs SET published_commit = ? WHERE source_id = ?`)
				.run(commit, sourceId),
		admin: contextFor('admin', ['admin', 'user']),
		jane: contextFor('jane', ['user']),
		bob: contextFor('bob', ['user']),
		auditEvents: () =>
			auditSqlite
				.prepare(
					'SELECT category, action, result, reason FROM audit_events ORDER BY id',
				)
				.all() as Array<Record<string, string | null>>,
	}
}

type TestFixture = ReturnType<typeof createTest>

/** Old good publish: every declared target except the app client. */
async function seedOldPublish(t: TestFixture) {
	for (const [name, entryPoint] of [
		[null, 'src/index.ts'],
		['./readiness', 'src/readiness.ts'],
	] as const) {
		for (const kind of ['module', 'importable-module'] as const) {
			await t.writeArtifact({
				commit: oldCommit,
				kind,
				artifactName: name === null ? '.' : name,
				entryPoint,
				code: `export default () => '${kind}:${name}:old:${secretMarker}'`,
			})
		}
	}
	await t.writeArtifact({
		commit: oldCommit,
		kind: 'app',
		entryPoint: 'src/app.ts',
		code: `export default { fetch() {} } // ${secretMarker}`,
	})
	for (const [jobName, entryPoint] of [
		['reconcile-active', 'src/jobs/reconcile.ts'],
		['project-a-periodic', 'src/jobs/periodic.ts'],
	] as const) {
		await t.writeArtifact({
			commit: oldCommit,
			kind: 'job',
			artifactName: jobName,
			entryPoint,
			code: `export default () => '${jobName}'`,
		})
	}
}

/**
 * A failed publish as RepoSession leaves it: pointer and job pins promoted to
 * the failed commit, then the rebuild wrote several module artifacts (rows
 * now name the failed commit) before it failed.
 */
async function simulateFailedPublish(t: TestFixture) {
	t.setSource(failedCommit, oldCommit)
	t.setJobPins(failedCommit)
	for (const kind of ['module', 'importable-module'] as const) {
		await t.writeArtifact({
			commit: failedCommit,
			kind,
			artifactName: '.',
			entryPoint: 'src/index.ts',
			code: `export default () => 'failed ${kind}'`,
		})
	}
	await t.writeArtifact({
		commit: failedCommit,
		kind: 'module',
		artifactName: './readiness',
		entryPoint: 'src/readiness.ts',
		code: `export default () => 'failed readiness'`,
	})
}

async function evidence(t: TestFixture, args: { limit?: number } = {}) {
	const targets = []
	let cursor: string | undefined
	for (;;) {
		const page = await adminPackageArtifactEvidenceCapability.handler(
			{ packageId, limit: args.limit ?? 20, cursor },
			t.admin,
		)
		targets.push(...page.targets)
		if (!page.page.nextCursor) return { last: page, targets }
		cursor = page.page.nextCursor
	}
}

function selectedHashes(
	targets: Awaited<ReturnType<typeof evidence>>['targets'],
) {
	return Object.fromEntries(
		targets.map((target) => [target.key, target.selected?.bundleSha256]),
	)
}

/** Mirrors the job-pin write of `syncPackageJobsForPackage`: pins follow the source pointer, enabled is untouched. */
function projectionRefreshThatSyncsJobPins(env: Env) {
	return async (input: { sourceId: string; userId: string }) => {
		const source = await env.APP_DB.prepare(
			`SELECT published_commit FROM entity_sources WHERE id = ?`,
		)
			.bind(input.sourceId)
			.first<{ published_commit: string }>()
		const store = jobsData(env)
		for (const { record } of await store.listJobsForUser({
			userId: input.userId,
		})) {
			if (record.sourceId !== input.sourceId) continue
			await store.refreshPackageJobIdentity({
				userId: input.userId,
				jobId: record.id,
				sourceId: record.sourceId,
				publishedCommit: source?.published_commit ?? null,
				callerContextJson: '{}',
				updatedAt: new Date().toISOString(),
			})
		}
	}
}

beforeEach(() => {
	mocks.refreshSavedPackageProjection.mockReset()
	mocks.rebuild.mockClear()
})

test('evidence reports every declared target with the serving bytes runtime selects, never bytes or secrets', async () => {
	const t = createTest()
	await seedOldPublish(t)
	const before = await evidence(t)
	await simulateFailedPublish(t)
	// Settled: the pointer is back on the old commit; rows still name the
	// failed commit (identity rows track the newest saved build).
	t.setSource(oldCommit, oldCommit)
	const putsBefore = t.kvPut.mock.calls.length
	const artifactRowsBefore = t.sqlite
		.prepare(`SELECT * FROM published_bundle_artifacts ORDER BY id`)
		.all()
	const { last, targets } = await evidence(t, { limit: 3 })

	expect(last.page.total).toBe(9)
	expect(targets.map((target) => target.key)).toEqual([
		'app||src/app.ts',
		'app-client||src/client.ts',
		'module|.|src/index.ts',
		'importable-module|.|src/index.ts',
		'module|./readiness|src/readiness.ts',
		'importable-module|./readiness|src/readiness.ts',
		'job|reconcile-active|src/jobs/reconcile.ts',
		'job|project-a-periodic|src/jobs/periodic.ts',
		'job|legacy-sweep|',
	])
	expect(targets).toHaveLength(9)
	expect(new Set(targets.map((target) => target.key)).size).toBe(9)

	const byKey = Object.fromEntries(
		targets.map((target) => [target.key, target]),
	)
	const mainModule = byKey['module|.|src/index.ts']!
	expect(mainModule).toMatchObject({
		declared: true,
		selector: 'serving_commit',
		identityRow: { builtFromCommit: failedCommit, builtFromCommitValid: true },
		selected: {
			commit: oldCommit,
			kvKey: buildPublishedBundleArtifactKvKey({
				sourceId,
				publishedCommit: oldCommit,
				kind: 'module',
				artifactName: '.',
				entryPoint: 'src/index.ts',
			}),
			kvKeyDerived: true,
			status: 'valid',
			embeddedCommit: oldCommit,
			embeddedCommitMatches: true,
			mainModule: 'index.js',
			moduleCount: 2,
		},
		runtimeLoads: true,
		newestRow: { commit: failedCommit, status: 'valid' },
		selectedMatchesNewestRowBytes: false,
	})
	expect(mainModule.selected?.modules.map((module) => module.path)).toEqual([
		'chunk.js',
		'index.js',
	])
	// Old serving bytes are still the ones selected, hash for hash.
	expect(selectedHashes(targets)).toMatchObject(
		Object.fromEntries(Object.entries(selectedHashes(before.targets))),
	)
	expect(byKey['importable-module|.|src/index.ts']).toMatchObject({
		selector: 'serving_artifact_commit',
		selected: { commit: oldCommit, status: 'valid' },
		newestRow: { commit: failedCommit },
	})
	// The app serves its publish-time template, read before the row path.
	const app = byKey['app||src/app.ts']!
	expect(app).toMatchObject({
		servedFrom: 'template',
		runtimeLoads: true,
		template: { commit: oldCommit, status: 'valid' },
		selected: { commit: oldCommit, status: 'valid' },
		clientPointer: null,
	})
	expect(app.template?.bundleSha256).toBe(app.selected?.bundleSha256)
	expect(mainModule).toMatchObject({
		servedFrom: 'identity_row',
		template: null,
		clientPointer: null,
	})
	// Declared but never built: reported, not dropped.
	expect(byKey['app-client||src/client.ts']).toMatchObject({
		declared: true,
		identityRow: null,
		selected: { commit: oldCommit, status: 'missing', bundleSha256: null },
		servedFrom: 'none',
		runtimeLoads: false,
		template: null,
		clientPointer: { status: 'missing', mainModule: null },
	})
	expect(byKey['job|legacy-sweep|']).toMatchObject({
		declared: false,
		entryPoint: null,
		identityRow: null,
		selected: null,
		runtimeLoads: false,
		jobs: [
			{ jobId: 'job-legacy', enabled: true, recordedCommit: failedCommit },
		],
	})
	expect(byKey['job|project-a-periodic|src/jobs/periodic.ts']).toMatchObject({
		identityRow: { builtFromCommit: oldCommit },
		newestRow: null,
		jobs: [
			{ jobId: 'job-periodic', enabled: false, recordedCommit: failedCommit },
		],
	})

	// Read-only: no KV writes, no row changes, no rebuild, no code loaded.
	expect(t.kvPut.mock.calls.length).toBe(putsBefore)
	expect(
		t.sqlite
			.prepare(`SELECT * FROM published_bundle_artifacts ORDER BY id`)
			.all(),
	).toEqual(artifactRowsBefore)
	expect(mocks.rebuild).not.toHaveBeenCalled()
	expect(mocks.refreshSavedPackageProjection).not.toHaveBeenCalled()
	expect(t.loader.get).not.toHaveBeenCalled()
	expect(t.loader.load).not.toHaveBeenCalled()

	const serialized = JSON.stringify(targets)
	expect(serialized).not.toContain(secretMarker)
	expect(serialized).not.toContain('export default')
	expect(serialized).not.toContain('apiKey')
	const events = t
		.auditEvents()
		.filter((event) => event.action === 'adminPackageArtifactEvidence')
	expect(events.length).toBeGreaterThan(0)
	for (const event of events) {
		expect(event).toMatchObject({ category: 'admin', result: 'success' })
		expect(JSON.stringify(event)).not.toContain(secretMarker)
		expect(event.reason).toMatch(
			/^package_id=pkg-bob-factory owner_id=\S+ offset=\d+ returned=\d+ total=9$/,
		)
	}
})

test('evidence reports missing, malformed, and mismatched payloads explicitly', async () => {
	const t = createTest()
	await seedOldPublish(t)
	const key = (
		kind: 'module' | 'importable-module' | 'job',
		name: string,
		entryPoint: string,
	) =>
		buildPublishedBundleArtifactKvKey({
			sourceId,
			publishedCommit: oldCommit,
			kind,
			artifactName: name,
			entryPoint,
		})
	await t.kv.put(
		key('module', './readiness', 'src/readiness.ts'),
		`{not json ${secretMarker}`,
	)
	const stolen = JSON.parse(
		(await t.kv.get(key('module', '.', 'src/index.ts'), 'text')) as string,
	) as Record<string, unknown>
	await t.kv.put(
		key('importable-module', './readiness', 'src/readiness.ts'),
		JSON.stringify({ ...stolen, sourceId: 'src-someone-else' }),
	)
	await t.kv.put(
		key('job', 'reconcile-active', 'src/jobs/reconcile.ts'),
		JSON.stringify({ ...stolen, version: 999 }),
	)
	await t.kv.delete(key('job', 'project-a-periodic', 'src/jobs/periodic.ts'))
	const { targets } = await evidence(t)
	const byKey = Object.fromEntries(
		targets.map((target) => [target.key, target]),
	)
	expect(byKey['module|./readiness|src/readiness.ts']?.selected).toMatchObject({
		status: 'malformed',
		malformedReason: 'invalid_json',
		bundleSha256: null,
	})
	expect(byKey['importable-module|./readiness|src/readiness.ts']).toMatchObject(
		{
			selected: {
				status: 'identity_mismatch',
				identityMismatchFields: expect.arrayContaining([
					'sourceId',
					'kind',
					'artifactName',
					'entryPoint',
				]),
			},
			runtimeLoads: false,
		},
	)
	expect(
		byKey['job|reconcile-active|src/jobs/reconcile.ts']?.selected,
	).toMatchObject({
		status: 'malformed',
		malformedReason: 'unsupported_version',
	})
	expect(byKey['job|project-a-periodic|src/jobs/periodic.ts']).toMatchObject({
		identityRow: { builtFromCommit: oldCommit },
		selected: { status: 'missing' },
		runtimeLoads: false,
	})
	expect(JSON.stringify(targets)).not.toContain(secretMarker)

	// One KV read failing reports that target, not an aborted page.
	const realGet = t.kv.get.bind(t.kv)
	const brokenKey = key('module', '.', 'src/index.ts')
	const mutableKv = t.kv as unknown as { get: typeof realGet }
	mutableKv.get = (async (k: string, type?: 'text' | 'json') => {
		if (k === brokenKey) throw new Error(`kv down ${secretMarker}`)
		return realGet(k, type as 'text')
	}) as typeof realGet
	const outage = await evidence(t)
	mutableKv.get = realGet
	const outageByKey = Object.fromEntries(
		outage.targets.map((target) => [target.key, target]),
	)
	expect(outageByKey['module|.|src/index.ts']).toMatchObject({
		selected: { status: 'kv_unavailable', bundleSha256: null },
		runtimeLoads: false,
	})
	expect(outageByKey['importable-module|.|src/index.ts']).toMatchObject({
		selected: { status: 'valid' },
	})
	expect(JSON.stringify(outage.targets)).not.toContain(secretMarker)

	// Manifest snapshot missing: never recovered or written on read, and
	// identity rows and jobs are still reported.
	await t.kv.delete(t.manifestSnapshotKey)
	const putsBeforeDegraded = t.kvPut.mock.calls.length
	const degraded = await adminPackageArtifactEvidenceCapability.handler(
		{ packageId, limit: 20 },
		t.admin,
	)
	expect(t.kvPut.mock.calls.length).toBe(putsBeforeDegraded)
	expect(degraded.manifest).toEqual({
		status: 'snapshot_missing',
		commit: oldCommit,
	})
	// Rows and jobs only: the never-built app client is unknowable here.
	expect(degraded.page.total).toBe(8)
	expect(degraded.targets.every((target) => !target.declared)).toBe(true)
	expect(JSON.stringify(degraded)).not.toContain(secretMarker)

	await t.kv.put(t.manifestSnapshotKey, `{bad ${secretMarker}`)
	const unreadable = await adminPackageArtifactEvidenceCapability.handler(
		{ packageId, limit: 20 },
		t.admin,
	)
	expect(unreadable.manifest).toEqual({ status: 'unavailable', commit: null })
	expect(unreadable.page.total).toBe(8)
})

test('evidence reports the app template runtime serves even without an identity row', async () => {
	const t = createTest()
	await seedOldPublish(t)
	t.sqlite
		.prepare(
			`DELETE FROM published_bundle_artifacts WHERE artifact_kind IN ('app', 'app-client')`,
		)
		.run()
	const first = await evidence(t)
	const firstByKey = Object.fromEntries(
		first.targets.map((target) => [target.key, target]),
	)
	expect(firstByKey['app||src/app.ts']).toMatchObject({
		declared: true,
		identityRow: null,
		servedFrom: 'template',
		runtimeLoads: true,
		template: { commit: oldCommit, status: 'valid' },
	})
	expect(firstByKey['app-client||src/client.ts']).toMatchObject({
		servedFrom: 'none',
		clientPointer: { status: 'missing' },
	})

	// An unreadable client pointer makes the runtime template read fail, so
	// runtime falls back to the (missing) identity row: nothing is served.
	await t.kv.put(
		buildPackageAppClientPointerKvKey({ sourceId, publishedCommit: oldCommit }),
		`{bad ${secretMarker}`,
	)
	const { targets } = await evidence(t)
	const byKey = Object.fromEntries(
		targets.map((target) => [target.key, target]),
	)
	expect(byKey['app||src/app.ts']).toMatchObject({
		servedFrom: 'none',
		runtimeLoads: false,
		template: { status: 'valid' },
	})
	expect(byKey['app-client||src/client.ts']).toMatchObject({
		servedFrom: 'none',
		clientPointer: { status: 'malformed', mainModule: null },
	})
	expect(JSON.stringify(targets)).not.toContain(secretMarker)
	expect(t.loader.get).not.toHaveBeenCalled()
	expect(t.loader.load).not.toHaveBeenCalled()
	expect(mocks.rebuild).not.toHaveBeenCalled()
})

test('evidence cursors refuse a page after the package state changed', async () => {
	const t = createTest()
	await seedOldPublish(t)
	const first = await adminPackageArtifactEvidenceCapability.handler(
		{ packageId, limit: 2 },
		t.admin,
	)
	expect(first.page).toMatchObject({ total: 9, returned: 2, offset: 0 })
	t.setJobPins(failedCommit)
	await expect(
		adminPackageArtifactEvidenceCapability.handler(
			{ packageId, limit: 2, cursor: first.page.nextCursor! },
			t.admin,
		),
	).rejects.toThrow(/cursor_state_changed/)
	const second = await adminPackageArtifactEvidenceCapability.handler(
		{ packageId, limit: 2 },
		t.admin,
	)
	t.setSource(newerCommit, oldCommit)
	await expect(
		adminPackageArtifactEvidenceCapability.handler(
			{ packageId, limit: 2, cursor: second.page.nextCursor! },
			t.admin,
		),
	).rejects.toThrow(/cursor_state_changed/)
	await expect(
		adminPackageArtifactEvidenceCapability.handler(
			{ packageId, cursor: 'bogus' },
			t.admin,
		),
	).rejects.toThrow(/invalid_cursor/)
})

test('job attribution repair dry-runs by default, applies only the pin, and is retry safe', async () => {
	const t = createTest()
	t.setJobPins(failedCommit)
	const before = t.jobRow('job-periodic')
	const args = {
		packageId,
		jobId: 'job-periodic',
		expectedRecordedCommit: failedCommit,
		expectedServingCommit: oldCommit,
	}
	const dryRun = await adminPackageJobAttributionRepairCapability.handler(
		args,
		t.admin,
	)
	expect(dryRun).toMatchObject({
		mode: 'dry_run',
		outcome: 'would_update',
		refusalReasons: [],
		diff: { field: 'jobs.published_commit', from: failedCommit, to: oldCommit },
		job: {
			jobId: 'job-periodic',
			enabled: false,
			recordedCommit: failedCommit,
		},
	})
	expect(t.jobRow('job-periodic')).toEqual(before)

	const applied = await adminPackageJobAttributionRepairCapability.handler(
		{ ...args, apply: true },
		t.admin,
	)
	expect(applied).toMatchObject({
		mode: 'apply',
		outcome: 'updated',
		diff: { from: failedCommit, to: oldCommit },
		job: { enabled: false, recordedCommit: oldCommit },
		compensated: false,
	})
	const after = t.jobRow('job-periodic')
	const { published_commit, updated_at, ...rest } = after
	const { published_commit: _p, updated_at: _u, ...restBefore } = before
	expect(published_commit).toBe(oldCommit)
	// Enabled, schedule, params, caller context, last/next run untouched.
	expect(rest).toEqual(restBefore)
	expect(rest.enabled).toBe(0)
	expect(t.jobRow('job-reconcile').published_commit).toBe(failedCommit)

	const retried = await adminPackageJobAttributionRepairCapability.handler(
		{ ...args, apply: true },
		t.admin,
	)
	expect(retried).toMatchObject({ outcome: 'already_current', diff: null })
	expect(t.jobRow('job-periodic')).toEqual(after)
	expect(mocks.rebuild).not.toHaveBeenCalled()
	expect(mocks.refreshSavedPackageProjection).not.toHaveBeenCalled()
	expect(t.loader.get).not.toHaveBeenCalled()

	const serialized = JSON.stringify([dryRun, applied, retried])
	expect(serialized).not.toContain(secretMarker)
	const events = t
		.auditEvents()
		.filter((event) => event.action === 'adminPackageJobAttributionRepair')
	expect(events.map((event) => event.reason)).toEqual([
		expect.stringContaining('mode=dry_run outcome=would_update'),
		expect.stringContaining('mode=apply outcome=updated'),
		expect.stringContaining('mode=apply outcome=already_current'),
	])
	expect(JSON.stringify(events)).not.toContain(secretMarker)
})

test('job attribution repair refuses mismatched, newer, or in-flight state without writing', async () => {
	const t = createTest()
	t.setJobPins(failedCommit)
	const snapshot = () =>
		t.sqlite.prepare(`SELECT * FROM jobs ORDER BY id`).all()
	const before = snapshot()
	const apply = (overrides: Record<string, unknown>) =>
		adminPackageJobAttributionRepairCapability.handler(
			{
				packageId,
				jobId: 'job-reconcile',
				expectedRecordedCommit: failedCommit,
				expectedServingCommit: oldCommit,
				apply: true,
				...overrides,
			},
			t.admin,
		)
	expect(await apply({ expectedRecordedCommit: newerCommit })).toMatchObject({
		outcome: 'refused',
		refusalReasons: ['recorded_commit_mismatch'],
	})
	expect(await apply({ expectedServingCommit: newerCommit })).toMatchObject({
		outcome: 'refused',
		refusalReasons: ['serving_commit_mismatch'],
	})
	expect(await apply({ jobId: 'job-other-source' })).toMatchObject({
		outcome: 'refused',
		refusalReasons: expect.arrayContaining(['job_not_in_package']),
	})
	expect(await apply({ jobId: 'job-missing' })).toMatchObject({
		outcome: 'refused',
		refusalReasons: ['job_not_found'],
	})
	t.setSource(newerCommit, oldCommit)
	expect(await apply({})).toMatchObject({
		outcome: 'refused',
		refusalReasons: ['publish_in_progress'],
	})
	t.setSource(newerCommit, newerCommit)
	expect(await apply({})).toMatchObject({
		outcome: 'refused',
		refusalReasons: ['serving_commit_mismatch'],
	})
	expect(snapshot()).toEqual(before)
})

test('job attribution repair guards CAS mismatch and pointer races at write time', async () => {
	const t = createTest()
	t.setJobPins(failedCommit)
	const d1Store = createD1JobsStore(t.env.APP_DB)
	let race: (() => void) | null = null
	;(t.env as unknown as { JOBS: unknown }).JOBS = {
		...d1Store,
		async repairPackageJobPublishedCommit(
			input: Parameters<typeof d1Store.repairPackageJobPublishedCommit>[0],
		) {
			const pending = race
			race = null
			pending?.()
			return d1Store.repairPackageJobPublishedCommit(input)
		},
	}
	const apply = () =>
		adminPackageJobAttributionRepairCapability.handler(
			{
				packageId,
				jobId: 'job-reconcile',
				expectedRecordedCommit: failedCommit,
				expectedServingCommit: oldCommit,
				apply: true,
			},
			t.admin,
		)
	// A concurrent writer changed the pin between the read and the write.
	race = () =>
		t.sqlite
			.prepare(
				`UPDATE jobs SET published_commit = ? WHERE id = 'job-reconcile'`,
			)
			.run(newerCommit)
	expect(await apply()).toMatchObject({
		outcome: 'refused',
		refusalReasons: ['write_conflict', 'recorded_commit_mismatch'],
	})
	expect(t.jobRow('job-reconcile').published_commit).toBe(newerCommit)

	// A newer publish moved the serving pointer while the pin was written.
	t.setJobPins(failedCommit)
	const original = (t.env as unknown as { JOBS: Record<string, unknown> }).JOBS
	;(t.env as unknown as { JOBS: unknown }).JOBS = {
		...original,
		async repairPackageJobPublishedCommit(
			input: Parameters<typeof d1Store.repairPackageJobPublishedCommit>[0],
		) {
			const wrote = await d1Store.repairPackageJobPublishedCommit(input)
			if (input.publishedCommit === oldCommit) {
				t.setSource(newerCommit, newerCommit)
			}
			return wrote
		},
	}
	expect(await apply()).toMatchObject({
		outcome: 'refused',
		refusalReasons: ['source_changed_during_apply'],
		compensated: true,
	})
	expect(t.jobRow('job-reconcile').published_commit).toBe(failedCommit)
	expect(t.jobRow('job-reconcile').enabled).toBe(1)
})

test('admin capabilities reject non-admin callers, including the owner', async () => {
	const t = createTest()
	for (const ctx of [t.jane, t.bob]) {
		await expect(
			adminPackageArtifactEvidenceCapability.handler({ packageId }, ctx),
		).rejects.toThrow('lacks required role "admin"')
		await expect(
			adminPackageJobAttributionRepairCapability.handler(
				{
					packageId,
					jobId: 'job-reconcile',
					expectedRecordedCommit: oldCommit,
					expectedServingCommit: oldCommit,
					apply: true,
				},
				ctx,
			),
		).rejects.toThrow('lacks required role "admin"')
	}
	expect(
		t.auditEvents().some((event) => event.action?.startsWith('adminPackage')),
	).toBe(false)
	expect(mocks.rebuild).not.toHaveBeenCalled()
})

test('failed-publish settlement resumes after a refresh failure and restores old serving bytes and job pins', async () => {
	const t = createTest()
	await seedOldPublish(t)
	const before = await evidence(t)
	await simulateFailedPublish(t)
	const settle = () =>
		settleFailedPublishRebuild({
			env: t.env,
			baseUrl: 'https://example.com',
			ownerUserId: ownerIdFromStored(ownerId),
			packageId,
			sourceId,
			failedCommit,
			restoreCommit: oldCommit,
			sentryScope: 'test',
		})
	mocks.refreshSavedPackageProjection
		.mockRejectedValueOnce(new Error('projection refresh failed'))
		.mockImplementation(projectionRefreshThatSyncsJobPins(t.env))

	await expect(settle()).rejects.toThrow('projection refresh failed')
	// The pointer was restored but job pins were not.
	expect(
		t.sqlite
			.prepare(
				`SELECT published_commit, serving_commit FROM entity_sources WHERE id = ?`,
			)
			.get(sourceId),
	).toEqual({ published_commit: oldCommit, serving_commit: oldCommit })
	expect(t.jobRow('job-reconcile').published_commit).toBe(failedCommit)

	// Retry finishes the repair instead of reporting `superseded`.
	expect(await settle()).toBe('restored')
	expect(mocks.refreshSavedPackageProjection).toHaveBeenCalledTimes(2)
	expect(mocks.refreshSavedPackageProjection).toHaveBeenLastCalledWith(
		expect.objectContaining({ sourceId, rebuildArtifacts: false }),
	)
	expect(t.jobRow('job-reconcile')).toMatchObject({
		published_commit: oldCommit,
		enabled: 1,
	})
	expect(t.jobRow('job-periodic')).toMatchObject({
		published_commit: oldCommit,
		enabled: 0,
	})
	// A further retry stays a safe repeat.
	expect(await settle()).toBe('restored')

	const { targets } = await evidence(t)
	expect(selectedHashes(targets)).toEqual(selectedHashes(before.targets))
	const mainModule = targets.find(
		(target) => target.key === 'module|.|src/index.ts',
	)
	expect(mainModule).toMatchObject({
		identityRow: { builtFromCommit: failedCommit },
		selected: { commit: oldCommit, status: 'valid' },
		selectedMatchesNewestRowBytes: false,
	})
	expect(mocks.rebuild).not.toHaveBeenCalled()
})

test('failed-publish settlement never touches a pointer a newer publish owns', async () => {
	const t = createTest()
	await simulateFailedPublish(t)
	mocks.refreshSavedPackageProjection.mockImplementation(
		projectionRefreshThatSyncsJobPins(t.env),
	)
	t.setSource(newerCommit, oldCommit)
	t.setJobPins(newerCommit)
	expect(
		await settleFailedPublishRebuild({
			env: t.env,
			baseUrl: 'https://example.com',
			ownerUserId: ownerIdFromStored(ownerId),
			packageId,
			sourceId,
			failedCommit,
			restoreCommit: oldCommit,
			sentryScope: 'test',
		}),
	).toBe('superseded')
	expect(mocks.refreshSavedPackageProjection).not.toHaveBeenCalled()
	expect(
		t.sqlite
			.prepare(`SELECT published_commit FROM entity_sources WHERE id = ?`)
			.get(sourceId),
	).toEqual({ published_commit: newerCommit })
	expect(t.jobRow('job-reconcile').published_commit).toBe(newerCommit)
	expect(t.jobRow('job-periodic').enabled).toBe(0)
})
