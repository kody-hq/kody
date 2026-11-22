import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createSuccessfulDeletionEnv } from '#worker/test-support/account-deletion.ts'
import { purgePersistedMcpAgentSession } from '#mcp/session-registry.ts'
import * as stripeClient from '#worker/billing/stripe-client.ts'
import {
	spyOnStripeRefundClient,
	stripeSubscription,
} from '#worker/test-support/account-deletion-billing.ts'
import { outboundTimeoutMs } from '#worker/outbound/with-deadline.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { PurgeWebhookFailed } from './purge-webhook.ts'

const sentryMock = vi.hoisted(() => ({ captureException: vi.fn() }))

vi.mock('@sentry/cloudflare', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	captureException: sentryMock.captureException,
}))

vi.mock('#worker/jobs/manager-client.ts', () => ({
	purgeJobManagerForUser: vi.fn(async () => ({
		ok: true as const,
		userId: ownerIdFromStored('mock'),
		purged: true,
	})),
}))

vi.mock('#worker/jobs/jobs-data.ts', () => ({
	jobsData: () => ({
		purgeUserJobsData: vi.fn(async () => undefined),
		listJobStorageIdsForUser: vi.fn(async () => [] as Array<string>),
	}),
	jobsService: () => ({
		listJobIdsForUser: async () => [] as Array<string>,
		listJobStorageIdsForUser: async () => [] as Array<string>,
		purgeUser: async (input: { userId: string }) => ({
			ok: true as const,
			userId: input.userId,
			purged: true,
		}),
	}),
}))

const {
	finishLegacyUserDeletion,
	hardPurgeOrg,
	LegacyUserDeletionNotPendingError,
	PersonalOrgHardPurgeBlockedForLiveUserError,
	PersonalOrgPurgesWithPersonError,
} = await import('./hard-purge.ts')
const { listSoftDeletePurgeCandidates, pruneSoftDeleted } =
	await import('./purge.ts')

function createAuditDb() {
	const auditSqlite = new DatabaseSync(':memory:')
	auditSqlite.exec(
		readFileSync(
			new URL(
				'../../audit-migrations/0002-org-audit-events.sql',
				import.meta.url,
			),
			'utf8',
		),
	)
	return createD1FromSqlite(auditSqlite)
}

function createKv() {
	const store = new Map<string, string>()
	return {
		store,
		kv: {
			get: async (key: string) => store.get(key) ?? null,
			put: async (key: string, value: string) => {
				store.set(key, value)
			},
			delete: async (key: string) => {
				store.delete(key)
			},
			list: async (options?: { prefix?: string }) => {
				const prefix = options?.prefix ?? ''
				return {
					keys: [...store.keys()]
						.filter((name) => name.startsWith(prefix))
						.map((name) => ({ name })),
					list_complete: true as const,
					cursor: undefined,
				}
			},
		},
	}
}

