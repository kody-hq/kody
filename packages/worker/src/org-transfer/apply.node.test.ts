import { buildPackageJobId } from '@kody-internal/shared/jobs/package-job-id.ts'
import { type JobRow } from '@kody-internal/shared/jobs/repo.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import {
	decryptSecretValue,
	decryptUserOauthAccessToken,
	decryptUserOauthClientSecret,
	decryptUserOauthRefreshToken,
	decryptWebhookHmacSecret,
	decryptWebhookUrlSecret,
	encryptSecretValue,
	encryptUserOauthAccessToken,
	encryptUserOauthClientSecret,
	encryptUserOauthRefreshToken,
	encryptWebhookHmacSecret,
	encryptWebhookUrlSecret,
	userIntegrationCredentialContext,
	userOauthAppCredentialContext,
	userSecretContext,
	userWebhookHmacSecretContext,
	userWebhookUrlSecretContext,
} from '#mcp/secrets/crypto.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import {
	orgAuditOutboxInsertStatement,
	planOrgAuditOutbox,
} from '#worker/orgs/org-audit-outbox.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { buildLengthSafeVectorId } from '#worker/vectorize/vector-ids.ts'
import { type OrgTransferEffects, runOrgResourceTransfer } from './apply.ts'
import { runOrgTransferPostCommit } from './post-commit.ts'
import { resealOrgTransferSecrets } from './reencrypt.ts'
import { orgTransferMemoriesStayNote } from './report.ts'
import { loadOrgTransferSnapshot } from './snapshot.ts'
import { OrgTransferStorageNotEmptyError } from './storage-copy.ts'

const jobsMock = vi.hoisted(() => ({ jobs: [] as Array<unknown> }))

const memoryVectorMock = vi.hoisted(() => ({
	deleteMemoryVector: vi.fn(async () => {}),
	upsertMemoryVector: vi.fn(async () => {}),
}))

vi.mock('#mcp/memory/memory-vectorize.ts', () => ({
	memoryVectorId: (memoryId: string) => `memory_${memoryId}`,
	deleteMemoryVector: memoryVectorMock.deleteMemoryVector,
	upsertMemoryVector: memoryVectorMock.upsertMemoryVector,
}))

vi.mock('#worker/jobs/jobs-data.ts', () => ({
	jobsData: () => ({
		listJobsForUser: async () => jobsMock.jobs,
	}),
}))

const hubMock = vi.hoisted(() => ({
	serverIds: {} as Record<string, Array<string>>,
}))

vi.mock('#worker/mcp-client/hub-transfer.ts', () => ({
	mcpClientHubTransferStub: ({ userId }: { userId: string }) => ({
		listServerIdsForTransfer: async () => hubMock.serverIds[userId] ?? [],
	}),
}))

