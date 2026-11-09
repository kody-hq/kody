import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import type { CommitAncestryResult } from '#worker/repo/commit-ancestry.ts'
import type { WorkflowProjectionRecord } from '#worker/run-records/workflow-projection.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const mocks = vi.hoisted(() => ({
	listWorkflowProjections: vi.fn(),
	checkSourceRepoCommitAncestry: vi.fn(),
}))

vi.mock('#worker/run-records/service.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	listWorkflowProjections: mocks.listWorkflowProjections,
}))

vi.mock('#worker/repo/commit-ancestry.ts', () => ({
	checkSourceRepoCommitAncestry: mocks.checkSourceRepoCommitAncestry,
}))

// Assert real `audit_events` rows written through the actual audit pipeline.
vi.unmock('#worker/audit-log.ts')
import { adminPackageProvenanceCapability } from './admin-package-provenance.ts'

const secretMarker = 'S3CRET-MARKER'
const now = '2026-11-01T00:00:00.000Z'
const ownerId = testStableUserIdFromEmail('bob@example.com')
const packageId = 'pkg-bob-tool'
const sourceId = 'src-bob-tool'
const repoId = 'repo-bob-tool'
const published = 'a'.repeat(40)
const serving = 'b'.repeat(40)
const older = 'c'.repeat(40)
const roleIds = { user: 1, admin: 2 } as const

const users = [
	{ username: 'admin', roles: ['admin', 'user'] as const },
	{ username: 'jane', roles: ['user'] as const },
	{ username: 'bob', roles: ['user'] as const },
]

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
	seedBobPackage(sqlite)
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		AUDIT_DB: createD1FromSqlite(auditSqlite),
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
	return {
		admin: contextFor('admin', ['admin', 'user']),
		jane: contextFor('jane', ['user']),
		bob: contextFor('bob', ['user']),
		auditEvents: () =>
			auditSqlite
				.prepare(
					'SELECT category, action, result, email_hash, path, reason, timestamp FROM audit_events ORDER BY id',
				)
				.all() as Array<Record<string, string | null>>,
	}
}