async function seedTeamOrgGraph(input: {
	appDb: D1Database
	orgId: string
	ts: string
}) {
	const { appDb, orgId, ts } = input
	await appDb
		.prepare(
			`INSERT INTO orgs (
				id, slug, display_name, plan, entitlement_ladder, deleted_at,
				created_at, updated_at
			) VALUES (?, ?, ?, 'free', 'public', ?, ?, ?)`,
		)
		.bind(orgId, 'hard-purge', 'Hard purge', ts, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO secret_buckets (
				id, user_id, scope, binding_key, created_at, updated_at
			) VALUES ('sec-purge', ?, 'user', 'default', ?, ?)`,
		)
		.bind(orgId, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO secret_entries (
				bucket_id, name, encrypted_value, created_at, updated_at
			) VALUES ('sec-purge', 'api-key', 'cipher', ?, ?)`,
		)
		.bind(ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO teams (
				id, org_id, slug, name, created_by_user_id, created_at, updated_at
			) VALUES ('team-purge', ?, 'eng', 'Eng', 'owner-1', ?, ?)`,
		)
		.bind(orgId, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO team_members (team_id, user_id, created_at)
			 VALUES ('team-purge', 'member-1', ?)`,
		)
		.bind(ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				preset, created_by_user_id, created_at, updated_at
			) VALUES (
				'grant-purge', ?, 'package', 'pkg-1', 'user', 'member-1',
				'use', 'owner-1', ?, ?
			)`,
		)
		.bind(orgId, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission)
			 VALUES ('grant-purge', 'package:read')`,
		)
		.run()
	await appDb
		.prepare(
			`INSERT INTO handles (handle, org_id, created_at) VALUES ('hard-purge', ?, ?)`,
		)
		.bind(orgId, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO org_audit_outbox (id, org_id, payload_json, created_at)
			 VALUES ('outbox-purge', ?, '{"id":"outbox-purge"}', ?)`,
		)
		.bind(orgId, ts)
		.run()
}

test('hardPurgeOrg deletes org-owned children and the org graph from one inventory', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const appDb = createD1FromSqlite(sqlite)
	const auditDb = createAuditDb()
	const orgId = ownerIdFromStored('org-hard-purge')
	const ts = '2026-01-01T00:00:00.000Z'
	await seedTeamOrgGraph({ appDb, orgId, ts })
	const otherOrgId = 'org-hard-purge-other'
	await appDb
		.prepare(
			`INSERT INTO orgs (
				id, slug, display_name, plan, entitlement_ladder,
				created_at, updated_at
			) VALUES (?, 'other-purge', 'Other', 'free', 'public', ?, ?)`,
		)
		.bind(otherOrgId, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO secret_buckets (
				id, user_id, scope, binding_key, created_at, updated_at
			) VALUES ('sec-other', ?, 'user', 'default', ?, ?)`,
		)
		.bind(otherOrgId, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO secret_entries (
				bucket_id, name, encrypted_value, created_at, updated_at
			) VALUES ('sec-other', 'api-key', 'cipher', ?, ?)`,
		)
		.bind(ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO teams (
				id, org_id, slug, name, created_by_user_id, created_at, updated_at
			) VALUES ('team-other', ?, 'eng', 'Eng', 'owner-1', ?, ?)`,
		)
		.bind(otherOrgId, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO team_members (team_id, user_id, created_at)
			 VALUES ('team-other', 'member-1', ?)`,
		)
		.bind(ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				preset, created_by_user_id, created_at, updated_at
			) VALUES (
				'grant-other', ?, 'package', 'pkg-2', 'user', 'member-1',
				'use', 'owner-1', ?, ?
			)`,
		)
		.bind(otherOrgId, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission)
			 VALUES ('grant-other', 'package:read')`,
		)
		.run()
	await appDb
		.prepare(
			`INSERT INTO handles (handle, org_id, created_at) VALUES ('other-purge', ?, ?)`,
		)
		.bind(otherOrgId, ts)
		.run()

	const env = createSuccessfulDeletionEnv(appDb, {
		AUDIT_DB: auditDb,
	})
	await hardPurgeOrg({ env, orgId })

	for (const [sql, label] of [
		[`SELECT COUNT(*) AS n FROM orgs WHERE id = ?`, 'orgs'],
		[`SELECT COUNT(*) AS n FROM secret_buckets WHERE user_id = ?`, 'buckets'],
		[
			`SELECT COUNT(*) AS n FROM secret_entries WHERE bucket_id = 'sec-purge'`,
			'entries',
		],
		[`SELECT COUNT(*) AS n FROM teams WHERE org_id = ?`, 'teams'],
		[
			`SELECT COUNT(*) AS n FROM team_members WHERE team_id = 'team-purge'`,
			'members',
		],
		[`SELECT COUNT(*) AS n FROM grants WHERE org_id = ?`, 'grants'],
		[
			`SELECT COUNT(*) AS n FROM grant_permissions WHERE grant_id = 'grant-purge'`,
			'permissions',
		],
		[`SELECT COUNT(*) AS n FROM handles WHERE org_id = ?`, 'handles'],
		[
			`SELECT COUNT(*) AS n FROM org_audit_outbox WHERE org_id = ?`,
			'audit_outbox',
		],
	] as const) {
		const bindsId = sql.includes('?')
		const row = await appDb
			.prepare(sql)
			.bind(...(bindsId ? [orgId] : []))
			.first<{ n: number }>()
		expect({ label, n: row?.n }).toEqual({ label, n: 0 })
	}
	const audit = await auditDb
		.prepare(`SELECT action FROM org_audit_events WHERE org_id = ?`)
		.bind(orgId)
		.first<{ action: string }>()
	expect(audit?.action).toBe('org.purged')
	const otherStillThere = await appDb
		.prepare(
			`SELECT
				(SELECT COUNT(*) FROM orgs WHERE id = ?) AS orgs,
				(SELECT COUNT(*) FROM secret_buckets WHERE id = 'sec-other') AS buckets,
				(SELECT COUNT(*) FROM secret_entries WHERE bucket_id = 'sec-other') AS entries,
				(SELECT COUNT(*) FROM teams WHERE id = 'team-other') AS teams,
				(SELECT COUNT(*) FROM team_members WHERE team_id = 'team-other') AS members,
				(SELECT COUNT(*) FROM grants WHERE id = 'grant-other') AS grants,
				(SELECT COUNT(*) FROM grant_permissions WHERE grant_id = 'grant-other') AS permissions,
				(SELECT COUNT(*) FROM handles WHERE handle = 'other-purge') AS handles`,
		)
		.bind(otherOrgId)
		.first<{
			orgs: number
			buckets: number
			entries: number
			teams: number
			members: number
			grants: number
			permissions: number
			handles: number
		}>()
	expect(otherStillThere).toEqual({
		orgs: 1,
		buckets: 1,
		entries: 1,
		teams: 1,
		members: 1,
		grants: 1,
		permissions: 1,
		handles: 1,
	})
})

test('hardPurgeOrg removes team-org published_bundle_artifacts and their KV keys', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const appDb = createD1FromSqlite(sqlite)
	const auditDb = createAuditDb()
	const orgId = ownerIdFromStored('org-team-artifacts')
	const ts = '2026-01-01T00:00:00.000Z'
	await seedTeamOrgGraph({ appDb, orgId, ts })
	const kvKey = 'bundle-artifact:v1:team-src-1'
	await appDb
		.prepare(
			`INSERT INTO published_bundle_artifacts (
				id, user_id, source_id, published_commit, artifact_kind, artifact_name,
				entry_point, kv_key, dependencies_json, created_at, updated_at
			) VALUES (
				'pba-team-1', ?, 'team-src-1', 'abc123', 'module', 'main',
				'index.js', ?, '[]', ?, ?
			)`,
		)
		.bind(orgId, kvKey, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO vector_embed_fingerprints (
				user_id, vector_id, content_hash, updated_at
			) VALUES (?, 'vec-team-1', 'hash-1', ?)`,
		)
		.bind(orgId, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO saved_package_search_index_debt (
				package_id, user_id, generation, embed_text, created_at, updated_at
			) VALUES ('pkg-debt-1', ?, 1, 'embed', ?, ?)`,
		)
		.bind(orgId, ts, ts)
		.run()
	const { store, kv } = createKv()
	await kv.put(kvKey, 'artifact-bytes')
	await kv.put('bundle-artifact:v1:other-org', 'keep')

	const env = createSuccessfulDeletionEnv(appDb, {
		AUDIT_DB: auditDb,
		BUNDLE_ARTIFACTS_KV: kv,
	})
	await hardPurgeOrg({ env, orgId })

	const artifactCount = await appDb
		.prepare(
			`SELECT COUNT(*) AS n FROM published_bundle_artifacts WHERE user_id = ?`,
		)
		.bind(orgId)
		.first<{ n: number }>()
	expect(artifactCount?.n).toBe(0)
	const fingerprintCount = await appDb
		.prepare(
			`SELECT COUNT(*) AS n FROM vector_embed_fingerprints WHERE user_id = ?`,
		)
		.bind(orgId)
		.first<{ n: number }>()
	expect(fingerprintCount?.n).toBe(0)
	const debtCount = await appDb
		.prepare(
			`SELECT COUNT(*) AS n FROM saved_package_search_index_debt WHERE user_id = ?`,
		)
		.bind(orgId)
		.first<{ n: number }>()
	expect(debtCount?.n).toBe(0)
	expect(store.has(kvKey)).toBe(false)
	expect(store.has('bundle-artifact:v1:other-org')).toBe(true)
})

async function seedSoftDeletedPersonWithPersonalOrg(input: {
	appDb: D1Database
	stripeCustomerId: string | null
}) {
	const { appDb } = input
	const personId = ownerIdFromStored('person-hard-purge')
	const ts = '2026-01-01T00:00:00.000Z'
	await appDb
		.prepare(
			`INSERT INTO users (
				id, username, email, password_hash, stable_user_id,
				created_at, updated_at, deleted_at
			) VALUES (1, 'person-purge', 'person@example.com', 'hash', ?, ?, ?, ?)`,
		)
		.bind(personId, ts, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO orgs (
				id, slug, display_name, plan, entitlement_ladder, deleted_at,
				stripe_customer_id, created_at, updated_at
			) VALUES (?, 'person-purge', 'Person', 'free', 'public', ?, ?, ?, ?)`,
		)
		.bind(personId, ts, input.stripeCustomerId, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO handles (handle, org_id, created_at) VALUES ('person-purge', ?, ?)`,
		)
		.bind(personId, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO org_memberships (
				org_id, user_id, role, created_at, deleted_at
			) VALUES (?, ?, 'owner', ?, ?)`,
		)
		.bind(personId, personId, ts, ts)
		.run()
	const kvKey = 'bundle-artifact:v1:person-src-1'
	await appDb
		.prepare(
			`INSERT INTO published_bundle_artifacts (
				id, user_id, source_id, published_commit, artifact_kind, artifact_name,
				entry_point, kv_key, dependencies_json, created_at, updated_at
			) VALUES (
				'pba-person-1', ?, 'person-src-1', 'def456', 'module', 'main',
				'index.js', ?, '[]', ?, ?
			)`,
		)
		.bind(personId, kvKey, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO secret_buckets (
				id, user_id, scope, binding_key, created_at, updated_at, deleted_at
			) VALUES ('sec-person', ?, 'user', 'default', ?, ?, ?)`,
		)
		.bind(personId, ts, ts, ts)
		.run()
	const { store, kv } = createKv()
	await kv.put(kvKey, 'person-artifact')
	return { personId, kvKey, store, kv }
}

async function countRows(db: D1Database, sql: string, id: string) {
	const row = await db.prepare(sql).bind(id).first<{ n: number }>()
	return row?.n
}

test('hardPurgeOrg leaves a soft-deleted person personal org for the person purge', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const appDb = createD1FromSqlite(sqlite)
	const { personId, kvKey, store, kv } =
		await seedSoftDeletedPersonWithPersonalOrg({
			appDb,
			stripeCustomerId: 'cus_person',
		})
	const env = createSuccessfulDeletionEnv(appDb, {
		AUDIT_DB: createAuditDb(),
		BUNDLE_ARTIFACTS_KV: kv,
	})

	await expect(hardPurgeOrg({ env, orgId: personId })).rejects.toBeInstanceOf(
		PersonalOrgPurgesWithPersonError,
	)

	const org = await appDb
		.prepare(`SELECT stripe_customer_id FROM orgs WHERE id = ?`)
		.bind(personId)
		.first<{ stripe_customer_id: string | null }>()
	expect(org?.stripe_customer_id).toBe('cus_person')
	expect(store.has(kvKey)).toBe(true)
})

test('scheduled purge of a personal org and its person in one pass still cancels Stripe billing and deletes the customer', async () => {
	const listSubscriptions = vi
		.spyOn(stripeClient, 'listSubscriptions')
		.mockResolvedValue([stripeSubscription('sub_person', 'active')])
	const cancelSubscription = vi
		.spyOn(stripeClient, 'cancelSubscription')
		.mockResolvedValue(undefined)
	const deleteCustomer = vi
		.spyOn(stripeClient, 'deleteCustomer')
		.mockResolvedValue(undefined)
	const refund = spyOnStripeRefundClient()
	try {
		const sqlite = new DatabaseSync(':memory:')
		applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
		const appDb = createD1FromSqlite(sqlite)
		const auditDb = createAuditDb()
		const { personId, kvKey, store, kv } =
			await seedSoftDeletedPersonWithPersonalOrg({
				appDb,
				stripeCustomerId: 'cus_person',
			})
		const env = createSuccessfulDeletionEnv(appDb, {
			AUDIT_DB: auditDb,
			BUNDLE_ARTIFACTS_KV: kv,
			SOFT_DELETE_PURGE_ENABLED: 'true',
		})

		const result = await pruneSoftDeleted({
			env,
			now: new Date('2026-03-01T00:00:00.000Z'),
			dryRun: false,
		})

		expect(result.failed, JSON.stringify(result.outcomes)).toBe(0)
		expect(result.outcomes).toEqual([
			expect.objectContaining({ kind: 'user', id: personId }),
		])
		expect(listSubscriptions).toHaveBeenCalledWith(env, 'cus_person')
		expect(cancelSubscription).toHaveBeenCalledWith(env, 'sub_person')
		expect(deleteCustomer).toHaveBeenCalledWith(env, 'cus_person')
		expect(
			await countRows(
				appDb,
				`SELECT COUNT(*) AS n FROM orgs WHERE id = ?`,
				personId,
			),
		).toBe(0)
		expect(
			await countRows(
				appDb,
				`SELECT COUNT(*) AS n FROM users WHERE stable_user_id = ?`,
				personId,
			),
		).toBe(0)
		expect(
			await countRows(
				appDb,
				`SELECT COUNT(*) AS n FROM handles WHERE org_id = ?`,
				personId,
			),
		).toBe(0)
		expect(
			await countRows(
				appDb,
				`SELECT COUNT(*) AS n FROM published_bundle_artifacts WHERE user_id = ?`,
				personId,
			),
		).toBe(0)
		expect(store.has(kvKey)).toBe(false)
		const audit = await auditDb
			.prepare(
				`SELECT action FROM org_audit_events WHERE org_id = ? ORDER BY rowid`,
			)
			.bind(personId)
			.all<{ action: string }>()
		expect(audit.results.map((row) => row.action)).toEqual(
			expect.arrayContaining(['org.purged', 'user.purged']),
		)
	} finally {
		listSubscriptions.mockRestore()
		cancelSubscription.mockRestore()
		deleteCustomer.mockRestore()
		refund.restore()
	}
})

test('hardPurgeOrg blocks when the personal-org person is still live', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const appDb = createD1FromSqlite(sqlite)
	const auditDb = createAuditDb()
	const personId = ownerIdFromStored('person-live-purge')
	const ts = '2026-01-01T00:00:00.000Z'
	await appDb
		.prepare(
			`INSERT INTO users (
				id, username, email, password_hash, stable_user_id,
				created_at, updated_at
			) VALUES (1, 'live-purge', 'live@example.com', 'hash', ?, ?, ?)`,
		)
		.bind(personId, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO orgs (
				id, slug, display_name, plan, entitlement_ladder, deleted_at,
				created_at, updated_at
			) VALUES (?, 'live-purge', 'Live', 'free', 'public', ?, ?, ?)`,
		)
		.bind(personId, ts, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO handles (handle, org_id, created_at) VALUES ('live-purge', ?, ?)`,
		)
		.bind(personId, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO org_memberships (
				org_id, user_id, role, created_at, deleted_at
			) VALUES (?, ?, 'owner', ?, ?)`,
		)
		.bind(personId, personId, ts, ts)
		.run()
	const kvKey = 'bundle-artifact:v1:live-src-1'
	await appDb
		.prepare(
			`INSERT INTO published_bundle_artifacts (
				id, user_id, source_id, published_commit, artifact_kind, artifact_name,
				entry_point, kv_key, dependencies_json, created_at, updated_at
			) VALUES (
				'pba-live-1', ?, 'live-src-1', 'abc123', 'module', 'main',
				'index.js', ?, '[]', ?, ?
			)`,
		)
		.bind(personId, kvKey, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO secret_buckets (
				id, user_id, scope, binding_key, created_at, updated_at, deleted_at
			) VALUES ('sec-live', ?, 'user', 'default', ?, ?, ?)`,
		)
		.bind(personId, ts, ts, ts)
		.run()
	const { store, kv } = createKv()
	await kv.put(kvKey, 'live-artifact')

	const env = createSuccessfulDeletionEnv(appDb, {
		AUDIT_DB: auditDb,
		BUNDLE_ARTIFACTS_KV: kv,
	})
	await expect(hardPurgeOrg({ env, orgId: personId })).rejects.toBeInstanceOf(
		PersonalOrgHardPurgeBlockedForLiveUserError,
	)

	expect(
		(
			await appDb
				.prepare(`SELECT COUNT(*) AS n FROM orgs WHERE id = ?`)
				.bind(personId)
				.first<{ n: number }>()
		)?.n,
	).toBe(1)
	expect(
		(
			await appDb
				.prepare(
					`SELECT COUNT(*) AS n FROM published_bundle_artifacts WHERE user_id = ?`,
				)
				.bind(personId)
				.first<{ n: number }>()
		)?.n,
	).toBe(1)
	expect(
		(
			await appDb
				.prepare(`SELECT COUNT(*) AS n FROM secret_buckets WHERE user_id = ?`)
				.bind(personId)
				.first<{ n: number }>()
		)?.n,
	).toBe(1)
	expect(store.has(kvKey)).toBe(true)
})

test('hardPurgeOrg sweeps team org-avatars from COMMUNITY_ASSETS', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const appDb = createD1FromSqlite(sqlite)
	const auditDb = createAuditDb()
	const orgId = ownerIdFromStored('org-avatar-purge')
	const ts = '2026-01-01T00:00:00.000Z'
	await seedTeamOrgGraph({ appDb, orgId, ts })
	const avatarKey = `org-avatars/${orgId}/hash.png`
	const otherKey = 'org-avatars/other-org/hash.png'
	const assets = new Map<string, string>([
		[avatarKey, 'png'],
		[otherKey, 'png'],
		[`user-avatars/${orgId}/face.png`, 'png'],
	])
	const env = createSuccessfulDeletionEnv(appDb, {
		AUDIT_DB: auditDb,
		COMMUNITY_ASSETS: {
			async list(options?: { prefix?: string; cursor?: string }) {
				const prefix = options?.prefix ?? ''
				const matches = [...assets.keys()]
					.filter(
						(key) =>
							key.startsWith(prefix) &&
							(!options?.cursor || key > options.cursor),
					)
					.sort()
				const objects = matches.slice(0, 10).map((key) => ({ key }))
				return {
					objects,
					delimitedPrefixes: [],
					...(matches.length > objects.length
						? { truncated: true as const, cursor: objects.at(-1)!.key }
						: { truncated: false as const }),
				}
			},
			async delete(value: string | Array<string>) {
				for (const key of Array.isArray(value) ? value : [value]) {
					assets.delete(key)
				}
			},
		},
	})
	await hardPurgeOrg({ env, orgId })
	expect(assets.has(avatarKey)).toBe(false)
	expect(assets.has(`user-avatars/${orgId}/face.png`)).toBe(false)
	expect(assets.has(otherKey)).toBe(true)
})

async function seedLegacyFencedPerson(input: {
	appDb: D1Database
	personId: string
	ts: string
	deletingAt: string | null
	deletedAt?: string | null
}) {
	const { appDb, personId, ts } = input
	await appDb
		.prepare(
			`INSERT INTO users (
				id, username, email, password_hash, stable_user_id, personal_org_id,
				created_at, updated_at, deleting_at, deleted_at
			) VALUES (7, 'legacy-person', 'legacy@example.com', 'hash', ?, ?, ?, ?, ?, ?)`,
		)
		.bind(personId, personId, ts, ts, input.deletingAt, input.deletedAt ?? null)
		.run()
	// The Teams backfill gave every person a personal org, a handle, and an
	// owner membership, including people already fenced for deletion.
	await appDb
		.prepare(
			`INSERT INTO orgs (
				id, slug, display_name, plan, entitlement_ladder,
				created_at, updated_at
			) VALUES (?, 'legacy-person', 'Legacy', 'free', 'public', ?, ?)`,
		)
		.bind(personId, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO handles (handle, org_id, created_at) VALUES ('legacy-person', ?, ?)`,
		)
		.bind(personId, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', ?)`,
		)
		.bind(personId, personId, ts)
		.run()
}