const env = { SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum' }
const src = 'org-src' as OwnerId
const dst = 'org-dst' as OwnerId
const pkgA = '11111111-1111-4111-8111-111111111111'
const pkgB = '22222222-2222-4222-8222-222222222222'
const pkgC = '33333333-3333-4333-8333-333333333333'
const goneOrphanPkg = '44444444-4444-4444-8444-444444444444'
const now = '2026-10-11T00:00:00.000Z'

const plaintexts = {
	userSecret: 'user-secret-plaintext-value',
	packageSecret: 'package-secret-plaintext-value',
	clientSecret: 'oauth-client-secret-plaintext',
	accessToken: 'integration-access-token-plaintext',
	refreshToken: 'integration-refresh-token-plaintext',
	webhookUrl: 'webhook-url-secret-plaintext',
	webhookHmac: 'webhook-hmac-secret-plaintext',
	webhookVerification: 'webhook-verification-snapshot-plaintext',
	webhookPreviousHmac: 'webhook-previous-hmac-plaintext',
}

beforeEach(() => {
	jobsMock.jobs = []
	hubMock.serverIds = { [src]: ['server-1'] }
	memoryVectorMock.deleteMemoryVector.mockClear()
	memoryVectorMock.upsertMemoryVector.mockClear()
})

async function seed() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const run = (sql: string, ...params: Array<string | number | null>) =>
		sqlite.prepare(sql).run(...params)
	for (const [id, slug] of [
		[src, 'bradhave'],
		[dst, 'haveman'],
	]) {
		run(
			`INSERT INTO orgs (id, slug, created_at, updated_at) VALUES (?, ?, ?, ?)`,
			id!,
			slug!,
			now,
			now,
		)
	}
	run(
		`INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?, 'person-brad', 'owner', ?)`,
		dst,
		now,
	)
	for (const [id, kodyId] of [
		[pkgA, 'alpha'],
		[pkgB, 'beta'],
		[pkgC, 'gamma'],
	] as const) {
		run(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
			 VALUES (?, ?, ?, ?, 'desc', ?)`,
			id,
			src,
			`@bradhave/${kodyId}`,
			kodyId,
			`src-${kodyId}`,
		)
		run(
			`INSERT INTO entity_sources (id, user_id, entity_kind, entity_id, repo_id, published_commit, created_at, updated_at)
			 VALUES (?, ?, 'package', ?, ?, 'commit-1', ?, ?)`,
			`src-${kodyId}`,
			src,
			id,
			`repo-${kodyId}`,
			now,
			now,
		)
	}
	// Orphan source of a package that no longer exists.
	run(
		`INSERT INTO entity_sources (id, user_id, entity_kind, entity_id, repo_id, created_at, updated_at)
		 VALUES ('src-orphan', ?, 'package', 'missing-package', 'repo-orphan', ?, ?)`,
		src,
		now,
		now,
	)

	run(
		`INSERT INTO secret_buckets (id, user_id, scope, binding_key) VALUES ('bucket-user', ?, 'user', '')`,
		src,
	)
	run(
		`INSERT INTO secret_buckets (id, user_id, scope, binding_key) VALUES ('bucket-pkg-a', ?, 'package', ?)`,
		src,
		pkgA,
	)
	run(
		`INSERT INTO secret_entries (bucket_id, name, encrypted_value) VALUES ('bucket-user', 'API_KEY', ?)`,
		await encryptSecretValue(
			env,
			plaintexts.userSecret,
			userSecretContext(src),
		),
	)
	run(
		`INSERT INTO secret_entries (bucket_id, name, encrypted_value) VALUES ('bucket-pkg-a', 'PKG_TOKEN', ?)`,
		await encryptSecretValue(
			env,
			plaintexts.packageSecret,
			userSecretContext(src),
		),
	)

	run(
		`INSERT INTO user_oauth_apps (user_id, slug, provider, client_id, token_url, flow, client_secret_encrypted, logo_key)
		 VALUES (?, 'myapp', 'github', 'client-1', 'https://example.com/token', 'confidential', ?, ?)`,
		src,
		await encryptUserOauthClientSecret(
			env,
			plaintexts.clientSecret,
			userOauthAppCredentialContext(src, 'myapp'),
		),
		`user-oauth-app-logos/${src}/myapp.png`,
	)
	run(
		`INSERT INTO user_integrations (user_id, name, app_slug, access_token_encrypted, refresh_token_encrypted)
		 VALUES (?, 'github', 'myapp', ?, ?)`,
		src,
		await encryptUserOauthAccessToken(
			env,
			plaintexts.accessToken,
			userIntegrationCredentialContext(src, 'github'),
		),
		await encryptUserOauthRefreshToken(
			env,
			plaintexts.refreshToken,
			userIntegrationCredentialContext(src, 'github'),
		),
	)

	run(
		`INSERT INTO webhook_endpoints (
			id, user_id, package_id, webhook_name, url_secret_hash, created_at, rotated_at,
			url_secret_encrypted, hmac_secret_encrypted,
			hmac_verification_secret_encrypted, previous_hmac_secret_encrypted
		) VALUES ('hook-1', ?, ?, 'ping', 'hash-1', ?, ?, ?, ?, ?, ?)`,
		src,
		pkgA,
		now,
		now,
		await encryptWebhookUrlSecret(
			env,
			plaintexts.webhookUrl,
			userWebhookUrlSecretContext(src, 'hook-1'),
		),
		await encryptWebhookHmacSecret(
			env,
			plaintexts.webhookHmac,
			userWebhookHmacSecretContext(src, 'hook-1'),
		),
		await encryptWebhookHmacSecret(
			env,
			plaintexts.webhookVerification,
			userWebhookHmacSecretContext(src, 'hook-1'),
		),
		await encryptWebhookHmacSecret(
			env,
			plaintexts.webhookPreviousHmac,
			userWebhookHmacSecretContext(src, 'hook-1'),
		),
	)
	// Disabled webhook of a deleted package.
	run(
		`INSERT INTO webhook_endpoints (id, user_id, package_id, webhook_name, url_secret_hash, enabled, created_at, rotated_at)
		 VALUES ('hook-orphan', ?, ?, 'ping', 'hash-2', 0, ?, ?)`,
		src,
		goneOrphanPkg,
		now,
		now,
	)

	run(
		`INSERT INTO mcp_memories (id, user_id, subject, summary) VALUES ('memory-1', ?, 'Brad', 'Prefers tea')`,
		src,
	)
	run(
		`INSERT INTO mcp_server_settings (id, user_id, name, url) VALUES ('server-1', ?, 'linear', 'https://mcp.example.com')`,
		src,
	)
	run(
		`INSERT INTO user_storage_buckets (user_id, storage_id, kind, created_at, last_seen_at)
		 VALUES (?, ?, 'package', ?, ?)`,
		src,
		`package:${pkgA}`,
		now,
		now,
	)
	run(
		`INSERT INTO user_storage_buckets (user_id, storage_id, kind, created_at, last_seen_at)
		 VALUES (?, ?, 'package', ?, ?)`,
		src,
		`package:${goneOrphanPkg}`,
		now,
		now,
	)
	return { sqlite, db }
}

type Calls = Array<string>

function packageJob(packageId: string, name: string, sourceId: string) {
	const id = buildPackageJobId(packageId, name)
	return {
		id,
		user_id: src,
		callerContextJson: '{"original":true}',
		record: {
			id,
			name,
			sourceId,
			storageId: `job:${id}`,
			schedule: { type: 'cron', expression: '0 3 * * *' },
			timezone: 'UTC',
		},
	} as unknown as JobRow
}

function insertEnablement(
	sqlite: DatabaseSync,
	input: { id: string; enabler: string; state?: string },
) {
	sqlite
		.prepare(
			`INSERT INTO enablements (
				id, org_id, package_id, trigger_kind, trigger_name, instance_id,
				enabler_user_id, state, origin, enabled_at, updated_at
			) VALUES (?, ?, ?, 'webhook', 'ping', 'hook-1', ?, ?, 'enabled', ?, ?)`,
		)
		.run(input.id, src, pkgA, input.enabler, input.state ?? 'on', now, now)
}

function createEffects(input: {
	db: D1Database
	calls: Calls
	backups: Array<string>
	overrides?: Partial<OrgTransferEffects>
}): OrgTransferEffects {
	const { db, calls } = input
	const writer = {
		appDb: db,
		db,
		actorUserId: 'person-admin',
		actorUsername: 'admin',
		credentialKind: null,
		credentialId: null,
	}
	return {
		withWriteLease: async (ownerId, write) => {
			calls.push(`lease:${ownerId}`)
			return await write()
		},
		loadSnapshot: ({ from, to }) =>
			loadOrgTransferSnapshot({
				env: { APP_DB: db } as Env,
				from,
				to,
			}),
		reseal: (plan) => resealOrgTransferSecrets({ env, plan }),
		writeBackup: async ({ key, backup }) => {
			calls.push(`backup:${key}`)
			input.backups.push(JSON.stringify(backup))
		},
		copyLogo: async (copy) => {
			calls.push(`copyLogo:${copy.toKey}`)
		},
		deleteLogo: async (key) => {
			calls.push(`deleteLogo:${key}`)
		},
		isStorageEmpty: async () => true,
		copyStorage: async ({ storageId }) => {
			calls.push(`copyStorage:${storageId}`)
			return { storageId, kvEntries: 2, sqlRows: { notes: 3 } }
		},
		clearStorage: async ({ userId, storageId }) => {
			calls.push(`clearStorage:${userId}:${storageId}`)
		},
		exportMcpServer: async ({ serverId }) => {
			calls.push(`exportMcp:${serverId}`)
			return {
				row: {
					id: serverId,
					name: 'linear',
					server_url: 'https://mcp.example.com',
					client_id: null,
					auth_url: null,
					callback_url: 'https://heykody.dev/callback',
					server_options: null,
				},
				entries: [],
			}
		},
		importMcpServer: async ({ userId, transfer }) => {
			calls.push(`importMcp:${userId}:${transfer.row.id}`)
			return { ok: true }
		},
		discardMcpServerImport: async ({ userId, serverId }) => {
			calls.push(`discardMcp:${userId}:${serverId}`)
		},
		jobCallerContextJson: async ({ userId, packageId }) =>
			JSON.stringify({ userId, packageId }),
		transferJobs: async ({ fromUserId, toUserId, jobs }) => {
			calls.push(`transferJobs:${fromUserId}->${toUserId}:${jobs.length}`)
			return { transferred: jobs.length }
		},
		planAudit: (events) => {
			const plans = events.map((event) =>
				planOrgAuditOutbox(writer, {
					orgId: event.orgId,
					action: event.action,
					details: event.details,
				}),
			)
			return {
				statements: plans.map((plan) =>
					orgAuditOutboxInsertStatement(db, plan),
				),
				deliver: async () => {
					calls.push('deliverAudit')
				},
			}
		},
		afterCommit: async ({ plan, cleanupOrphans }) => {
			calls.push(
				`afterCommit:${cleanupOrphans}:${plan.orphans
					.filter(
						(orphan) =>
							orphan.cleanup === 'entity-source' ||
							orphan.cleanup === 'storage-bucket',
					)
					.map((orphan) => orphan.key)
					.join(',')}`,
			)
			return { leftovers: {}, warnings: [], mcpConnections: [] }
		},
		...input.overrides,
	}
}

function dumpOwnedRows(sqlite: DatabaseSync) {
	return [
		'saved_packages',
		'entity_sources',
		'secret_buckets',
		'secret_entries',
		'user_oauth_apps',
		'user_integrations',
		'webhook_endpoints',
		'mcp_memories',
		'mcp_server_settings',
		'user_storage_buckets',
		'orgs',
		'org_audit_outbox',
	].map((table) => sqlite.prepare(`SELECT * FROM ${table}`).all())
}

function expectNoSecretMaterial(text: string, sqlite: DatabaseSync) {
	for (const value of Object.values(plaintexts)) {
		expect(text).not.toContain(value)
	}
	const ciphertexts = sqlite
		.prepare(
			`SELECT encrypted_value AS value FROM secret_entries
			 UNION ALL SELECT client_secret_encrypted FROM user_oauth_apps
			 UNION ALL SELECT access_token_encrypted FROM user_integrations
			 UNION ALL SELECT refresh_token_encrypted FROM user_integrations
			 UNION ALL SELECT url_secret_encrypted FROM webhook_endpoints
			 UNION ALL SELECT hmac_secret_encrypted FROM webhook_endpoints
			 UNION ALL SELECT hmac_verification_secret_encrypted FROM webhook_endpoints
			 UNION ALL SELECT previous_hmac_secret_encrypted FROM webhook_endpoints`,
		)
		.all() as Array<{ value: string | null }>
	for (const { value } of ciphertexts) {
		if (value) expect(text).not.toContain(value)
	}
}

test('dry-run reports the plan as counts and names and writes nothing', async () => {
	const { sqlite, db } = await seed()
	jobsMock.jobs = [packageJob(pkgA, 'nightly', 'src-alpha')]
	insertEnablement(sqlite, { id: 'enablement-1', enabler: 'person-brad' })
	const calls: Calls = []
	const before = dumpOwnedRows(sqlite)
	const result = await runOrgResourceTransfer({
		db,
		effects: createEffects({ db, calls, backups: [] }),
		actorUserId: 'person-admin',
		fromOrgId: src,
		toOrgId: dst,
		mode: 'dry-run',
		skipOrphans: false,
	})
	expect(dumpOwnedRows(sqlite)).toEqual(before)
	expect(calls).toEqual([])
	expect(result.outcome).toBe('planned')
	expect(result.applied).toBe(false)
	expect(result.failure).toBeNull()
	expect(result.backupKey).toBeNull()
	expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/)
	expect(result.refusals.map((finding) => finding.code)).toEqual([
		'orphans_present',
	])
	expect(result.summary.packages.map((pkg) => pkg.to_name).sort()).toEqual([
		'@haveman/alpha',
		'@haveman/beta',
		'@haveman/gamma',
	])
	expect(result.summary.secrets).toEqual(
		expect.arrayContaining([
			{ scope: 'user', binding: '', name: 'API_KEY' },
			{ scope: 'package', binding: 'alpha', name: 'PKG_TOKEN' },
		]),
	)
	expect(result.summary.integrations).toEqual(['github'])
	expect(result.summary.oauth_apps).toEqual(['myapp'])
	expect(result.summary.mcp_servers).toEqual([
		{ id: 'server-1', name: 'linear' },
	])
	expect(result.summary.webhooks).toEqual([
		{
			package: 'alpha',
			name: 'ping',
			url_changed: true,
			old_path_prefix: '/@bradhave/webhooks/alpha/ping/',
			new_path_prefix: '/@haveman/webhooks/alpha/ping/',
			manage_path: '/@haveman/-/webhooks',
		},
	])
	expect(result.summary.enablements).toEqual([
		{
			package: 'alpha',
			trigger_kind: 'webhook',
			trigger_name: 'ping',
			state: 'on',
			enabler_user_id: 'person-brad',
			enabler_is_target_member: true,
		},
	])
	expect(result.summary.jobs).toEqual([
		{
			id: buildPackageJobId(pkgA, 'nightly'),
			name: 'nightly',
			package: 'alpha',
			schedule: 'Runs on cron "0 3 * * *" in UTC',
		},
	])
	expect(result.summary.storages).toEqual([
		{ storage_id: `package:${pkgA}`, kind: 'package' },
		{ storage_id: `package:${pkgB}`, kind: 'package' },
		{ storage_id: `package:${pkgC}`, kind: 'package' },
		{
			storage_id: `job:${buildPackageJobId(pkgA, 'nightly')}`,
			kind: 'job',
		},
	])
	expect(result.summary.orphans).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ table: 'entity_sources', key: 'src-orphan' }),
			expect.objectContaining({
				table: 'webhook_endpoints',
				key: 'hook-orphan',
			}),
		]),
	)
	expect(result.summary.clashes).toEqual([])
	expect(result.summary.kept).toEqual({
		memories: { count: 1, note: orgTransferMemoriesStayNote },
	})
	expect(result.summary.counts).not.toHaveProperty('mcp_memories')
	expect(result.summary.orphans.map((orphan) => orphan.table)).not.toContain(
		'mcp_memory_conversation_suppressions',
	)
	expectNoSecretMaterial(JSON.stringify(result), sqlite)
})

test('dry-run reports memories staying even when the source has none', async () => {
	const { sqlite, db } = await seed()
	sqlite.prepare(`DELETE FROM mcp_memories`).run()
	const result = await runOrgResourceTransfer({
		db,
		effects: createEffects({ db, calls: [], backups: [] }),
		actorUserId: 'person-admin',
		fromOrgId: src,
		toOrgId: dst,
		mode: 'dry-run',
		skipOrphans: false,
	})
	expect(result.outcome).toBe('planned')
	expect(result.summary.kept).toEqual({
		memories: { count: 0, note: orgTransferMemoriesStayNote },
	})
})

test('apply refuses clashes in the target and touches nothing', async () => {
	const { sqlite, db } = await seed()
	sqlite
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
			 VALUES ('target-pkg', ?, '@haveman/alpha', 'alpha', 'desc', 'src-target')`,
		)
		.run(dst)
	sqlite
		.prepare(
			`INSERT INTO secret_buckets (id, user_id, scope, binding_key) VALUES ('target-user', ?, 'user', '')`,
		)
		.run(dst)
	sqlite
		.prepare(
			`INSERT INTO secret_entries (bucket_id, name, encrypted_value) VALUES ('target-user', 'API_KEY', 'x')`,
		)
		.run()
	const calls: Calls = []
	const before = dumpOwnedRows(sqlite)
	const result = await runOrgResourceTransfer({
		db,
		effects: createEffects({ db, calls, backups: [] }),
		actorUserId: 'person-admin',
		fromOrgId: src,
		toOrgId: dst,
		mode: 'apply',
		skipOrphans: true,
	})
	expect(result.outcome).toBe('refused')
	expect(result.applied).toBe(false)
	expect(result.backupKey).toBeNull()
	expect(result.refusals).toEqual([
		{
			code: 'target_row_exists',
			message: 'saved_packages: @haveman/alpha already exists in @haveman',
			table: 'saved_packages',
			subject: '@haveman/alpha',
		},
		{
			code: 'target_row_exists',
			message: 'saved_packages: alpha already exists in @haveman',
			table: 'saved_packages',
			subject: 'alpha',
		},
		{
			code: 'target_entry_exists',
			message: 'secret_entries: user API_KEY already exists in @haveman',
			table: 'secret_entries',
			subject: 'user API_KEY',
		},
	])
	expect(result.refusals).toEqual(result.summary.clashes)
	expect(calls.filter((call) => !call.startsWith('lease:'))).toEqual([])
	expect(dumpOwnedRows(sqlite)).toEqual(before)
})

