import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { quoteSqlIdentifier } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import {
	AccountDeletionCleanupError,
	deleteUserAccount,
	getAccountDeletionD1UserColumnCoverage,
} from './account-deletion.ts'
import {
	accountUserDataExcludedOwnerIds,
	accountUserDataPendingDropTables,
} from '#worker/account/data-targets.ts'
import { jobVectorId } from '#mcp/jobs-vectorize.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { createMemoryKvNamespace } from '#worker/test-support/memory-kv.ts'
import {
	insertRepoSession,
	listRepoSessionsByUser,
} from '#worker/repo/repo-sessions.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { accountUserOwnedVectorizeSurfaces } from '#worker/account/user-owned-surfaces.ts'
import {
	createTestDb,
	createJobsBindingStub,
	createSuccessfulDeletionEnv,
} from '#worker/test-support/account-deletion.ts'

const appMigrationsDir = new URL('../../migrations/', import.meta.url)
const idFromName = (name: string) => name as unknown as DurableObjectId

function migratedAppDb() {
	const db = new DatabaseSync(':memory:')
	applyAllMigrations(db, appMigrationsDir)
	return db
}

test('deleteUserAccount enumerates job vectors through JOBS against the real post-0010 APP_DB schema', async () => {
	const sqlite = migratedAppDb()
	const db = createD1FromSqlite(sqlite)
	const userId = ownerIdFromStored('user-post-0010')
	const inserted = await db
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id,
				email_verified_at, created_at
			) VALUES ('post0010', 'post0010@example.com', 'hash', ?, ?, ?)`,
		)
		.bind(userId, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
		.run()
	const dbUserId = Number(inserted.meta.last_row_id)
	await db
		.prepare(
			`INSERT INTO mcp_memories (id, user_id, subject, summary)
			VALUES ('mem-post-0010', ?, 'subject', 'summary')`,
		)
		.bind(userId)
		.run()

	const deleteVectorsMock = vi.fn(async () => undefined)
	const listJobIdsForUser = vi.fn(async (_input: { userId: string }) => [
		'job-live-1',
		'job-live-2',
	])
	const purgeJobsUser = vi.fn(async (input: { userId: string }) => ({
		ok: true as const,
		userId: input.userId,
		purged: true,
	}))
	const env = createSuccessfulDeletionEnv(db, {
		CAPABILITY_VECTOR_INDEX: { deleteByIds: deleteVectorsMock },
		JOBS: {
			listJobIdsForUser,
			listJobStorageIdsForUser: async () => [] as Array<string>,
			purgeUser: purgeJobsUser,
		},
	})

	const result = await deleteUserAccount({ env, dbUserId, mcpUserId: userId })

	expect(listJobIdsForUser).toHaveBeenCalledWith({ userId })
	expect(deleteVectorsMock).toHaveBeenCalledWith([
		'memory_mem-post-0010',
		jobVectorId('job-live-1'),
		jobVectorId('job-live-2'),
	])
	expect(result.deletedVectors).toBe(3)
	expect(purgeJobsUser).toHaveBeenCalledWith({ userId })
	expect(result.warnings).toEqual([])
	const count = (table: string) =>
		sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()
	expect(count('users')).toEqual({ count: 0 })
	expect(count('mcp_memories')).toEqual({ count: 0 })
})

test('account deletion preserves operator-owned system email configuration', async () => {
	expect(accountUserDataExcludedOwnerIds.map((e) => e.ownerId)).toContain(
		'system:email',
	)

	const { db, rows } = createTestDb({
		users: [{ id: 1, email: 'user@example.com' }],
		email_inboxes: [
			{ id: 'user-inbox', user_id: ownerIdFromStored('user-aaa') },
			{ id: 'system-inbox', user_id: ownerIdFromStored('system:email') },
		],
		email_inbox_addresses: [
			{ id: 'user-address', user_id: ownerIdFromStored('user-aaa') },
			{ id: 'system-address', user_id: ownerIdFromStored('system:email') },
		],
	})

	await deleteUserAccount({
		env: createSuccessfulDeletionEnv(db),
		dbUserId: 1,
		mcpUserId: ownerIdFromStored('user-aaa'),
	})

	expect(rows.email_inboxes).toEqual([
		{ id: 'system-inbox', user_id: ownerIdFromStored('system:email') },
	])
	expect(rows.email_inbox_addresses).toEqual([
		{ id: 'system-address', user_id: ownerIdFromStored('system:email') },
	])
})

test('deleteUserAccount cascades user-scoped rows for the requested user', async () => {
	const userAaa = ownerIdFromStored('user-aaa')
	const userBbb = 'user-bbb'
	const packageJobId =
		'package-job:b2fda105-005a-4e2b-9f22-1513b6752da2:event-runner'
	const submitters = {
		[userAaa]: {
			submitter_username: 'user-a',
			submitter_email: 'a@example.com',
		},
		[userBbb]: {
			submitter_username: 'user-b',
			submitter_email: 'b@example.com',
		},
	}
	const feedback = (
		id: string,
		submitter: keyof typeof submitters,
		reviewer: string,
		adminNote: string,
	) => ({
		id,
		submitter_user_id: submitter,
		...submitters[submitter],
		reviewed_by_user_id: reviewer,
		reviewed_at: '2026-07-05',
		admin_note: adminNote,
	})
	const codemodRun = (
		id: string,
		mode: string,
		scope: string | null,
		initiatedBy: string,
		filterUserIds: Array<string>,
	) => ({
		id,
		codemod_id: '0001-ambient-storage-to-package-storage',
		mode,
		scope_user_id: scope,
		initiated_by_user_id: initiatedBy,
		filters_json: JSON.stringify({ userIds: filterUserIds }),
		status: 'completed',
	})
	const codemodItem = (id: string, run: string, user: string, pkg: string) => ({
		id,
		run_id: run,
		user_id: user,
		package_id: pkg,
		kody_id: user === userAaa ? 'demo' : 'demo-b',
		status: 'applied',
	})
	const { db, rows } = createTestDb({
		users: [
			{
				id: 1,
				email: 'a@example.com',
				avatar_key: 'user-avatars/user-aaa/abc123.png',
			},
			{ id: 2, email: 'b@example.com' },
		],
		jobs: [
			{ id: 'job-1', user_id: userAaa, storage_id: 'job:job-1' },
			{ id: 'job-2', user_id: userAaa, storage_id: null },
			{ id: packageJobId, user_id: userAaa, storage_id: null },
			{ id: 'job-3', user_id: userBbb, storage_id: 'job:job-3' },
		],
		user_storage_buckets: [
			{ user_id: userAaa, storage_id: 'exec:run-2', kind: 'execute' },
			{
				user_id: userAaa,
				storage_id: 'repo-session:rs-1',
				kind: 'repo_session',
			},
			{ user_id: userBbb, storage_id: 'package:pkg-2', kind: 'package' },
		],
		mcp_memories: [
			{ id: 'mem-1', user_id: userAaa },
			{ id: 'mem-2', user_id: userBbb },
		],
		secret_buckets: [{ id: 'sb-1', user_id: userAaa }],
		secret_entries: [
			{ bucket_id: 'sb-1', name: 's', user_id: ownerIdFromStored('unused') },
		],
		mcp_agent_sessions: [
			{ do_id: 'do-user-a', user_id: userAaa },
			{ do_id: 'do-user-b', user_id: userBbb },
		],
		saved_packages: [
			{
				id: 'pkg-1',
				user_id: userAaa,
				kody_id: 'demo',
				source_id: 'src-1',
				has_app: 1,
			},
			{
				id: 'pkg-2',
				user_id: userBbb,
				kody_id: 'other',
				source_id: 'src-2',
				has_app: 0,
			},
		],
		published_bundle_artifacts: [
			{ id: 'pba-1', user_id: userAaa, kv_key: 'bundle-artifact:v1:src-1' },
			{ id: 'pba-2', user_id: userBbb, kv_key: 'bundle-artifact:v1:src-2' },
		],
		entity_sources: [
			{
				id: 'src-1',
				user_id: userAaa,
				repo_id: 'repo-src-1',
				published_commit: 'abc123',
			},
			{
				id: 'src-2',
				user_id: userBbb,
				repo_id: 'repo-src-2',
				published_commit: 'def456',
			},
		],
		password_resets: [
			{ id: 1, user_id: 1 },
			{ id: 2, user_id: 1 },
			{ id: 3, user_id: 2 },
		],
		user_roles: [
			{ user_id: 1, role_id: 1 },
			{ user_id: 2, role_id: 2 },
		],
		passkeys: [
			{ id: 'pk-1', user_id: 1 },
			{ id: 'pk-2', user_id: 2 },
		],
		verifications: [
			{ id: 1, type: '2fa', target: '1' },
			{ id: 2, type: '2fa', target: '2' },
		],
		mcp_user_server_instructions: [{ user_id: userAaa }],
		agent_package_conversation_uses: [
			{ user_id: userAaa, package_id: 'pkg-1', conversation_id: 'conv-1' },
		],
		mcp_memory_conversation_suppressions: [
			{ user_id: userAaa, conversation_id: 'c1', memory_id: 'mem-1' },
		],
		email_inboxes: [{ id: 'in-1', user_id: userAaa }],
		email_inbox_addresses: [{ id: 'ia-1', user_id: userAaa }],
		email_sender_identities: [{ id: 'ei-1', user_id: userAaa }],
		platform_feedback: [
			feedback('feedback-submitted-by-a', userAaa, userBbb, 'Reviewed by B.'),
			feedback(
				'feedback-reviewed-by-a',
				userBbb,
				userAaa,
				'Private admin note from A.',
			),
			feedback('feedback-unrelated', userBbb, userBbb, 'Reviewed by B.'),
		],
		community_listings: [
			{
				id: 'listing-1',
				owner_user_id: userAaa,
				pinned_commit: 'commit-1',
				source_id: 'src-1',
			},
			{ id: 'listing-2', owner_user_id: userBbb, pinned_commit: 'commit-2' },
		],
		community_forks: [
			{ id: 'fork-1', listing_id: 'listing-1', forker_user_id: userBbb },
			{ id: 'fork-2', listing_id: 'listing-2', forker_user_id: userAaa },
			{ id: 'fork-3', listing_id: 'listing-2', forker_user_id: userBbb },
		],
		community_ratings: [
			{ id: 'rating-1', listing_id: 'listing-1', user_id: userBbb },
			{ id: 'rating-2', listing_id: 'listing-2', user_id: userAaa },
			{ id: 'rating-3', listing_id: 'listing-2', user_id: userBbb },
		],
		community_activity_events: [
			['evt-1', userAaa, 'listing_published', 'listing-2'],
			['evt-2', userBbb, 'listing_updated', 'listing-1'],
			['evt-3', userBbb, 'listing_published', 'listing-2'],
		].map(([id, actor_user_id, event_type, listing_id]) => ({
			id,
			actor_user_id,
			event_type,
			listing_id,
		})),
		community_reports: [
			['report-1', 'listing-1', userAaa, userBbb, null],
			['report-2', 'listing-2', userBbb, userAaa, null],
			['report-3', 'listing-2', userBbb, userBbb, userAaa],
		].map(([id, listing_id, owner, reporter, resolver]) => ({
			id,
			listing_id,
			listing_owner_user_id: owner,
			reporter_user_id: reporter,
			resolved_by_user_id: resolver,
		})),
		community_bans: [
			{ user_id: userAaa, banned_by_user_id: userBbb },
			{ user_id: userBbb, banned_by_user_id: userAaa },
		],
		package_codemod_run_items: [
			codemodItem('codemod-item-1', 'codemod-run-1', userAaa, 'pkg-1'),
			codemodItem('codemod-item-2', 'codemod-run-2', userBbb, 'pkg-2'),
		],
		package_codemod_runs: [
			codemodRun('codemod-run-1', 'apply', userAaa, userAaa, [
				userAaa,
				userBbb,
			]),
			codemodRun('codemod-run-fleet', 'scan', null, userBbb, [userAaa]),
			codemodRun('codemod-run-2', 'apply', userBbb, userBbb, [userBbb]),
		],
	})

	const deletedKvKeys: Array<string> = []
	const kvStoreKeys = [
		'source-snapshot:v1:src-1:abc123',
		'source-manifest-snapshot:v1:src-1:abc123',
		'source-snapshot:v1:src-1:old456',
		'source-manifest-snapshot:v1:src-1:old456',
		'credential-needs:v1:src-1:old456',
		'credential-stamp:v1:src-1:abc123',
		'credential-stamp:v1:src-1:old456',
		'derived-cache:v1:community-icon:v1:listing-1:commit-1',
		'derived-cache:v1:community-icon:v1:listing-1:abc123',
		'derived-cache:v1:community-icon:v1:listing-1:historical',
		'derived-cache:v1:community-icon:v2:listing-1:commit-1',
		'derived-cache:v1:community-icon:v2:listing-1:abc123',
		'derived-cache:v1:community-icon:v3:listing-1:commit-1',
		'derived-cache:v1:community-icon:v3:listing-1:abc123',
		'derived-cache:v1:identity-icon:v1:repo-src-1:abc123',
		'derived-cache:v1:identity-icon:v1:repo-src-1:old',
		'source-snapshot:v1:src-2:def456',
		`package-codemod-revert:${userAaa}:item-1`,
		`package-codemod-revert:${userAaa}:item-2`,
		`package-codemod-revert:${userBbb}:item-other`,
		`derived-cache:v1:mcp-oauth-refresh-family:${userAaa}:grant-1`,
		`derived-cache:v1:mcp-oauth-refresh-replay:${userAaa}:grant-1:hash-1`,
		`derived-cache:v1:mcp-oauth-refresh-family:${userBbb}:grant-9`,
		'platform-settings:v1:reserved-usernames',
		// Leftover unused platform KV key. App code no longer reads or writes
		// it; account deletion still must leave platform keys alone.
		'platform-settings:v1:signup-mode',
	]
	const kv = {
		async get(key: string) {
			return kvStoreKeys.includes(key) ? '{}' : null
		},
		async delete(key: string) {
			deletedKvKeys.push(key)
		},
		async list(options?: { prefix?: string; cursor?: string }) {
			const prefix = options?.prefix ?? ''
			const matchingKeys = kvStoreKeys
				.filter((key) => key.startsWith(prefix))
				.sort()
			// Page one key at a time for this prefix to exercise cursors.
			if (prefix === 'derived-cache:v1:community-icon:v1:listing-1:') {
				const start = options?.cursor
					? Number(options.cursor.replace('icon-page-', '')) - 1
					: 0
				const page = matchingKeys.slice(start, start + 1)
				const more = start + page.length < matchingKeys.length
				return {
					keys: page.map((name) => ({ name })),
					list_complete: !more,
					...(more ? { cursor: `icon-page-${start + 2}` } : {}),
				}
			}
			return {
				keys: matchingKeys.map((name) => ({ name })),
				list_complete: true,
				cursor: undefined,
			}
		},
	}

	const deletedEmailBlobKeys: Array<string> = []
	const mailboxCleanupOrder: Array<string> = []
	const emailBlobKeys = new Set([
		'email-raw:v1:user-aaa/em-1',
		'email-raw:v1:user-aaa/em-2',
		'email-raw:v1:user-bbb/em-3',
	])
	const emailBlobs = {
		async list(options?: { prefix?: string }) {
			return {
				objects: [...emailBlobKeys]
					.filter((key) => key.startsWith(options?.prefix ?? ''))
					.map((key) => ({ key })),
				delimitedPrefixes: [],
				truncated: false as const,
			}
		},
		async delete(keys: string | Array<string>) {
			mailboxCleanupOrder.push('delete-email-blob')
			for (const key of Array.isArray(keys) ? keys : [keys]) {
				deletedEmailBlobKeys.push(key)
				emailBlobKeys.delete(key)
			}
		},
	}
	const deletedCommunityAssetKeys: Array<string> = []
	const communityAssetKeys = new Set([
		'user-avatars/user-aaa/abc123.png',
		'user-avatars/user-aaa/old.png',
		'user-avatars/user-bbb/other.png',
		'community-icon:v1/listing-1/abc123/asset',
		'community-icon:v1/listing-1/commit-1/asset',
		'community-icon:v1/listing-1/historical/asset',
		'community-icon:v2/listing-1/abc123/asset',
		'community-icon:v2/listing-1/commit-1/asset',
		'community-icon:v1/listing-2/other/asset',
		'identity-icon:v1/repo-src-1/abc123/asset',
		'identity-icon:v1/repo-src-1/old/asset',
		'identity-icon:v1/repo-src-2/def456/asset',
	])
	const communityAssets = {
		async list(options?: { prefix?: string; cursor?: string }) {
			const matching = [...communityAssetKeys]
				.filter(
					(key) =>
						key.startsWith(options?.prefix ?? '') &&
						(!options?.cursor || key > options.cursor),
				)
				.sort()
			const page = matching.slice(0, 1)
			return {
				objects: page.map((key) => ({ key })),
				delimitedPrefixes: [],
				...(matching.length > page.length
					? { truncated: true as const, cursor: page[0]! }
					: { truncated: false as const }),
			}
		},
		async delete(keys: string | Array<string>) {
			for (const key of Array.isArray(keys) ? keys : [keys]) {
				deletedCommunityAssetKeys.push(key)
				communityAssetKeys.delete(key)
			}
		},
	}

	const clearStorageMock = vi.fn(async () => ({ ok: true as const }))
	const clearRunLogMock = vi.fn(async () => ({ ok: true as const }))
	const purgeUserMeterMock = vi.fn(async () => ({ ok: true as const }))
	const purgeStripePlanRefreshMock = vi.fn(async () => ({ ok: true as const }))
	const stripePlanRefreshIdFromNameMock = vi.fn(idFromName)
	const purgeMailboxMock = vi.fn(async () => {
		mailboxCleanupOrder.push('purge-mailbox')
		return { ok: true as const }
	})
	const listBlobReferencesMock = vi.fn(async () => {
		mailboxCleanupOrder.push('list-blob-references')
		return {
			references: ['em-1', 'em-2'].map((messageId) => ({
				kind: 'raw_mime' as const,
				key: `email-raw:v1:user-aaa/${messageId}`,
				messageId,
				attachmentId: null,
			})),
			nextStartAfter: null,
			truncated: false as const,
		}
	})
	const jobsBindingStub = createJobsBindingStub(db)
	const purgeJobManagerMock = vi.fn((input: { userId: string }) =>
		jobsBindingStub.purgeUser(input),
	)
	const purgeRepoSessionMock = vi.fn(async () => ({ ok: true as const }))
	const purgeMcpClientHubMock = vi.fn(async () => undefined)
	const purgeMcpAgentSessionMock = vi.fn(async () => undefined)
	const doFetchMock = vi.fn(async () => Response.json({ ok: true }))
	const deleteVectorsMock = vi.fn(async () => undefined)
	const userMeter = createInMemoryUserMeterEnv()
	const env = createSuccessfulDeletionEnv(db, {
		BUNDLE_ARTIFACTS_KV: kv,
		COMMUNITY_ASSETS: communityAssets,
		EMAIL_BLOBS: emailBlobs,
		CAPABILITY_VECTOR_INDEX: { deleteByIds: deleteVectorsMock },
		STORAGE_RUNNER: {
			idFromName,
			get: () => ({ clearStorage: clearStorageMock }),
		},
		RUN_LOG: {
			idFromName,
			get: () => ({
				clearAll: clearRunLogMock,
				listStorageIds: async () => [] as Array<string>,
				listWorkflowProjections: async () => ({
					projections: [],
					nextCursor: null,
				}),
			}),
		},
		USER_METER: {
			idFromName: (name: string) => userMeter.env.USER_METER.idFromName(name),
			get: (id: DurableObjectId) => ({
				...userMeter.env.USER_METER.get(id),
				purge: async () => purgeUserMeterMock(),
			}),
		},
		STRIPE_PLAN_REFRESH: {
			idFromName: stripePlanRefreshIdFromNameMock,
			get: () => ({ purgeUser: purgeStripePlanRefreshMock }),
		},
		MAILBOX: {
			idFromName,
			get: () => ({
				listBlobReferences: listBlobReferencesMock,
				purge: purgeMailboxMock,
			}),
		},
		JOBS: createJobsBindingStub(db, {
			purgeUser: purgeJobManagerMock as unknown,
		}),
		REPO_SESSION: {
			idFromName,
			get: () => ({ purgeSession: purgeRepoSessionMock }),
		},
		MCP_CLIENT_HUB: {
			idFromName,
			get: () => ({ purgeForAccountDeletion: purgeMcpClientHubMock }),
		},
		MCP_OBJECT: {
			idFromString: idFromName,
			get: () => ({ purgeForAccountDeletion: purgeMcpAgentSessionMock }),
		},
		PACKAGE_REALTIME_SESSION: {
			idFromName,
			get: () => ({ fetch: doFetchMock }),
		},
	})
	await insertRepoSession(env, {
		id: 'rs-1',
		user_id: userAaa,
		source_id: 'src-1',
		source_repo_id: '',
		session_branch: 'sessions/rs-1',
		source_branch: 'main',
		base_commit: 'abc123',
		source_root: '/',
		conversation_id: null,
		status: 'active',
		expires_at: null,
		last_checkpoint_at: null,
		last_checkpoint_commit: null,
		last_check_run_id: null,
		last_check_tree_hash: null,
		created_at: '2026-07-05T00:00:00.000Z',
		updated_at: '2026-07-05T00:00:00.000Z',
	})

	// password_resets.user_id is the database integer id; the deletion
	// service must use the dbUserId (1) to clear the deleted user's reset
	// tokens while leaving the other user's tokens in place.
	const result = await deleteUserAccount({
		env,
		dbUserId: 1,
		mcpUserId: userAaa,
	})

	// Cross-user data is preserved.
	expect(rows.jobs).toEqual([
		{ id: 'job-3', user_id: userBbb, storage_id: 'job:job-3' },
	])
	expect(rows.mcp_memories).toEqual([{ id: 'mem-2', user_id: userBbb }])
	expect(rows.saved_packages).toEqual([
		{
			id: 'pkg-2',
			user_id: userBbb,
			kody_id: 'other',
			source_id: 'src-2',
			has_app: 0,
		},
	])
	expect(rows.mcp_agent_sessions).toEqual([
		{ do_id: 'do-user-b', user_id: userBbb },
	])
	expect(rows.published_bundle_artifacts).toEqual([
		{ id: 'pba-2', user_id: userBbb, kv_key: 'bundle-artifact:v1:src-2' },
	])
	expect(rows.password_resets).toEqual([{ id: 3, user_id: 2 }])
	expect(rows.user_roles).toEqual([{ user_id: 2, role_id: 2 }])
	expect(rows.passkeys).toEqual([{ id: 'pk-2', user_id: 2 }])
	expect(rows.verifications).toEqual([{ id: 2, type: '2fa', target: '2' }])

	// User-scoped data is removed.
	expect(rows.secret_buckets).toEqual([])
	expect(rows.secret_entries).toEqual([])
	expect(rows.entity_sources).toEqual([
		{
			id: 'src-2',
			user_id: userBbb,
			repo_id: 'repo-src-2',
			published_commit: 'def456',
		},
	])
	await expect(listRepoSessionsByUser(env, userAaa)).resolves.toEqual([])
	expect(deletedEmailBlobKeys.sort()).toEqual([
		'email-raw:v1:user-aaa/em-1',
		'email-raw:v1:user-aaa/em-2',
	])
	// Feedback A reviewed loses its review attribution; A's own submission goes.
	expect(rows.platform_feedback).toEqual([
		{
			...feedback('feedback-reviewed-by-a', userBbb, userAaa, ''),
			reviewed_by_user_id: null,
			reviewed_at: null,
			admin_note: null,
		},
		feedback('feedback-unrelated', userBbb, userBbb, 'Reviewed by B.'),
	])
	expect(rows.user_storage_buckets).toEqual([
		{ user_id: userBbb, storage_id: 'package:pkg-2', kind: 'package' },
	])
	expect(rows.community_listings).toEqual([
		{ id: 'listing-2', owner_user_id: userBbb, pinned_commit: 'commit-2' },
	])
	expect(rows.community_forks).toEqual([
		{ id: 'fork-3', listing_id: 'listing-2', forker_user_id: userBbb },
	])
	expect(rows.community_ratings).toEqual([
		{ id: 'rating-3', listing_id: 'listing-2', user_id: userBbb },
	])
	expect(rows.community_activity_events).toEqual([
		{
			id: 'evt-3',
			actor_user_id: userBbb,
			event_type: 'listing_published',
			listing_id: 'listing-2',
		},
	])
	expect(rows.community_reports).toEqual([
		{
			id: 'report-3',
			listing_id: 'listing-2',
			listing_owner_user_id: userBbb,
			reporter_user_id: userBbb,
			resolved_by_user_id: null,
			resolved_at: null,
			resolution_note: null,
		},
	])
	expect(rows.community_bans).toEqual([
		{ user_id: userBbb, banned_by_user_id: 'deleted-user' },
	])
	expect(rows.package_codemod_run_items).toEqual([
		codemodItem('codemod-item-2', 'codemod-run-2', userBbb, 'pkg-2'),
	])
	// Codemod runs keep their history but no longer name the deleted user.
	expect(rows.package_codemod_runs).toEqual([
		codemodRun('codemod-run-1', 'apply', 'deleted-user', 'deleted-user', [
			'deleted-user',
			userBbb,
		]),
		codemodRun('codemod-run-fleet', 'scan', null, userBbb, ['deleted-user']),
		codemodRun('codemod-run-2', 'apply', userBbb, userBbb, [userBbb]),
	])
	expect(rows.users).toEqual([
		{ id: 2, email: 'b@example.com', stable_user_id: 'user-bbb' },
	])

	// Out-of-band stores for the deleted user were cleared.
	expect(deleteVectorsMock).toHaveBeenCalledWith([
		'memory_mem-1',
		'job_job-1',
		'job_job-2',
		jobVectorId(packageJobId),
		'package_pkg-1',
	])
	expect(clearStorageMock).toHaveBeenCalledTimes(2)
	expect(purgeJobManagerMock).toHaveBeenCalledTimes(1)
	expect(purgeRepoSessionMock).toHaveBeenCalledWith({
		sessionId: 'rs-1',
		userId: userAaa,
	})
	expect(doFetchMock).toHaveBeenCalledTimes(1)

	// Bundle KV keys for the deleted user were removed; the other user's keys
	// and platform settings remain in storage.
	expect(deletedKvKeys.sort()).toEqual([
		'bundle-artifact:v1:src-1',
		'community-snapshot:v1:listing-1',
		'credential-needs:v1:src-1:abc123',
		'credential-needs:v1:src-1:old456',
		'credential-stamp:v1:src-1:abc123',
		'credential-stamp:v1:src-1:old456',
		'derived-cache:v1:community-icon:v1:listing-1:abc123',
		'derived-cache:v1:community-icon:v1:listing-1:commit-1',
		'derived-cache:v1:community-icon:v1:listing-1:historical',
		'derived-cache:v1:community-icon:v2:listing-1:abc123',
		'derived-cache:v1:community-icon:v2:listing-1:commit-1',
		'derived-cache:v1:community-icon:v3:listing-1:abc123',
		'derived-cache:v1:community-icon:v3:listing-1:commit-1',
		'derived-cache:v1:identity-icon:v1:repo-src-1:abc123',
		'derived-cache:v1:identity-icon:v1:repo-src-1:old',
		`derived-cache:v1:mcp-oauth-refresh-family:${userAaa}:grant-1`,
		`derived-cache:v1:mcp-oauth-refresh-replay:${userAaa}:grant-1:hash-1`,
		`package-codemod-revert:${userAaa}:item-1`,
		`package-codemod-revert:${userAaa}:item-2`,
		'source-manifest-snapshot:v1:src-1:abc123',
		'source-manifest-snapshot:v1:src-1:old456',
		'source-snapshot:v1:src-1:abc123',
		'source-snapshot:v1:src-1:old456',
	])

	// Result accounting captures the per-table counts. Job rows are purged
	// through the JOBS service (ADR 0016), so they are not counted here.
	expect(result.deletedRowCounts.jobs).toBeUndefined()
	expect(result.deletedRowCounts).toMatchObject({
		users: 1,
		password_resets: 2,
		user_roles: 1,
		user_storage_buckets: 2,
		community_listings: 1,
		community_forks: 2,
		community_ratings: 2,
		community_activity_events: 2,
		community_reports: 2,
		community_bans: 1,
		platform_feedback: 1,
	})
	expect(result.updatedRowCounts).toMatchObject({
		community_reports: 1,
		community_bans: 1,
		platform_feedback: 1,
	})
	expect(result).toMatchObject({
		deletedKvKeys: 23,
		deletedCommunityAssets: 9,
		deletedEmailBlobs: 2,
		deletedVectors: 5,
		warnings: [],
	})
	// Prefix sweeps remove current and historical assets without crossing users.
	expect(deletedCommunityAssetKeys.sort()).toEqual([
		'community-icon:v1/listing-1/abc123/asset',
		'community-icon:v1/listing-1/commit-1/asset',
		'community-icon:v1/listing-1/historical/asset',
		'community-icon:v2/listing-1/abc123/asset',
		'community-icon:v2/listing-1/commit-1/asset',
		'identity-icon:v1/repo-src-1/abc123/asset',
		'identity-icon:v1/repo-src-1/old/asset',
		'user-avatars/user-aaa/abc123.png',
		'user-avatars/user-aaa/old.png',
	])
	expect(communityAssetKeys).toEqual(
		new Set([
			'community-icon:v1/listing-2/other/asset',
			'identity-icon:v1/repo-src-2/def456/asset',
			'user-avatars/user-bbb/other.png',
		]),
	)
	expect(result.clearedDurableObjects).toMatchObject({
		storageRunners: 2,
		runLogs: 1,
		userMeters: 1,
		stripePlanRefreshes: 1,
		mailboxes: 1,
		jobManagers: 1,
		repoSessions: 1,
		// The MCP client hub is purged even when the user has no
		// mcp_server_settings rows, since the hub DO can still hold OAuth
		// tokens from failed or removed registrations.
		mcpClientHubs: 1,
		mcpAgentSessions: 1,
		packageRealtimeSessions: 1,
	})
	expect(clearRunLogMock).toHaveBeenCalledTimes(1)
	expect(purgeUserMeterMock).toHaveBeenCalledTimes(1)
	expect(stripePlanRefreshIdFromNameMock).toHaveBeenCalledWith(userAaa)
	expect(purgeStripePlanRefreshMock).toHaveBeenCalledWith({ userId: userAaa })
	expect(listBlobReferencesMock).toHaveBeenCalledTimes(1)
	expect(purgeMailboxMock).toHaveBeenCalledTimes(1)
	// Blob references are listed, blobs deleted, and only then the mailbox.
	expect(mailboxCleanupOrder).toEqual([
		'list-blob-references',
		...mailboxCleanupOrder.filter((step) => step === 'delete-email-blob'),
		'purge-mailbox',
	])
	expect(mailboxCleanupOrder).toContain('delete-email-blob')
	expect(purgeMcpClientHubMock).toHaveBeenCalledTimes(1)
	expect(purgeMcpAgentSessionMock).toHaveBeenCalledWith({ userId: userAaa })
})

test('account deletion preserves Mailbox references and retry marker when R2 deletion fails', async () => {
	const { db, rows } = createTestDb({
		users: [{ id: 1, email: 'a@example.com', stable_user_id: 'user-aaa' }],
	})
	const purgeMailbox = vi.fn(async () => ({ ok: true as const }))
	const deleteEmailBlob = vi.fn(async () => {
		throw new Error('email R2 delete unavailable')
	})
	const key = 'email-raw:v1:user-aaa/message-1'
	const listBlobReferences = vi.fn(async () => ({
		references: [
			{
				kind: 'raw_mime' as const,
				key,
				messageId: 'message-1',
				attachmentId: null,
			},
		],
		nextStartAfter: null,
		truncated: false as const,
	}))
	const env = createSuccessfulDeletionEnv(db, {
		EMAIL_BLOBS: {
			async list() {
				return { objects: [{ key }], delimitedPrefixes: [], truncated: false }
			},
			delete: deleteEmailBlob,
		},
		MAILBOX: {
			idFromName,
			get: () => ({ listBlobReferences, purge: purgeMailbox }),
		},
	})

	await expect(
		deleteUserAccount({
			env,
			dbUserId: 1,
			mcpUserId: ownerIdFromStored('user-aaa'),
		}),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof AccountDeletionCleanupError &&
			error.cleanupErrors.some((warning) =>
				warning.includes('email R2 delete unavailable'),
			),
	)
	expect(listBlobReferences).toHaveBeenCalledTimes(1)
	expect(deleteEmailBlob).toHaveBeenCalled()
	expect(purgeMailbox).not.toHaveBeenCalled()
	expect(rows.users).toEqual([
		expect.objectContaining({
			id: 1,
			stable_user_id: 'user-aaa',
			deleting_at: expect.any(String),
		}),
	])

	// Any other critical cleanup failure also keeps the Mailbox for the retry.
	const { db: unrelatedDb } = createTestDb({
		users: [{ id: 1, email: 'b@example.com', stable_user_id: 'user-bbb' }],
	})
	const purgeAfterUnrelatedFailure = vi.fn(async () => ({ ok: true as const }))
	const unrelatedFailureEnv = createSuccessfulDeletionEnv(unrelatedDb, {
		OAUTH_PROVIDER: undefined,
		MAILBOX: {
			idFromName,
			get: () => ({
				listBlobReferences: async () => ({
					references: [],
					nextStartAfter: null,
					truncated: false as const,
				}),
				purge: purgeAfterUnrelatedFailure,
			}),
		},
	})
	await expect(
		deleteUserAccount({
			env: unrelatedFailureEnv,
			dbUserId: 1,
			mcpUserId: ownerIdFromStored('user-bbb'),
		}),
	).rejects.toBeInstanceOf(AccountDeletionCleanupError)
	expect(purgeAfterUnrelatedFailure).not.toHaveBeenCalled()
})

test('deleteUserAccount revokes OAuth grants via provider helpers, falls back to OAUTH_KV, and fails closed without either', async () => {
	const grant = (userId: string, grantId: string) =>
		JSON.stringify({ id: grantId, userId, clientId: 'host-client' })
	const token = (userId: string, grantId: string, tokenId: string) =>
		JSON.stringify({ id: tokenId, userId, grantId })
	const deleteUserA = (
		overrides: Parameters<typeof createSuccessfulDeletionEnv>[1],
		initial: Parameters<typeof createTestDb>[0] = {},
	) => {
		const { db, rows } = createTestDb({
			users: [{ id: 1, email: 'a@example.com', stable_user_id: 'user-aaa' }],
			...initial,
		})
		return {
			rows,
			result: deleteUserAccount({
				env: createSuccessfulDeletionEnv(db, overrides),
				dbUserId: 1,
				mcpUserId: ownerIdFromStored('user-aaa'),
			}),
		}
	}

	// The fetch-context provider helpers win over OAUTH_KV when both exist.
	const providerKv = createMemoryKvNamespace({
		'grant:user-aaa:grant-1': grant('user-aaa', 'grant-1'),
	})
	const revokeGrant = vi.fn(async () => undefined)
	const provider = await deleteUserA({
		OAUTH_KV: providerKv.kv,
		OAUTH_PROVIDER: {
			async listUserGrants() {
				return {
					items: [
						{ id: 'provider-grant-1', clientId: 'client-1' },
						{ id: 'provider-grant-2', clientId: 'client-2' },
					],
					cursor: undefined,
				}
			},
			revokeGrant,
		},
	}).result
	expect(provider.warnings).toEqual([])
	expect(provider.revokedOAuthGrants).toBe(2)
	expect(revokeGrant.mock.calls).toEqual([
		['provider-grant-1', 'user-aaa'],
		['provider-grant-2', 'user-aaa'],
	])
	expect([...providerKv.store.keys()]).toEqual(['grant:user-aaa:grant-1'])

	// Without the provider helpers, OAUTH_KV grants and tokens for the user
	// (and owned clients) are removed; other users and host clients remain.
	const { kv, store } = createMemoryKvNamespace({
		'client:owned-client': JSON.stringify({ clientId: 'owned-client' }),
		'client:host-client': JSON.stringify({ clientId: 'host-client' }),
		'grant:user-aaa:grant-1': grant('user-aaa', 'grant-1'),
		'grant:user-aaa:grant-2': grant('user-aaa', 'grant-2'),
		'token:user-aaa:grant-1:tok-1': token('user-aaa', 'grant-1', 'tok-1'),
		'token:user-aaa:grant-1:tok-2': token('user-aaa', 'grant-1', 'tok-2'),
		'token:user-aaa:grant-2:tok-3': token('user-aaa', 'grant-2', 'tok-3'),
		'grant:user-bbb:grant-9': grant('user-bbb', 'grant-9'),
		'token:user-bbb:grant-9:tok-9': token('user-bbb', 'grant-9', 'tok-9'),
	})
	const kvFallback = deleteUserA(
		{ OAUTH_PROVIDER: undefined, OAUTH_KV: kv },
		{
			user_mcp_oauth_clients: [
				{
					id: 'row-1',
					user_id: 1,
					client_id: 'owned-client',
					revoked_at: null,
				},
			],
		},
	)
	const kvResult = await kvFallback.result
	expect(kvResult.warnings).toEqual([])
	expect(kvResult.revokedOAuthGrants).toBe(2)
	expect(kvFallback.rows.users).toEqual([])
	expect([...store.keys()].sort()).toEqual([
		'client:host-client',
		'grant:user-bbb:grant-9',
		'token:user-bbb:grant-9:tok-9',
	])

	const neither = deleteUserA({ OAUTH_PROVIDER: undefined })
	await expect(neither.result).rejects.toMatchObject({
		name: 'AccountDeletionCleanupError',
		cleanupErrors: [
			'OAuth provider binding and OAUTH_KV were unavailable; OAuth grants were not revoked.',
		],
	})
	expect(neither.rows.users).toEqual([
		expect.objectContaining({ id: 1, deleting_at: expect.any(String) }),
	])
})

test('account deletion coverage matches the migrated APP_DB schema', () => {
	const db = migratedAppDb()
	const tables = (
		db
			.prepare(
				`SELECT name FROM sqlite_schema
				WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
			)
			.all() as Array<{ name: string }>
	).map((row) => row.name)

	// Jobs moved to the jobs worker's D1 (migration 0010 dropped the APP_DB
	// copies), so the job surface must be sourced over the JOBS binding rather
	// than an APP_DB table scan.
	expect(tables).not.toContain('jobs')
	for (const surface of accountUserOwnedVectorizeSurfaces) {
		switch (surface.source.kind) {
			case 'app_db': {
				expect(tables).toContain(surface.source.table)
				break
			}
			case 'jobs_rpc': {
				expect(surface.id).toBe('job')
				break
			}
			default: {
				const unknownSource: never = surface.source
				throw new Error(
					`Unknown vectorize source: ${JSON.stringify(unknownSource)}`,
				)
			}
		}
	}

	// Every live user-owned D1 column is deleted, and nothing stale is listed.
	const liveUserColumns = new Set<string>()
	for (const table of tables) {
		const columns = db
			.prepare(`PRAGMA table_info(${quoteSqlIdentifier(table)})`)
			.all() as Array<{ name: string }>
		if (
			(accountUserDataPendingDropTables as ReadonlyArray<string>).includes(
				table,
			)
		) {
			continue
		}
		for (const column of columns) {
			if (column.name === 'user_id' || column.name.endsWith('_user_id')) {
				liveUserColumns.add(`${table}.${column.name}`)
			}
		}
	}
	const coveredColumns = getAccountDeletionD1UserColumnCoverage()
	expect([...liveUserColumns].filter((c) => !coveredColumns.has(c))).toEqual([])
	expect([...coveredColumns].filter((c) => !liveUserColumns.has(c))).toEqual([])
})