test('finishLegacyUserDeletion finishes a fenced pre-soft-delete deletion and tolerates storage that is already gone', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const appDb = createD1FromSqlite(sqlite)
	const auditDb = createAuditDb()
	const personId = ownerIdFromStored('person-legacy-finish')
	const ts = '2026-08-20T00:00:00.000Z'
	await seedLegacyFencedPerson({ appDb, personId, ts, deletingAt: ts })
	// One bundle key the first attempt already removed, one still present.
	const goneKey = 'bundle-artifact:v1:legacy-gone'
	const liveKey = 'bundle-artifact:v1:legacy-live'
	for (const [id, sourceId, kvKey] of [
		['pba-legacy-gone', 'legacy-src-gone', goneKey],
		['pba-legacy-live', 'legacy-src-live', liveKey],
	] as const) {
		await appDb
			.prepare(
				`INSERT INTO published_bundle_artifacts (
					id, user_id, source_id, published_commit, artifact_kind, artifact_name,
					entry_point, kv_key, dependencies_json, created_at, updated_at
				) VALUES (?, ?, ?, 'abc123', 'module', 'main', 'index.js', ?, '[]', ?, ?)`,
			)
			.bind(id, personId, sourceId, kvKey, ts, ts)
			.run()
	}
	const { store, kv } = createKv()
	await kv.put(liveKey, 'artifact')
	await kv.put('bundle-artifact:v1:someone-else', 'keep')
	const env = createSuccessfulDeletionEnv(appDb, {
		AUDIT_DB: auditDb,
		BUNDLE_ARTIFACTS_KV: kv,
	}) as unknown as Env

	const first = await finishLegacyUserDeletion({
		env,
		dbUserId: 7,
		stableUserId: personId,
	})
	expect(first.alreadyGone).toBe(false)
	for (const [table, column] of [
		['users', 'stable_user_id'],
		['orgs', 'id'],
		['handles', 'org_id'],
		['org_memberships', 'org_id'],
		['published_bundle_artifacts', 'user_id'],
	] as const) {
		const row = await appDb
			.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
			.bind(personId)
			.first<{ n: number }>()
		expect({ table, n: row?.n }).toEqual({ table, n: 0 })
	}
	expect(store.has(liveKey)).toBe(false)
	expect(store.has('bundle-artifact:v1:someone-else')).toBe(true)
	const audit = await auditDb
		.prepare(
			`SELECT action, details_json FROM org_audit_events
			 WHERE org_id = ? AND action = 'user.purged'`,
		)
		.bind(personId)
		.first<{ action: string; details_json: string }>()
	expect(audit?.details_json).toContain('legacy_deletion_finish')

	// A retry after success is a no-op.
	const second = await finishLegacyUserDeletion({
		env,
		dbUserId: 7,
		stableUserId: personId,
	})
	expect(second.alreadyGone).toBe(true)
})