test('apply refuses orphans unless skipOrphans', async () => {
	const { sqlite, db } = await seed()
	const before = dumpOwnedRows(sqlite)
	const result = await runOrgResourceTransfer({
		db,
		effects: createEffects({ db, calls: [], backups: [] }),
		actorUserId: 'person-admin',
		fromOrgId: src,
		toOrgId: dst,
		mode: 'apply',
		skipOrphans: false,
	})
	expect(result.outcome).toBe('refused')
	expect(result.refusals).toEqual([
		{
			code: 'orphans_present',
			message: expect.stringMatching(
				/orphaned row\(s\) found; pass skipOrphans/,
			),
		},
	])
	expect(dumpOwnedRows(sqlite)).toEqual(before)
})

test('apply moves everything, re-seals credentials, and cleans up orphans', async () => {
	const { sqlite, db } = await seed()
	sqlite
		.prepare(
			`INSERT INTO user_repos (id, user_id, name, created_at, updated_at)
			 VALUES ('repo-notes', ?, 'notes', ?, ?)`,
		)
		.run(src, now, now)
	sqlite
		.prepare(
			`INSERT INTO follows (
				id, follower_org_id, creator_user_id, target_kind, target_owner_id,
				target_id, target_name, status, created_at, updated_at
			) VALUES
				('follow-pkg', 'org-follower', 'person-1', 'package', ?, ?, '@bradhave/alpha', 'active', ?, ?),
				('follow-repo', 'org-follower', 'person-1', 'repo', ?, 'repo-notes', '@bradhave/notes', 'active', ?, ?),
				('follow-kept', 'org-follower', 'person-1', 'package', 'org-other', 'pkg-other', '@other/keep', 'active', ?, ?)`,
		)
		.run(src, pkgA, now, now, src, now, now, now, now)
	const calls: Calls = []
	const backups: Array<string> = []
	const logged: Array<string> = []
	const record = (...args: Array<unknown>) => {
		logged.push(args.map((arg) => String(arg)).join(' '))
	}
	const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
		(method) => vi.spyOn(console, method).mockImplementation(record),
	)
	const result = await runOrgResourceTransfer({
		db,
		effects: createEffects({ db, calls, backups }),
		actorUserId: 'person-admin',
		fromOrgId: src,
		toOrgId: dst,
		mode: 'apply',
		skipOrphans: true,
	})
	for (const spy of spies) spy.mockRestore()

	expect(result.outcome).toBe('applied')
	expect(result.applied).toBe(true)
	expect(result.failure).toBeNull()
	expect(result.backupKey).toMatch(
		new RegExp(`^org-resource-transfers/${src}/${dst}/`),
	)
	expect(calls).toEqual([
		`lease:${dst}`,
		`lease:${src}`,
		`backup:${result.backupKey}`,
		`copyLogo:user-oauth-app-logos/${dst}/myapp.png`,
		`copyStorage:package:${pkgA}`,
		`copyStorage:package:${pkgB}`,
		`copyStorage:package:${pkgC}`,
		'exportMcp:server-1',
		`importMcp:${dst}:server-1`,
		'deliverAudit',
		`afterCommit:true:src-orphan,package:${goneOrphanPkg}`,
	])
	// Cleared and deleted by the post-commit step, never soft-deleted.
	expect(
		sqlite
			.prepare(
				`SELECT user_id, deleted_at FROM user_storage_buckets WHERE storage_id = ?`,
			)
			.get(`package:${goneOrphanPkg}`),
	).toEqual({ user_id: src, deleted_at: null })

	const packages = sqlite
		.prepare(`SELECT id, user_id, name FROM saved_packages ORDER BY name`)
		.all()
	expect(packages).toEqual([
		{ id: pkgA, user_id: dst, name: '@haveman/alpha' },
		{ id: pkgB, user_id: dst, name: '@haveman/beta' },
		{ id: pkgC, user_id: dst, name: '@haveman/gamma' },
	])
	expect(
		sqlite
			.prepare(
				`SELECT id, follower_org_id, target_owner_id, target_name
				 FROM follows ORDER BY id`,
			)
			.all(),
	).toEqual([
		{
			id: 'follow-kept',
			follower_org_id: 'org-follower',
			target_owner_id: 'org-other',
			target_name: '@other/keep',
		},
		{
			id: 'follow-pkg',
			follower_org_id: 'org-follower',
			target_owner_id: dst,
			target_name: '@haveman/alpha',
		},
		{
			id: 'follow-repo',
			follower_org_id: 'org-follower',
			target_owner_id: dst,
			target_name: '@haveman/notes',
		},
	])
	expect(
		sqlite.prepare(`SELECT id, user_id FROM entity_sources ORDER BY id`).all(),
	).toEqual([
		{ id: 'src-alpha', user_id: dst },
		{ id: 'src-beta', user_id: dst },
		{ id: 'src-gamma', user_id: dst },
		// Deleted with its artifacts by the post-commit step.
		{ id: 'src-orphan', user_id: src },
	])

	const secretRows = sqlite
		.prepare(
			`SELECT e.name, e.encrypted_value, b.user_id FROM secret_entries e
			 JOIN secret_buckets b ON b.id = e.bucket_id ORDER BY e.name`,
		)
		.all() as Array<{ name: string; encrypted_value: string; user_id: string }>
	expect(secretRows.map((row) => row.user_id)).toEqual([dst, dst])
	for (const [row, plaintext] of [
		[secretRows[0]!, plaintexts.userSecret],
		[secretRows[1]!, plaintexts.packageSecret],
	] as const) {
		expect(
			await decryptSecretValue(
				env,
				row.encrypted_value,
				userSecretContext(dst),
			),
		).toBe(plaintext)
		await expect(
			decryptSecretValue(env, row.encrypted_value, userSecretContext(src)),
		).rejects.toThrow('Unable to decrypt secret value.')
	}

	const app = sqlite.prepare(`SELECT * FROM user_oauth_apps`).get() as Record<
		string,
		string
	>
	expect(app.user_id).toBe(dst)
	expect(app.logo_key).toBe(`user-oauth-app-logos/${dst}/myapp.png`)
	expect(
		await decryptUserOauthClientSecret(
			env,
			app.client_secret_encrypted!,
			userOauthAppCredentialContext(dst, 'myapp'),
		),
	).toBe(plaintexts.clientSecret)
	await expect(
		decryptUserOauthClientSecret(
			env,
			app.client_secret_encrypted!,
			userOauthAppCredentialContext(src, 'myapp'),
		),
	).rejects.toThrow('Unable to decrypt OAuth app client secret.')

	const integration = sqlite
		.prepare(`SELECT * FROM user_integrations`)
		.get() as Record<string, string>
	expect(integration.user_id).toBe(dst)
	expect(
		await decryptUserOauthAccessToken(
			env,
			integration.access_token_encrypted!,
			userIntegrationCredentialContext(dst, 'github'),
		),
	).toBe(plaintexts.accessToken)
	expect(
		await decryptUserOauthRefreshToken(
			env,
			integration.refresh_token_encrypted!,
			userIntegrationCredentialContext(dst, 'github'),
		),
	).toBe(plaintexts.refreshToken)
	await expect(
		decryptUserOauthAccessToken(
			env,
			integration.access_token_encrypted!,
			userIntegrationCredentialContext(src, 'github'),
		),
	).rejects.toThrow('Unable to decrypt integration access token.')

	const hook = sqlite
		.prepare(`SELECT * FROM webhook_endpoints WHERE id = 'hook-1'`)
		.get() as Record<string, string>
	expect(hook.user_id).toBe(dst)
	expect(
		await decryptWebhookUrlSecret(
			env,
			hook.url_secret_encrypted!,
			userWebhookUrlSecretContext(dst, 'hook-1'),
		),
	).toBe(plaintexts.webhookUrl)
	expect(
		await decryptWebhookHmacSecret(
			env,
			hook.hmac_secret_encrypted!,
			userWebhookHmacSecretContext(dst, 'hook-1'),
		),
	).toBe(plaintexts.webhookHmac)
	expect(
		await decryptWebhookHmacSecret(
			env,
			hook.hmac_verification_secret_encrypted!,
			userWebhookHmacSecretContext(dst, 'hook-1'),
		),
	).toBe(plaintexts.webhookVerification)
	expect(
		await decryptWebhookHmacSecret(
			env,
			hook.previous_hmac_secret_encrypted!,
			userWebhookHmacSecretContext(dst, 'hook-1'),
		),
	).toBe(plaintexts.webhookPreviousHmac)
	const orphanHook = sqlite
		.prepare(
			`SELECT user_id, deleted_at FROM webhook_endpoints WHERE id = 'hook-orphan'`,
		)
		.get() as { user_id: string; deleted_at: string | null }
	expect(orphanHook.user_id).toBe(src)
	expect(orphanHook.deleted_at).not.toBeNull()

	expect(
		sqlite.prepare(`SELECT DISTINCT user_id FROM mcp_server_settings`).all(),
	).toEqual([{ user_id: dst }])
	expect(
		sqlite.prepare(`SELECT id, user_id, deleted_at FROM mcp_memories`).all(),
	).toEqual([{ id: 'memory-1', user_id: src, deleted_at: null }])
	expect(result.summary.kept).toEqual({
		memories: { count: 1, note: orgTransferMemoriesStayNote },
	})
	expect(
		sqlite
			.prepare(`SELECT user_id FROM user_storage_buckets WHERE storage_id = ?`)
			.all(`package:${pkgA}`),
	).toEqual([{ user_id: dst }])
	expect(
		sqlite.prepare(`SELECT id, access_epoch FROM orgs ORDER BY id`).all(),
	).toEqual([
		{ id: dst, access_epoch: 1 },
		{ id: src, access_epoch: 1 },
	])
	const audit = sqlite
		.prepare(
			`SELECT org_id, payload_json FROM org_audit_outbox ORDER BY org_id`,
		)
		.all() as Array<{ org_id: string; payload_json: string }>
	expect(
		audit.map((row) => [row.org_id, JSON.parse(row.payload_json).action]),
	).toEqual([
		[dst, 'org.resources_transferred_in'],
		[src, 'org.resources_transferred_out'],
	])

	// The backup keeps the source ciphertext so restore is a row write.
	expect(backups).toHaveLength(1)
	for (const value of Object.values(plaintexts)) {
		expect(backups[0]).not.toContain(value)
	}
	expect(backups[0]).toContain('"encrypted_value"')
	expect(backups[0]).not.toContain('Prefers tea')
	expect(backups[0]).not.toContain('mcp_memories')

	expectNoSecretMaterial(JSON.stringify(result), sqlite)
	expectNoSecretMaterial(
		audit.map((row) => row.payload_json).join('\n'),
		sqlite,
	)
	expectNoSecretMaterial(logged.join('\n'), sqlite)
})