function seedBobPackage(sqlite: DatabaseSync) {
	sqlite
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
			 VALUES (?, ?, '@bob/tool', 'tool', '', ?)`,
		)
		.run(packageId, ownerId, sourceId)
	sqlite
		.prepare(
			`INSERT INTO entity_sources (id, user_id, entity_kind, entity_id, repo_id, published_commit, serving_commit, created_at, updated_at)
			 VALUES (?, ?, 'package', ?, ?, ?, ?, ?, ?)`,
		)
		.run(sourceId, ownerId, packageId, repoId, published, serving, now, now)
	sqlite
		.prepare(
			`INSERT INTO published_bundle_artifacts (id, user_id, source_id, published_commit, artifact_kind, artifact_name, entry_point, kv_key, dependencies_json, created_at, updated_at)
			 VALUES ('artifact-1', ?, ?, ?, 'module', NULL, 'src/index.ts', ?, ?, ?, ?)`,
		)
		.run(
			ownerId,
			sourceId,
			serving,
			`bundle:${secretMarker}`,
			JSON.stringify([{ source: `export const key = '${secretMarker}'` }]),
			now,
			now,
		)
	sqlite
		.prepare(
			`INSERT INTO jobs (id, user_id, name, source_id, published_commit, storage_id, params_json, schedule_json, timezone, caller_context_json, created_at, updated_at, next_run_at)
			 VALUES ('job-1', ?, 'nightly', ?, ?, 'storage-1', ?, '{"type":"cron","expression":"0 0 * * *"}', 'UTC', '{}', ?, ?, ?)`,
		)
		.run(
			ownerId,
			sourceId,
			older,
			JSON.stringify({ apiKey: secretMarker }),
			now,
			now,
			now,
		)
	sqlite
		.prepare(
			`INSERT INTO enablements (id, org_id, package_id, trigger_kind, trigger_name, instance_id, enabler_user_id, credential_mapping_json, origin, enabled_at, updated_at)
			 VALUES ('enablement-1', ?, ?, 'subscription', 'orders.created', 'instance-1', ?, ?, 'enabled', ?, ?)`,
		)
		.run(
			ownerId,
			packageId,
			ownerId,
			JSON.stringify({ token: secretMarker }),
			now,
			now,
		)
	sqlite
		.prepare(
			`INSERT INTO webhook_endpoints (id, user_id, package_id, webhook_name, url_secret_hash, url_secret_encrypted, hmac_secret_encrypted, created_at, rotated_at)
			 VALUES ('webhook-1', ?, ?, 'stripe', ?, ?, ?, ?, ?)`,
		)
		.run(
			ownerId,
			packageId,
			`hash-${secretMarker}`,
			`enc-${secretMarker}`,
			`hmac-${secretMarker}`,
			now,
			now,
		)
	sqlite
		.prepare(
			`INSERT INTO publish_builds (id, package_id, source_id, owner_user_id, requester_user_id, org_id, commit_sha, origin, ticket_sha256, status, document_json, message, created_at, updated_at, expires_at)
			 VALUES ('build-1', ?, ?, ?, ?, ?, ?, 'cli', ?, 'rejected', ?, ?, '2026-10-30T00:00:00.000Z', '2026-10-30T00:01:00.000Z', '2026-10-31T00:00:00.000Z')`,
		)
		.run(
			packageId,
			sourceId,
			ownerId,
			ownerId,
			ownerId,
			published,
			`ticket-${secretMarker}`,
			JSON.stringify({ files: { 'src/index.ts': secretMarker } }),
			`RepoCheckError: token=${secretMarker} was rejected`,
		)
}

function publishProjection(
	overrides: Partial<WorkflowProjectionRecord>,
): WorkflowProjectionRecord {
	return {
		id: 'workflow-1',
		bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
		sourceType: 'package',
		packageId,
		kodyId: 'tool',
		sourceId,
		workflowName: 'packagePublishExternalPush',
		exportName: null,
		idempotencyKey: `idem-${secretMarker}`,
		runAt: '2026-10-31T00:00:00.000Z',
		planDate: null,
		status: 'errored',
		createdAt: '2026-10-31T00:00:00.000Z',
		updatedAt: '2026-10-31T00:02:00.000Z',
		completedAt: '2026-10-31T00:02:00.000Z',
		lastError: `push_rejected: Authorization: Bearer ${secretMarker}`,
		enqueuedCommit: published,
		sourceRevision: null,
		...overrides,
	}
}

beforeEach(() => {
	mocks.listWorkflowProjections.mockReset().mockResolvedValue({
		projections: [
			publishProjection({}),
			publishProjection({
				id: 'workflow-other',
				workflowName: 'nightlyDigest',
			}),
		],
		nextCursor: null,
	})
	mocks.checkSourceRepoCommitAncestry.mockReset()
})

test('admin reads provenance for another owner package as SHAs and metadata only', async () => {
	const t = createTest()

	const result = await adminPackageProvenanceCapability.handler(
		{ packageId },
		t.admin,
	)

	expect(result).toEqual({
		package: {
			packageId,
			kodyId: 'tool',
			name: '@bob/tool',
			ownerId,
			ownerHandle: 'bob',
			sourceId,
		},
		source: {
			publishedCommit: published,
			servingCommit: serving,
			servingArtifactCommit: serving,
		},
		artifacts: [
			{
				kind: 'module',
				name: null,
				entryPoint: 'src/index.ts',
				builtFromCommit: serving,
				updatedAt: now,
			},
		],
		jobs: [
			{
				jobId: 'job-1',
				name: 'nightly',
				enabled: true,
				scheduleType: 'cron',
				recordedCommit: older,
				runsCommit: serving,
				lastRunAt: null,
				lastRunStatus: null,
				lastRunErrorClass: null,
				nextRunAt: now,
			},
		],
		triggers: [
			{
				kind: 'subscription',
				name: 'orders.created',
				state: 'on',
				pinnedCommit: null,
				runsCommit: serving,
				updatedAt: now,
			},
		],
		webhooks: [
			{
				endpointId: 'webhook-1',
				name: 'stripe',
				pinnedCommit: null,
				runsCommit: serving,
				createdAt: now,
			},
		],
		publishRuns: [
			{
				id: 'workflow-1',
				kind: 'publish_workflow',
				status: 'errored',
				commit: published,
				createdAt: '2026-10-31T00:00:00.000Z',
				updatedAt: '2026-10-31T00:02:00.000Z',
				completedAt: '2026-10-31T00:02:00.000Z',
				errorClass: 'push_rejected',
			},
			{
				id: 'build-1',
				kind: 'publish_build',
				status: 'rejected',
				commit: published,
				createdAt: '2026-10-30T00:00:00.000Z',
				updatedAt: '2026-10-30T00:01:00.000Z',
				completedAt: null,
				errorClass: 'RepoCheckError',
			},
		],
		publishRunsComplete: true,
		ancestry: null,
	})
	expect(mocks.listWorkflowProjections).toHaveBeenCalledWith(
		expect.objectContaining({ userId: ownerId, packageId }),
	)
	expect(mocks.checkSourceRepoCommitAncestry).not.toHaveBeenCalled()

	const serialized = JSON.stringify(result)
	expect(serialized).not.toContain(secretMarker)
	expect(serialized).not.toMatch(/token|secret|ticket|kv_?key|bundle:/i)

	const byName = await adminPackageProvenanceCapability.handler(
		{ packageName: '@bob/tool' },
		t.admin,
	)
	expect(byName.package.packageId).toBe(packageId)

	const events = t.auditEvents()
	expect(events).toHaveLength(2)
	for (const event of events) {
		expect(event).toMatchObject({
			category: 'admin',
			action: 'adminPackageProvenance',
			result: 'success',
			path: '/mcp',
			reason: `package_id=${packageId} owner_id=${ownerId} ancestry=none`,
		})
		expect(event.email_hash).toEqual(expect.any(String))
		expect(event.timestamp).toEqual(expect.any(String))
		expect(JSON.stringify(event)).not.toContain(secretMarker)
	}
})

test('non-admin callers are rejected, including the owner and another owner', async () => {
	const t = createTest()

	await expect(
		adminPackageProvenanceCapability.handler({ packageId }, t.jane),
	).rejects.toThrow('lacks required role "admin"')
	await expect(
		adminPackageProvenanceCapability.handler(
			{ packageName: '@bob/tool' },
			t.bob,
		),
	).rejects.toThrow('lacks required role "admin"')

	expect(mocks.listWorkflowProjections).not.toHaveBeenCalled()
	expect(mocks.checkSourceRepoCommitAncestry).not.toHaveBeenCalled()
	const events = t.auditEvents()
	expect(
		events.some((event) => event.action === 'adminPackageProvenance'),
	).toBe(false)
	expect(events).toEqual([
		expect.objectContaining({
			category: 'auth',
			action: 'mcp_capability_denied',
			result: 'failure',
			reason: 'role',
		}),
		expect.objectContaining({
			category: 'auth',
			action: 'mcp_capability_denied',
			result: 'failure',
			reason: 'role',
		}),
	])
})

test('ancestry is computed platform-side for ancestor, not ancestor, and unknown commits', async () => {
	const t = createTest()
	const missing = 'f'.repeat(40)
	mocks.checkSourceRepoCommitAncestry.mockImplementation(
		async (input: {
			ancestor: string
			descendant: string
		}): Promise<CommitAncestryResult> => {
			const base = {
				ancestor: input.ancestor,
				descendant: input.descendant,
			}
			if (input.ancestor === missing) {
				return {
					...base,
					result: 'unknown_commit',
					isAncestor: null,
					unknownCommits: [missing],
				}
			}
			const isAncestor = input.ancestor === older
			return {
				...base,
				result: isAncestor ? 'ancestor' : 'not_ancestor',
				isAncestor,
				unknownCommits: [],
			}
		},
	)

	const ancestor = await adminPackageProvenanceCapability.handler(
		{ packageId, ancestry: { ancestor: older, descendant: published } },
		t.admin,
	)
	expect(ancestor.ancestry).toEqual({
		ancestor: older,
		descendant: published,
		result: 'ancestor',
		isAncestor: true,
		unknownCommits: [],
	})
	expect(mocks.checkSourceRepoCommitAncestry).toHaveBeenCalledWith({
		env: t.admin.env,
		repoId,
		ancestor: older,
		descendant: published,
	})

	const notAncestor = await adminPackageProvenanceCapability.handler(
		{ packageId, ancestry: { ancestor: published, descendant: older } },
		t.admin,
	)
	expect(notAncestor.ancestry).toMatchObject({
		result: 'not_ancestor',
		isAncestor: false,
	})

	const unknown = await adminPackageProvenanceCapability.handler(
		{ packageId, ancestry: { ancestor: missing, descendant: published } },
		t.admin,
	)
	expect(unknown.ancestry).toMatchObject({
		result: 'unknown_commit',
		isAncestor: null,
		unknownCommits: [missing],
	})

	expect(t.auditEvents().map((event) => event.reason)).toEqual([
		`package_id=${packageId} owner_id=${ownerId} ancestry=ancestor`,
		`package_id=${packageId} owner_id=${ownerId} ancestry=not_ancestor`,
		`package_id=${packageId} owner_id=${ownerId} ancestry=unknown_commit`,
	])

	await expect(
		adminPackageProvenanceCapability.handler(
			{ packageId, ancestry: { ancestor: 'abc', descendant: published } },
			t.admin,
		),
	).rejects.toThrow(/Expected a full commit SHA/)
})

test('missing packages and ambiguous targets fail and the failure is audited', async () => {
	const t = createTest()

	await expect(
		adminPackageProvenanceCapability.handler(
			{ packageName: '@bob/missing' },
			t.admin,
		),
	).rejects.toThrow('Package not found (package_name=@bob/missing).')
	await expect(
		adminPackageProvenanceCapability.handler(
			{ packageId, packageName: '@bob/tool' },
			t.admin,
		),
	).rejects.toThrow(/exactly one of packageId or packageName/)

	expect(t.auditEvents()).toEqual([
		expect.objectContaining({
			category: 'admin',
			action: 'adminPackageProvenance',
			result: 'failure',
			reason: 'Package not found (package_name=@bob/missing).',
		}),
	])
})

test('an unreadable owner RunLog marks publish runs incomplete', async () => {
	const t = createTest()
	mocks.listWorkflowProjections.mockRejectedValue(
		new Error(`RunLog unavailable ${secretMarker}`),
	)

	const result = await adminPackageProvenanceCapability.handler(
		{ packageId },
		t.admin,
	)
	expect(result.publishRunsComplete).toBe(false)
	expect(result.publishRuns.map((run) => run.id)).toEqual(['build-1'])
	expect(JSON.stringify(result)).not.toContain(secretMarker)
})