test('finishLegacyUserDeletion leaves a failed personal org purge to the org lane', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const realDb = createD1FromSqlite(sqlite)
	let failOrgDelete = true
	const appDb = new Proxy(realDb, {
		get(target, prop, receiver) {
			if (prop === 'prepare') {
				return (sql: string) => {
					if (failOrgDelete && sql.startsWith('DELETE FROM orgs WHERE id')) {
						throw new Error('org_delete_unavailable')
					}
					return target.prepare(sql)
				}
			}
			return Reflect.get(target, prop, receiver)
		},
	})
	const personId = ownerIdFromStored('person-legacy-org-retry')
	const ts = '2026-08-20T00:00:00.000Z'
	await seedLegacyFencedPerson({ appDb, personId, ts, deletingAt: ts })
	const env = createSuccessfulDeletionEnv(appDb, {
		AUDIT_DB: createAuditDb(),
	}) as unknown as Env

	await expect(
		finishLegacyUserDeletion({ env, dbUserId: 7, stableUserId: personId }),
	).rejects.toThrow('org_delete_unavailable')

	expect(
		await countRows(appDb, `SELECT COUNT(*) AS n FROM users WHERE id = ?`, '7'),
	).toBe(0)
	const preview = await listSoftDeletePurgeCandidates({
		env,
		now: new Date('2026-11-01T00:00:00.000Z'),
	})
	expect(
		preview.candidates.filter((candidate) => candidate.kind === 'org'),
	).toEqual([expect.objectContaining({ id: personId })])
	failOrgDelete = false
	await hardPurgeOrg({ env, orgId: personId })
	expect(
		await countRows(
			appDb,
			`SELECT COUNT(*) AS n FROM orgs WHERE id = ?`,
			personId,
		),
	).toBe(0)
})