test('apply leaves personal-org memories, suppressions, and memory vectors with the owner', async () => {
	const { sqlite, db } = await seed()
	sqlite
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id, personal_org_id,
				created_at, updated_at
			) VALUES ('brad', 'brad@example.com', 'hash', 'person-brad', ?, ?, ?)`,
		)
		.run(src, now, now)
	sqlite
		.prepare(
			`INSERT INTO mcp_memories (id, user_id, subject, summary, deleted_at)
			 VALUES ('memory-deleted', ?, 'Old', 'Gone', ?)`,
		)
		.run(src, now)
	sqlite
		.prepare(
			`INSERT INTO mcp_memory_conversation_suppressions (
				user_id, conversation_id, memory_id, expires_at
			) VALUES
				(?, 'conv-live', 'memory-1', ?),
				(?, 'conv-old', 'memory-deleted', ?)`,
		)
		.run(src, now, src, now)
	const memoryVectorId = buildLengthSafeVectorId({
		prefix: 'memory',
		rawId: 'memory-1',
	})
	const packageVectorId = buildLengthSafeVectorId({
		prefix: 'package',
		rawId: pkgA,
	})
	sqlite
		.prepare(
			`INSERT INTO vector_embed_fingerprints (
				user_id, vector_id, content_hash, updated_at
			) VALUES (?, ?, 'mem-hash', ?), (?, ?, 'pkg-hash', ?)`,
		)
		.run(src, memoryVectorId, now, src, packageVectorId, now)
	expect(await isPersonalOrg(db, src)).toBe(true)
	expect(await isPersonalOrg(db, dst)).toBe(false)

	const dryRun = await runOrgResourceTransfer({
		db,
		effects: createEffects({ db, calls: [], backups: [] }),
		actorUserId: 'person-admin',
		fromOrgId: src,
		toOrgId: dst,
		mode: 'dry-run',
		skipOrphans: true,
	})
	expect(dryRun.outcome).toBe('planned')
	expect(dryRun.summary.kept).toEqual({
		memories: { count: 1, note: orgTransferMemoriesStayNote },
	})
	expect(
		dryRun.summary.orphans.some((orphan) =>
			orphan.table.startsWith('mcp_memory'),
		),
	).toBe(false)

	const backups: Array<string> = []
	const result = await runOrgResourceTransfer({
		db,
		effects: createEffects({
			db,
			calls: [],
			backups,
			overrides: {
				afterCommit: async ({ plan, cleanupOrphans }) => {
					expect(plan.moves).not.toHaveProperty('mcp_memories')
					expect(plan.moves).not.toHaveProperty(
						'mcp_memory_conversation_suppressions',
					)
					expect(
						plan.orphans.some((orphan) =>
							orphan.table.startsWith('mcp_memory'),
						),
					).toBe(false)
					expect(
						plan.derivedDeletes.vector_embed_fingerprints.map(
							(row) => row['vector_id'],
						),
					).toEqual([packageVectorId])
					return runOrgTransferPostCommit({
						env: { APP_DB: db } as Env,
						baseUrl: 'https://heykody.dev',
						plan,
						cleanupOrphans,
					})
				},
			},
		}),
		actorUserId: 'person-admin',
		fromOrgId: src,
		toOrgId: dst,
		mode: 'apply',
		skipOrphans: true,
	})

	expect(result.outcome).toBe('applied')
	expect(result.summary.kept).toEqual({
		memories: { count: 1, note: orgTransferMemoriesStayNote },
	})
	expect(result.leftovers).not.toHaveProperty('mcp_memories')
	expect(result.leftovers).not.toHaveProperty(
		'mcp_memory_conversation_suppressions',
	)
	expect(
		result.postCommitWarnings.some((warning) =>
			`${warning.subject ?? ''} ${warning.message}`.includes('reindex memory'),
		),
	).toBe(false)
	expect(memoryVectorMock.deleteMemoryVector).not.toHaveBeenCalled()
	expect(memoryVectorMock.upsertMemoryVector).not.toHaveBeenCalled()
	expect(
		sqlite
			.prepare(`SELECT id, user_id, deleted_at FROM mcp_memories ORDER BY id`)
			.all(),
	).toEqual([
		{ id: 'memory-1', user_id: src, deleted_at: null },
		{ id: 'memory-deleted', user_id: src, deleted_at: now },
	])
	expect(
		sqlite
			.prepare(
				`SELECT user_id, conversation_id, memory_id
				 FROM mcp_memory_conversation_suppressions
				 ORDER BY conversation_id`,
			)
			.all(),
	).toEqual([
		{ user_id: src, conversation_id: 'conv-live', memory_id: 'memory-1' },
		{
			user_id: src,
			conversation_id: 'conv-old',
			memory_id: 'memory-deleted',
		},
	])
	expect(
		sqlite
			.prepare(
				`SELECT user_id, vector_id FROM vector_embed_fingerprints ORDER BY vector_id`,
			)
			.all(),
	).toEqual([{ user_id: src, vector_id: memoryVectorId }])
	expect(backups).toHaveLength(1)
	expect(backups[0]).not.toContain('Prefers tea')
	expect(backups[0]).not.toContain(memoryVectorId)
})

test('a failure before commit undoes side copies and leaves APP_DB unchanged', async () => {
	const { sqlite, db } = await seed()
	const jobId = buildPackageJobId(pkgA, 'nightly')
	jobsMock.jobs = [packageJob(pkgA, 'nightly', 'src-alpha')]
	const calls: Calls = []
	const before = dumpOwnedRows(sqlite)
	const effects = createEffects({
		db,
		calls,
		backups: [],
		overrides: {
			planAudit: () => ({
				// Fails inside the batch, after every side copy is done.
				statements: [db.prepare(`INSERT INTO no_such_table VALUES (1)`)],
				deliver: async () => {},
			}),
		},
	})
	const result = await runOrgResourceTransfer({
		db,
		effects,
		actorUserId: 'person-admin',
		fromOrgId: src,
		toOrgId: dst,
		mode: 'apply',
		skipOrphans: true,
	})
	expect(result.outcome).toBe('failed')
	expect(result.applied).toBe(false)
	expect(result.failure).toEqual({
		committed: false,
		failed_step: 'commit',
		backup_key: expect.stringMatching(/^org-resource-transfers\//),
		message: expect.stringContaining('no_such_table'),
	})
	expect(calls).toContain(`backup:${result.failure?.backup_key}`)
	expect(result.backupKey).toBe(result.failure?.backup_key)
	expect(dumpOwnedRows(sqlite)).toEqual(before)
	const undo = calls.slice(calls.indexOf(`transferJobs:${src}->${dst}:1`) + 1)
	expect(undo).toEqual([
		`transferJobs:${dst}->${src}:1`,
		`discardMcp:${dst}:server-1`,
		`clearStorage:${dst}:job:${jobId}`,
		`clearStorage:${dst}:package:${pkgC}`,
		`clearStorage:${dst}:package:${pkgB}`,
		`clearStorage:${dst}:package:${pkgA}`,
		`deleteLogo:user-oauth-app-logos/${dst}/myapp.png`,
	])
	expectNoSecretMaterial(JSON.stringify(result), sqlite)
})

test('a failed backup write still names the backup key it tried', async () => {
	const { db } = await seed()
	const calls: Calls = []
	const result = await runOrgResourceTransfer({
		db,
		effects: createEffects({
			db,
			calls,
			backups: [],
			overrides: {
				writeBackup: async () => {
					throw new Error('Org transfer backup did not verify.')
				},
			},
		}),
		actorUserId: 'person-admin',
		fromOrgId: src,
		toOrgId: dst,
		mode: 'apply',
		skipOrphans: true,
	})
	expect(result.failure).toEqual({
		committed: false,
		failed_step: 'backup',
		backup_key: expect.stringMatching(
			new RegExp(`^org-resource-transfers/${src}/${dst}/`),
		),
		message: 'Org transfer backup did not verify.',
	})
	expect(calls.filter((call) => !call.startsWith('lease:'))).toEqual([])
})

test('a compensation that fails is reported as failed_undo', async () => {
	const { db } = await seed()
	const result = await runOrgResourceTransfer({
		db,
		effects: createEffects({
			db,
			calls: [],
			backups: [],
			overrides: {
				importMcpServer: async () => ({
					ok: false,
					reason: 'already_registered',
				}),
				clearStorage: async ({ storageId }) => {
					if (storageId === `package:${pkgB}`) {
						throw new Error('storage runner unavailable')
					}
				},
			},
		}),
		actorUserId: 'person-admin',
		fromOrgId: src,
		toOrgId: dst,
		mode: 'apply',
		skipOrphans: true,
	})
	expect(result.outcome).toBe('failed')
	expect(result.failure).toEqual({
		committed: false,
		failed_step: 'mcp_import',
		failed_undo: [`storage package:${pkgB}`],
		backup_key: expect.any(String),
		message: 'MCP server linear could not move: already_registered.',
	})
})

test('a storage copy failure part way stops before any later step', async () => {
	const { sqlite, db } = await seed()
	const calls: Calls = []
	const before = dumpOwnedRows(sqlite)
	const result = await runOrgResourceTransfer({
		db,
		effects: createEffects({
			db,
			calls,
			backups: [],
			overrides: {
				copyStorage: async () => {
					throw new Error('Storage package:x copy did not verify.')
				},
			},
		}),
		actorUserId: 'person-admin',
		fromOrgId: src,
		toOrgId: dst,
		mode: 'apply',
		skipOrphans: true,
	})
	expect(result.failure).toMatchObject({
		committed: false,
		failed_step: 'storage_copy',
		message: 'Storage package:x copy did not verify.',
	})
	expect(result.failure).not.toHaveProperty('failed_undo')
	expect(dumpOwnedRows(sqlite)).toEqual(before)
	expect(calls.some((call) => call.startsWith('importMcp'))).toBe(false)
	expect(calls).toContain(`clearStorage:${dst}:package:${pkgA}`)
	expect(calls).toContain(`deleteLogo:user-oauth-app-logos/${dst}/myapp.png`)
})

test('a target storage that already holds data is a clash and is never cleared', async () => {
	const { db } = await seed()
	const fullTarget = `package:${pkgB}`
	const isStorageEmpty = async ({ storageId }: { storageId: string }) =>
		storageId !== fullTarget

	const dryRun = await runOrgResourceTransfer({
		db,
		effects: createEffects({
			db,
			calls: [],
			backups: [],
			overrides: { isStorageEmpty },
		}),
		actorUserId: 'person-admin',
		fromOrgId: src,
		toOrgId: dst,
		mode: 'dry-run',
		skipOrphans: true,
	})
	expect(dryRun.summary.clashes).toEqual([
		{
			code: 'target_storage_not_empty',
			message: `storage: ${fullTarget} already holds data in @haveman`,
			table: 'user_storage_buckets',
			subject: fullTarget,
		},
	])

	const calls: Calls = []
	const refused = await runOrgResourceTransfer({
		db,
		effects: createEffects({
			db,
			calls,
			backups: [],
			overrides: { isStorageEmpty },
		}),
		actorUserId: 'person-admin',
		fromOrgId: src,
		toOrgId: dst,
		mode: 'apply',
		skipOrphans: true,
	})
	expect(refused.outcome).toBe('refused')
	expect(refused.refusals.map((finding) => finding.code)).toEqual([
		'target_storage_not_empty',
	])
	expect(calls.filter((call) => !call.startsWith('lease:'))).toEqual([])

	// Filled between the check and the copy: the copy refuses before writing,
	// so only the copies that did write are undone.
	const raceCalls: Calls = []
	const raced = await runOrgResourceTransfer({
		db,
		effects: createEffects({
			db,
			calls: raceCalls,
			backups: [],
			overrides: {
				copyStorage: async ({ storageId }) => {
					raceCalls.push(`copyStorage:${storageId}`)
					if (storageId === fullTarget) {
						throw new OrgTransferStorageNotEmptyError(
							`Target storage ${storageId} is not empty.`,
						)
					}
					return { storageId, kvEntries: 0, sqlRows: {} }
				},
			},
		}),
		actorUserId: 'person-admin',
		fromOrgId: src,
		toOrgId: dst,
		mode: 'apply',
		skipOrphans: true,
	})
	expect(raced.failure).toMatchObject({
		failed_step: 'storage_copy',
		message: `Target storage ${fullTarget} is not empty.`,
	})
	expect(raceCalls).toContain(`clearStorage:${dst}:package:${pkgA}`)
	expect(raceCalls).not.toContain(`clearStorage:${dst}:${fullTarget}`)
})

test('MCP servers missing from the source hub block and ids taken in the target hub clash', async () => {
	const { db } = await seed()
	hubMock.serverIds = { [dst]: ['server-1'] }
	const result = await runOrgResourceTransfer({
		db,
		effects: createEffects({ db, calls: [], backups: [] }),
		actorUserId: 'person-admin',
		fromOrgId: src,
		toOrgId: dst,
		mode: 'dry-run',
		skipOrphans: true,
	})
	expect(result.summary.blockers).toContainEqual({
		code: 'source_hub_missing_mcp_server',
		message:
			"MCP server linear has no connection in @bradhave's hub; reconnect or remove it first.",
		table: 'mcp_server_settings',
		subject: 'linear',
	})
	expect(result.summary.clashes).toContainEqual({
		code: 'target_hub_has_mcp_server',
		message:
			"mcp_server_settings: server id of linear is already registered in @haveman's hub",
		table: 'mcp_server_settings',
		subject: 'linear',
	})
})

test('a post-commit failure still returns the committed result and backup key', async () => {
	const { sqlite, db } = await seed()
	const result = await runOrgResourceTransfer({
		db,
		effects: createEffects({
			db,
			calls: [],
			backups: [],
			overrides: {
				afterCommit: async () => {
					throw new Error('hub stub exploded')
				},
			},
		}),
		actorUserId: 'person-admin',
		fromOrgId: src,
		toOrgId: dst,
		mode: 'apply',
		skipOrphans: true,
	})
	expect(result.applied).toBe(true)
	expect(result.backupKey).not.toBeNull()
	expect(result.outcome).toBe('applied')
	expect(result.postCommitWarnings).toEqual([
		{
			code: 'post_commit_step_failed',
			message: 'post-commit: hub stub exploded',
			subject: 'post-commit',
		},
	])
	expect(result.mcpConnections).toEqual([])
	expect(
		sqlite.prepare(`SELECT DISTINCT user_id FROM saved_packages`).all(),
	).toEqual([{ user_id: dst }])
})

test('apply clears search-index debt only for the packages it moves', async () => {
	const { sqlite, db } = await seed()
	for (const packageId of [pkgA, 'debt-of-another-package']) {
		sqlite
			.prepare(
				`INSERT INTO saved_package_search_index_debt (package_id, user_id, embed_text, created_at, updated_at)
				 VALUES (?, ?, 'text', ?, ?)`,
			)
			.run(packageId, src, now, now)
	}
	const result = await runOrgResourceTransfer({
		db,
		effects: createEffects({ db, calls: [], backups: [] }),
		actorUserId: 'person-admin',
		fromOrgId: src,
		toOrgId: dst,
		mode: 'apply',
		skipOrphans: true,
	})
	expect(result.applied).toBe(true)
	expect(
		sqlite
			.prepare(
				`SELECT package_id, user_id FROM saved_package_search_index_debt`,
			)
			.all(),
	).toEqual([{ package_id: 'debt-of-another-package', user_id: src }])
})

test('a ciphertext that does not open fails with a generic message before any write', async () => {
	const { sqlite, db } = await seed()
	sqlite
		.prepare(
			`UPDATE secret_entries SET encrypted_value = ? WHERE name = 'API_KEY'`,
		)
		.run(
			await encryptSecretValue(
				env,
				plaintexts.userSecret,
				userSecretContext(dst),
			),
		)
	const calls: Calls = []
	const before = dumpOwnedRows(sqlite)
	const result = await runOrgResourceTransfer({
		db,
		effects: createEffects({ db, calls, backups: [] }),
		actorUserId: 'person-admin',
		fromOrgId: src,
		toOrgId: dst,
		mode: 'apply',
		skipOrphans: true,
	})
	expect(result.failure).toEqual({
		committed: false,
		failed_step: 'reseal',
		backup_key: null,
		message: 'Could not re-seal encrypted_value for secret API_KEY.',
	})
	expect(calls.filter((call) => !call.startsWith('lease:'))).toEqual([])
	expect(dumpOwnedRows(sqlite)).toEqual(before)
	expectNoSecretMaterial(JSON.stringify(result), sqlite)
})

test('transfer refuses the same org, a missing org, and a suspended org', async () => {
	const { sqlite, db } = await seed()
	const effects = createEffects({ db, calls: [], backups: [] })
	const base = {
		db,
		effects,
		actorUserId: 'person-admin',
		mode: 'dry-run' as const,
		skipOrphans: false,
	}
	await expect(
		runOrgResourceTransfer({ ...base, fromOrgId: src, toOrgId: src }),
	).rejects.toThrow('Source and target org are the same.')
	await expect(
		runOrgResourceTransfer({ ...base, fromOrgId: src, toOrgId: 'nope' }),
	).rejects.toThrow('The target org nope is not live.')
	sqlite.prepare(`UPDATE orgs SET suspended_at = ? WHERE id = ?`).run(now, dst)
	await expect(
		runOrgResourceTransfer({ ...base, fromOrgId: src, toOrgId: dst }),
	).rejects.toThrow('The target org @haveman is suspended.')
})

test('apply refuses with plan_drifted when the plan changed since the reviewed dry-run', async () => {
	const { sqlite, db } = await seed()
	const base = {
		db,
		actorUserId: 'person-admin',
		fromOrgId: src,
		toOrgId: dst,
		skipOrphans: true,
	}
	const first = await runOrgResourceTransfer({
		...base,
		effects: createEffects({ db, calls: [], backups: [] }),
		mode: 'dry-run',
	})
	const again = await runOrgResourceTransfer({
		...base,
		effects: createEffects({ db, calls: [], backups: [] }),
		mode: 'dry-run',
	})
	expect(again.fingerprint).toBe(first.fingerprint)

	sqlite
		.prepare(
			`INSERT INTO secret_entries (bucket_id, name, encrypted_value) VALUES ('bucket-user', 'LATE_KEY', ?)`,
		)
		.run(
			await encryptSecretValue(env, 'late-plaintext', userSecretContext(src)),
		)
	const before = dumpOwnedRows(sqlite)
	const calls: Calls = []
	const drifted = await runOrgResourceTransfer({
		...base,
		effects: createEffects({ db, calls, backups: [] }),
		mode: 'apply',
		expectedFingerprint: first.fingerprint,
	})
	expect(drifted.outcome).toBe('refused')
	expect(drifted.fingerprint).not.toBe(first.fingerprint)
	expect(drifted.refusals).toEqual([
		{
			code: 'plan_drifted',
			message: expect.stringContaining(first.fingerprint),
		},
	])
	expect(calls.filter((call) => !call.startsWith('lease:'))).toEqual([])
	expect(dumpOwnedRows(sqlite)).toEqual(before)

	const applied = await runOrgResourceTransfer({
		...base,
		effects: createEffects({ db, calls: [], backups: [] }),
		mode: 'apply',
		expectedFingerprint: drifted.fingerprint,
	})
	expect(applied.outcome).toBe('applied')
	expect(applied.fingerprint).toBe(drifted.fingerprint)
})

test('an enabler outside the target org blocks with a coded finding', async () => {
	const { sqlite, db } = await seed()
	insertEnablement(sqlite, { id: 'enablement-1', enabler: 'person-outsider' })
	const result = await runOrgResourceTransfer({
		db,
		effects: createEffects({ db, calls: [], backups: [] }),
		actorUserId: 'person-admin',
		fromOrgId: src,
		toOrgId: dst,
		mode: 'dry-run',
		skipOrphans: true,
	})
	expect(result.summary.enablements).toEqual([
		expect.objectContaining({
			enabler_user_id: 'person-outsider',
			enabler_is_target_member: false,
		}),
	])
	expect(result.refusals).toEqual([
		{
			code: 'enabler_not_target_member',
			message:
				'Enablement webhook:ping of alpha is enabled by person-outsider, who is not a member of @haveman.',
			table: 'enablements',
			subject: 'alpha webhook:ping',
		},
	])
})

test('a source credential granted to another org as a personal credential blocks', async () => {
	const { sqlite, db } = await seed()
	const entry = sqlite
		.prepare(`SELECT id FROM secret_entries WHERE name = 'API_KEY'`)
		.get() as { id: string }
	sqlite
		.prepare(
			`INSERT INTO credential_org_grants (credential_id, user_id, org_id, created_at) VALUES (?, ?, ?, ?)`,
		)
		.run(entry.id, src, 'org-elsewhere', now)
	const result = await runOrgResourceTransfer({
		db,
		effects: createEffects({ db, calls: [], backups: [] }),
		actorUserId: 'person-admin',
		fromOrgId: src,
		toOrgId: dst,
		mode: 'dry-run',
		skipOrphans: true,
	})
	expect(result.refusals).toEqual([
		{
			code: 'personal_credential_granted_to_org',
			message:
				'secret_entries API_KEY is granted to other orgs as a personal credential; revoke those grants before transferring.',
			table: 'secret_entries',
			subject: entry.id,
		},
	])
})