test('finishLegacyUserDeletion refuses live and soft-deleted rows', async () => {
	for (const state of ['live', 'soft_deleted'] as const) {
		const sqlite = new DatabaseSync(':memory:')
		applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
		const appDb = createD1FromSqlite(sqlite)
		const personId = ownerIdFromStored(`person-legacy-${state}`)
		const ts = '2026-08-20T00:00:00.000Z'
		await seedLegacyFencedPerson({
			appDb,
			personId,
			ts,
			deletingAt: null,
			deletedAt: state === 'soft_deleted' ? ts : null,
		})
		const env = createSuccessfulDeletionEnv(appDb, {
			AUDIT_DB: createAuditDb(),
		}) as unknown as Env
		await expect(
			finishLegacyUserDeletion({ env, dbUserId: 7, stableUserId: personId }),
		).rejects.toBeInstanceOf(LegacyUserDeletionNotPendingError)
		const stillThere = await appDb
			.prepare(`SELECT COUNT(*) AS n FROM users WHERE id = 7`)
			.first<{ n: number }>()
		expect({ state, n: stillThere?.n }).toEqual({ state, n: 1 })
		const orgStillThere = await appDb
			.prepare(`SELECT COUNT(*) AS n FROM orgs WHERE id = ?`)
			.bind(personId)
			.first<{ n: number }>()
		expect({ state, n: orgStillThere?.n }).toEqual({ state, n: 1 })
	}
})

test('finishLegacyUserDeletion cleans up an orphaned package and source after the personal org row is gone', async () => {
	// Exact state a failed earlier attempt leaves behind: the owner id is also
	// the personal org id, the personal org row (with its handle and
	// membership) was already purged, the Artifacts repo was already deleted,
	// and the package, source, and bundle rows still point at the owner id.
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const appDb = createD1FromSqlite(sqlite)
	const auditDb = createAuditDb()
	const personId = ownerIdFromStored('person-legacy-orphan')
	const ts = '2026-08-20T00:00:00.000Z'
	await seedLegacyFencedPerson({ appDb, personId, ts, deletingAt: ts })
	await appDb
		.prepare(
			`INSERT INTO entity_sources (
				id, user_id, entity_kind, entity_id, repo_id, published_commit,
				created_at, updated_at
			) VALUES ('src-orphan', ?, 'package', 'pkg-orphan', 'repo-orphan-1', 'abc123', ?, ?)`,
		)
		.bind(personId, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, source_id, created_at, updated_at
			) VALUES ('pkg-orphan', ?, 'orphan', 'orphan', 'Orphan', 'src-orphan', ?, ?)`,
		)
		.bind(personId, ts, ts)
		.run()
	for (const name of ['main', 'worker'] as const) {
		await appDb
			.prepare(
				`INSERT INTO published_bundle_artifacts (
					id, user_id, source_id, published_commit, artifact_kind, artifact_name,
					entry_point, kv_key, dependencies_json, created_at, updated_at
				) VALUES (?, ?, 'src-orphan', 'abc123', 'module', ?, 'index.js', ?, '[]', ?, ?)`,
			)
			.bind(
				`pba-orphan-${name}`,
				personId,
				name,
				`bundle-artifact:v1:orphan-${name}`,
				ts,
				ts,
			)
			.run()
	}
	for (const table of ['org_memberships', 'handles', 'orgs'] as const) {
		const column = table === 'orgs' ? 'id' : 'org_id'
		await appDb
			.prepare(`DELETE FROM ${table} WHERE ${column} = ?`)
			.bind(personId)
			.run()
	}
	const { store, kv } = createKv()
	await kv.put('bundle-artifact:v1:orphan-main', 'artifact')
	const deletedRepos: Array<string> = []
	const env = createSuccessfulDeletionEnv(appDb, {
		AUDIT_DB: auditDb,
		BUNDLE_ARTIFACTS_KV: kv,
		// The native binding throws NOT_FOUND for a repo that is already gone.
		ARTIFACTS: {
			create: async () => {
				throw new Error('unexpected create')
			},
			get: async (name: string) => {
				throw new Error(`ArtifactsError: Repository not found: ${name}`)
			},
			delete: async (name: string) => {
				deletedRepos.push(name)
				throw new Error(`ArtifactsError: Repository not found: ${name}`)
			},
			list: async () => ({ repos: [], total: 0 }),
		},
	}) as unknown as Env

	const first = await finishLegacyUserDeletion({
		env,
		dbUserId: 7,
		stableUserId: personId,
	})
	expect(first.alreadyGone).toBe(false)
	expect(deletedRepos).toEqual(['repo-orphan-1'])
	for (const [table, column] of [
		['users', 'stable_user_id'],
		['orgs', 'id'],
		['saved_packages', 'user_id'],
		['entity_sources', 'user_id'],
		['published_bundle_artifacts', 'user_id'],
	] as const) {
		const row = await appDb
			.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
			.bind(personId)
			.first<{ n: number }>()
		expect({ table, n: row?.n }).toEqual({ table, n: 0 })
	}
	expect(store.has('bundle-artifact:v1:orphan-main')).toBe(false)

	const second = await finishLegacyUserDeletion({
		env,
		dbUserId: 7,
		stableUserId: personId,
	})
	expect(second.alreadyGone).toBe(true)
})

test('finishLegacyUserDeletion finishes when an MCP agent session DO was already wiped', async () => {
	// Exact production retry state after a partial purge: personal org already
	// gone, package/source rows remain, mcp_agent_sessions still indexes a DO
	// whose storage was cleared on the earlier attempt. The wipe left no
	// persisted props owner; treating that as a scope mismatch blocked the
	// retry even though nothing remained to steal.
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const appDb = createD1FromSqlite(sqlite)
	const auditDb = createAuditDb()
	const personId = ownerIdFromStored('person-legacy-mcp-wiped')
	const ts = '2026-08-20T00:00:00.000Z'
	const wipedDoId = '00000000-0000-4000-8000-000000000001'
	await seedLegacyFencedPerson({ appDb, personId, ts, deletingAt: ts })
	await appDb
		.prepare(
			`INSERT INTO entity_sources (
				id, user_id, entity_kind, entity_id, repo_id, published_commit,
				created_at, updated_at
			) VALUES ('src-mcp-wiped', ?, 'package', 'pkg-mcp-wiped', 'repo-mcp-wiped', 'abc123', ?, ?)`,
		)
		.bind(personId, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, source_id, created_at, updated_at
			) VALUES ('pkg-mcp-wiped', ?, 'wiped', 'wiped', 'Wiped', 'src-mcp-wiped', ?, ?)`,
		)
		.bind(personId, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO mcp_agent_sessions (do_id, user_id, org_id, created_at)
			 VALUES (?, ?, ?, ?)`,
		)
		.bind(wipedDoId, personId, personId, ts)
		.run()
	for (const table of ['org_memberships', 'handles', 'orgs'] as const) {
		const column = table === 'orgs' ? 'id' : 'org_id'
		await appDb
			.prepare(`DELETE FROM ${table} WHERE ${column} = ?`)
			.bind(personId)
			.run()
	}
	let mcpPurgeCalls = 0
	const emptyStorage: Pick<DurableObjectStorage, 'get' | 'deleteAll'> = {
		get: (async (_key: string | Array<string>) =>
			undefined) as DurableObjectStorage['get'],
		async deleteAll() {
			mcpPurgeCalls += 1
		},
	}
	const { kv } = createKv()
	const env = createSuccessfulDeletionEnv(appDb, {
		AUDIT_DB: auditDb,
		BUNDLE_ARTIFACTS_KV: kv,
		ARTIFACTS: {
			create: async () => {
				throw new Error('unexpected create')
			},
			get: async (name: string) => {
				throw new Error(`ArtifactsError: Repository not found: ${name}`)
			},
			delete: async (name: string) => {
				throw new Error(`ArtifactsError: Repository not found: ${name}`)
			},
			list: async () => ({ repos: [], total: 0 }),
		},
		MCP_OBJECT: {
			idFromString: (id: string) => ({ toString: () => id }),
			get: (id: { toString(): string }) => ({
				purgeForAccountDeletion: async (payload: { userId: string }) => {
					await purgePersistedMcpAgentSession({
						storage: emptyStorage,
						doId: id.toString(),
						userId: payload.userId,
					})
				},
			}),
		},
	}) as unknown as Env

	const result = await finishLegacyUserDeletion({
		env,
		dbUserId: 7,
		stableUserId: personId,
	})
	expect(result.alreadyGone).toBe(false)
	expect(mcpPurgeCalls).toBe(1)
	for (const [table, column] of [
		['users', 'stable_user_id'],
		['saved_packages', 'user_id'],
		['entity_sources', 'user_id'],
		['mcp_agent_sessions', 'user_id'],
	] as const) {
		const row = await appDb
			.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
			.bind(personId)
			.first<{ n: number }>()
		expect({ table, n: row?.n }).toEqual({ table, n: 0 })
	}
})

const purgeHookUrl = 'https://hooks.example.com/purge'

type PurgeHookBody = { kind: 'org' | 'user'; id: string; purgedAt: string }

function stubPurgeHookFetch(
	respond: (body: PurgeHookBody) => Response | Promise<Response>,
) {
	const realFetch = globalThis.fetch
	const hookBodies: Array<PurgeHookBody> = []
	const fetchMock = vi.fn(
		async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			if (String(url) !== purgeHookUrl) return realFetch(url, init)
			const body = JSON.parse(String(init?.body)) as PurgeHookBody
			hookBodies.push(body)
			return respond(body)
		},
	)
	vi.stubGlobal('fetch', fetchMock)
	return { fetchMock, hookBodies }
}

function purgeEnvWithHook(
	appDb: D1Database,
	overrides: Parameters<typeof createSuccessfulDeletionEnv>[1],
	hook: { url: string | undefined } = { url: purgeHookUrl },
) {
	return Object.assign(
		createSuccessfulDeletionEnv(appDb, {
			SOFT_DELETE_PURGE_ENABLED: 'true',
			...overrides,
		}),
		{ PURGE_WEBHOOK_URL: hook.url },
	)
}

async function seedSecondSoftDeletedTeamOrg(appDb: D1Database) {
	const orgId = ownerIdFromStored('org-hook-other')
	const ts = '2026-01-02T00:00:00.000Z'
	await appDb
		.prepare(
			`INSERT INTO orgs (
				id, slug, display_name, plan, entitlement_ladder, deleted_at,
				created_at, updated_at
			) VALUES (?, 'hook-other', 'Hook other', 'free', 'public', ?, ?, ?)`,
		)
		.bind(orgId, ts, ts, ts)
		.run()
	return orgId
}

async function webhookFailedAuditRows(auditDb: D1Database) {
	const rows = await auditDb
		.prepare(
			`SELECT org_id, result, resource_type, resource_id, details_json
			 FROM org_audit_events WHERE action = 'purge.webhook_failed'
			 ORDER BY rowid`,
		)
		.all<{
			org_id: string
			result: string
			resource_type: string
			resource_id: string
			details_json: string
		}>()
	return rows.results.map((row) => ({
		...row,
		details_json: JSON.parse(row.details_json) as unknown,
	}))
}

function webhookFailureWarns() {
	return consoleWarn.mock.calls
		.map(([line]) => JSON.parse(String(line)) as { message?: string })
		.filter((line) => line.message === 'soft_delete_purge_webhook_failed')
}

async function orgDeletingAt(appDb: D1Database, orgId: string) {
	const row = await appDb
		.prepare(`SELECT deleting_at FROM orgs WHERE id = ?`)
		.bind(orgId)
		.first<{ deleting_at: string | null }>()
	return row?.deleting_at
}

test('scheduled purge skips the purge webhook when PURGE_WEBHOOK_URL is unset or empty', async () => {
	for (const hookUrl of [undefined, '']) {
		const { fetchMock } = stubPurgeHookFetch(
			() => new Response(null, { status: 204 }),
		)
		try {
			const sqlite = new DatabaseSync(':memory:')
			applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
			const appDb = createD1FromSqlite(sqlite)
			const auditDb = createAuditDb()
			const orgId = ownerIdFromStored('org-hard-purge')
			await seedTeamOrgGraph({ appDb, orgId, ts: '2026-01-01T00:00:00.000Z' })
			const env = purgeEnvWithHook(
				appDb,
				{ AUDIT_DB: auditDb, BUNDLE_ARTIFACTS_KV: createKv().kv },
				{ url: hookUrl },
			)

			const result = await pruneSoftDeleted({
				env,
				now: new Date('2026-03-01T00:00:00.000Z'),
				dryRun: false,
			})

			expect(result.failed, JSON.stringify(result.outcomes)).toBe(0)
			expect(result.outcomes).toEqual([
				expect.objectContaining({ kind: 'org', id: orgId, outcome: 'purged' }),
			])
			expect(
				fetchMock.mock.calls.filter(([, init]) =>
					String(init?.body ?? '').includes('purgedAt'),
				),
			).toEqual([])
			expect(
				await countRows(
					appDb,
					`SELECT COUNT(*) AS n FROM orgs WHERE id = ?`,
					orgId,
				),
			).toBe(0)
			expect(await webhookFailedAuditRows(auditDb)).toEqual([])
		} finally {
			vi.unstubAllGlobals()
		}
	}
})

test('scheduled purge POSTs the purge webhook for a team org before its D1 rows are deleted', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const appDb = createD1FromSqlite(sqlite)
	const auditDb = createAuditDb()
	const orgId = ownerIdFromStored('org-hard-purge')
	await seedTeamOrgGraph({ appDb, orgId, ts: '2026-01-01T00:00:00.000Z' })
	const rowsAtHook: Array<number | undefined> = []
	const { hookBodies } = stubPurgeHookFetch(async (body) => {
		rowsAtHook.push(
			await countRows(
				appDb,
				`SELECT COUNT(*) AS n FROM handles WHERE org_id = ?`,
				body.id,
			),
		)
		return new Response(null, { status: 204 })
	})
	try {
		const env = purgeEnvWithHook(appDb, {
			AUDIT_DB: auditDb,
			BUNDLE_ARTIFACTS_KV: createKv().kv,
		})

		const result = await pruneSoftDeleted({
			env,
			now: new Date('2026-03-01T00:00:00.000Z'),
			dryRun: false,
		})

		expect(result.failed, JSON.stringify(result.outcomes)).toBe(0)
		expect(hookBodies).toEqual([
			{ kind: 'org', id: orgId, purgedAt: expect.any(String) },
		])
		expect(new Date(hookBodies[0]!.purgedAt).toISOString()).toBe(
			hookBodies[0]!.purgedAt,
		)
		expect(rowsAtHook).toEqual([1])
		expect(
			await countRows(
				appDb,
				`SELECT COUNT(*) AS n FROM orgs WHERE id = ?`,
				orgId,
			),
		).toBe(0)
		expect(await webhookFailedAuditRows(auditDb)).toEqual([])
	} finally {
		vi.unstubAllGlobals()
	}
})

test('a non-2xx purge webhook keeps the org rows and fence, audits, reports to Sentry, lets other items finish, and retries after the backoff', async () => {
	sentryMock.captureException.mockClear()
	consoleWarn.mockImplementation(() => {})
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const appDb = createD1FromSqlite(sqlite)
	const auditDb = createAuditDb()
	const orgId = ownerIdFromStored('org-hard-purge')
	await seedTeamOrgGraph({ appDb, orgId, ts: '2026-01-01T00:00:00.000Z' })
	const otherOrgId = await seedSecondSoftDeletedTeamOrg(appDb)
	let failingId: string | null = orgId
	const { hookBodies } = stubPurgeHookFetch(
		(body) => new Response(null, { status: body.id === failingId ? 500 : 204 }),
	)
	try {
		const env = purgeEnvWithHook(appDb, {
			AUDIT_DB: auditDb,
			BUNDLE_ARTIFACTS_KV: createKv().kv,
		})
		const now = new Date('2026-03-01T00:00:00.000Z')

		const result = await pruneSoftDeleted({ env, now, dryRun: false })

		expect(result).toMatchObject({ purged: 1, failed: 1 })
		expect(result.outcomes).toEqual([
			expect.objectContaining({ kind: 'org', id: orgId, outcome: 'failed' }),
			expect.objectContaining({
				kind: 'org',
				id: otherOrgId,
				outcome: 'purged',
			}),
		])
		expect(hookBodies.map((body) => body.id)).toEqual([orgId, otherOrgId])
		expect(
			await countRows(
				appDb,
				`SELECT COUNT(*) AS n FROM orgs WHERE id = ?`,
				orgId,
			),
		).toBe(1)
		expect(
			await countRows(
				appDb,
				`SELECT COUNT(*) AS n FROM handles WHERE org_id = ?`,
				orgId,
			),
		).toBe(1)
		expect(
			await countRows(
				appDb,
				`SELECT COUNT(*) AS n FROM orgs WHERE id = ?`,
				otherOrgId,
			),
		).toBe(0)
		expect(await orgDeletingAt(appDb, orgId)).toBe(now.toISOString())
		expect(await webhookFailedAuditRows(auditDb)).toEqual([
			{
				org_id: orgId,
				result: 'failure',
				resource_type: 'org',
				resource_id: orgId,
				details_json: { kind: 'org', id: orgId, status: 500 },
			},
		])
		expect(webhookFailureWarns()).toEqual([
			{
				message: 'soft_delete_purge_webhook_failed',
				kind: 'org',
				lane: 'soft_delete',
				webhookKind: 'org',
				status: 500,
			},
		])
		expect(sentryMock.captureException).toHaveBeenCalledTimes(1)
		const reported = sentryMock.captureException.mock.calls[0]?.[0]
		expect(reported).toBeInstanceOf(PurgeWebhookFailed)
		expect(reported).toMatchObject({
			item: { kind: 'org', id: orgId },
			status: 500,
		})

		const insideBackoff = await pruneSoftDeleted({
			env,
			now: new Date('2026-03-01T01:00:00.000Z'),
			dryRun: false,
		})
		expect(insideBackoff.outcomes).toEqual([])
		expect(hookBodies).toHaveLength(2)

		failingId = null
		const afterBackoff = await pruneSoftDeleted({
			env,
			now: new Date('2026-03-01T07:00:00.000Z'),
			dryRun: false,
		})
		expect(afterBackoff.outcomes).toEqual([
			expect.objectContaining({ kind: 'org', id: orgId, outcome: 'purged' }),
		])
		expect(
			await countRows(
				appDb,
				`SELECT COUNT(*) AS n FROM orgs WHERE id = ?`,
				orgId,
			),
		).toBe(0)
	} finally {
		vi.unstubAllGlobals()
	}
})

test('a purge webhook that hits the outbound http deadline is aborted and keeps the org rows and fence', async () => {
	sentryMock.captureException.mockClear()
	consoleWarn.mockImplementation(() => {})
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const appDb = createD1FromSqlite(sqlite)
	const auditDb = createAuditDb()
	const orgId = ownerIdFromStored('org-hard-purge')
	await seedTeamOrgGraph({ appDb, orgId, ts: '2026-01-01T00:00:00.000Z' })
	const hookSignals: Array<AbortSignal> = []
	const realFetch = globalThis.fetch
	vi.stubGlobal(
		'fetch',
		vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
			if (String(url) !== purgeHookUrl) return realFetch(url, init)
			if (init?.signal) hookSignals.push(init.signal)
			return new Promise<never>(() => {})
		}),
	)
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	try {
		const env = purgeEnvWithHook(appDb, {
			AUDIT_DB: auditDb,
			BUNDLE_ARTIFACTS_KV: createKv().kv,
		})
		const now = new Date('2026-03-01T00:00:00.000Z')

		const pending = pruneSoftDeleted({ env, now, dryRun: false })
		await vi.waitFor(() => expect(hookSignals).toHaveLength(1))
		await vi.advanceTimersByTimeAsync(outboundTimeoutMs.http)
		const result = await pending

		expect(hookSignals[0]?.aborted).toBe(true)
		expect(result.outcomes).toEqual([
			expect.objectContaining({ kind: 'org', id: orgId, outcome: 'failed' }),
		])
		expect(
			await countRows(
				appDb,
				`SELECT COUNT(*) AS n FROM orgs WHERE id = ?`,
				orgId,
			),
		).toBe(1)
		expect(await orgDeletingAt(appDb, orgId)).toBe(now.toISOString())
		expect(await webhookFailedAuditRows(auditDb)).toEqual([
			{
				org_id: orgId,
				result: 'failure',
				resource_type: 'org',
				resource_id: orgId,
				details_json: { kind: 'org', id: orgId, status: null },
			},
		])
		expect(webhookFailureWarns()).toEqual([
			expect.objectContaining({ webhookKind: 'org', status: null }),
		])
		expect(sentryMock.captureException).toHaveBeenCalledWith(
			expect.any(PurgeWebhookFailed),
		)
	} finally {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	}
})

test('scheduled purge of a person and personal org POSTs both halves after Stripe cleanup and before either row is deleted', async () => {
	const listSubscriptions = vi
		.spyOn(stripeClient, 'listSubscriptions')
		.mockResolvedValue([])
	const deleteCustomer = vi
		.spyOn(stripeClient, 'deleteCustomer')
		.mockResolvedValue(undefined)
	const refund = spyOnStripeRefundClient()
	try {
		const sqlite = new DatabaseSync(':memory:')
		applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
		const appDb = createD1FromSqlite(sqlite)
		const auditDb = createAuditDb()
		const { personId, kv } = await seedSoftDeletedPersonWithPersonalOrg({
			appDb,
			stripeCustomerId: 'cus_person',
		})
		const rowsAtHook: Array<{
			users: number | undefined
			orgs: number | undefined
		}> = []
		const { fetchMock, hookBodies } = stubPurgeHookFetch(async () => {
			rowsAtHook.push({
				users: await countRows(
					appDb,
					`SELECT COUNT(*) AS n FROM users WHERE stable_user_id = ?`,
					personId,
				),
				orgs: await countRows(
					appDb,
					`SELECT COUNT(*) AS n FROM orgs WHERE id = ?`,
					personId,
				),
			})
			return new Response(null, { status: 200 })
		})
		const env = purgeEnvWithHook(appDb, {
			AUDIT_DB: auditDb,
			BUNDLE_ARTIFACTS_KV: kv,
		})

		const result = await pruneSoftDeleted({
			env,
			now: new Date('2026-03-01T00:00:00.000Z'),
			dryRun: false,
		})

		expect(result.failed, JSON.stringify(result.outcomes)).toBe(0)
		expect(hookBodies).toEqual([
			{ kind: 'user', id: personId, purgedAt: expect.any(String) },
			{ kind: 'org', id: personId, purgedAt: hookBodies[0]?.purgedAt },
		])
		expect(rowsAtHook).toEqual([
			{ users: 1, orgs: 1 },
			{ users: 1, orgs: 1 },
		])
		const firstHookCall = fetchMock.mock.calls.findIndex(
			([url]) => String(url) === purgeHookUrl,
		)
		expect(deleteCustomer).toHaveBeenCalledWith(env, 'cus_person')
		expect(deleteCustomer.mock.invocationCallOrder[0]).toBeLessThan(
			fetchMock.mock.invocationCallOrder[firstHookCall]!,
		)
		expect(
			await countRows(
				appDb,
				`SELECT COUNT(*) AS n FROM users WHERE stable_user_id = ?`,
				personId,
			),
		).toBe(0)
		expect(
			await countRows(
				appDb,
				`SELECT COUNT(*) AS n FROM orgs WHERE id = ?`,
				personId,
			),
		).toBe(0)
	} finally {
		vi.unstubAllGlobals()
		listSubscriptions.mockRestore()
		deleteCustomer.mockRestore()
		refund.restore()
	}
})

test('a purge webhook failure on either half of a person and personal org pair deletes neither half in that pass', async () => {
	consoleWarn.mockImplementation(() => {})
	for (const failingKind of ['user', 'org'] as const) {
		sentryMock.captureException.mockClear()
		consoleWarn.mockClear()
		const listSubscriptions = vi
			.spyOn(stripeClient, 'listSubscriptions')
			.mockResolvedValue([])
		const deleteCustomer = vi
			.spyOn(stripeClient, 'deleteCustomer')
			.mockResolvedValue(undefined)
		const refund = spyOnStripeRefundClient()
		const { hookBodies } = stubPurgeHookFetch(
			(body) =>
				new Response(null, { status: body.kind === failingKind ? 502 : 204 }),
		)
		try {
			const sqlite = new DatabaseSync(':memory:')
			applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
			const appDb = createD1FromSqlite(sqlite)
			const auditDb = createAuditDb()
			const { personId, kvKey, store, kv } =
				await seedSoftDeletedPersonWithPersonalOrg({
					appDb,
					stripeCustomerId: 'cus_person',
				})
			const env = purgeEnvWithHook(appDb, {
				AUDIT_DB: auditDb,
				BUNDLE_ARTIFACTS_KV: kv,
			})
			const now = new Date('2026-03-01T00:00:00.000Z')

			const result = await pruneSoftDeleted({ env, now, dryRun: false })

			expect(result.outcomes).toEqual([
				expect.objectContaining({
					kind: 'user',
					id: personId,
					outcome: 'failed',
				}),
			])
			expect(hookBodies.map((body) => body.kind)).toEqual(
				failingKind === 'user' ? ['user'] : ['user', 'org'],
			)
			const user = await appDb
				.prepare(`SELECT deleting_at FROM users WHERE stable_user_id = ?`)
				.bind(personId)
				.first<{ deleting_at: string | null }>()
			expect(user?.deleting_at).toBe(now.toISOString())
			expect(
				await countRows(
					appDb,
					`SELECT COUNT(*) AS n FROM orgs WHERE id = ?`,
					personId,
				),
			).toBe(1)
			expect(
				await countRows(
					appDb,
					`SELECT COUNT(*) AS n FROM handles WHERE org_id = ?`,
					personId,
				),
			).toBe(1)
			expect(
				await countRows(
					appDb,
					`SELECT COUNT(*) AS n FROM published_bundle_artifacts WHERE user_id = ?`,
					personId,
				),
			).toBe(1)
			expect(store.has(kvKey)).toBe(false)
			expect(await webhookFailedAuditRows(auditDb)).toEqual([
				{
					org_id: personId,
					result: 'failure',
					resource_type: failingKind,
					resource_id: personId,
					details_json: { kind: failingKind, id: personId, status: 502 },
				},
			])
			const purgedAudit = await auditDb
				.prepare(
					`SELECT COUNT(*) AS n FROM org_audit_events
					 WHERE action IN ('org.purged', 'user.purged')`,
				)
				.first<{ n: number }>()
			expect(purgedAudit?.n).toBe(0)
			expect(webhookFailureWarns()).toEqual([
				expect.objectContaining({
					kind: 'user',
					webhookKind: failingKind,
					status: 502,
				}),
			])
			expect(sentryMock.captureException).toHaveBeenCalledWith(
				expect.objectContaining({
					name: 'PurgeWebhookFailed',
					item: { kind: failingKind, id: personId },
					status: 502,
				}),
			)
		} finally {
			vi.unstubAllGlobals()
			listSubscriptions.mockRestore()
			deleteCustomer.mockRestore()
			refund.restore()
		}
	}
})
