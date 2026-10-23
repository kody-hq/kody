import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createSuccessfulDeletionEnv } from '#worker/test-support/account-deletion.ts'
import { purgePersistedMcpAgentSession } from '#mcp/session-registry.ts'

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
} = await import('./hard-purge.ts')

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

test('hardPurgeOrg leaves personal-org owner inventory for the following user purge', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const appDb = createD1FromSqlite(sqlite)
	const auditDb = createAuditDb()
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
				created_at, updated_at
			) VALUES (?, 'person-purge', 'Person', 'free', 'public', ?, ?, ?)`,
		)
		.bind(personId, ts, ts, ts)
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

	const env = createSuccessfulDeletionEnv(appDb, {
		AUDIT_DB: auditDb,
		BUNDLE_ARTIFACTS_KV: kv,
	})
	await hardPurgeOrg({ env, orgId: personId })

	const orgGone = await appDb
		.prepare(`SELECT COUNT(*) AS n FROM orgs WHERE id = ?`)
		.bind(personId)
		.first<{ n: number }>()
	expect(orgGone?.n).toBe(0)
	const handleGone = await appDb
		.prepare(`SELECT COUNT(*) AS n FROM handles WHERE org_id = ?`)
		.bind(personId)
		.first<{ n: number }>()
	expect(handleGone?.n).toBe(0)
	const membershipGone = await appDb
		.prepare(`SELECT COUNT(*) AS n FROM org_memberships WHERE org_id = ?`)
		.bind(personId)
		.first<{ n: number }>()
	expect(membershipGone?.n).toBe(0)
	const artifactRemains = await appDb
		.prepare(`SELECT kv_key FROM published_bundle_artifacts WHERE user_id = ?`)
		.bind(personId)
		.first<{ kv_key: string }>()
	expect(artifactRemains?.kv_key).toBe(kvKey)
	expect(store.has(kvKey)).toBe(true)
	const bucketRemains = await appDb
		.prepare(`SELECT COUNT(*) AS n FROM secret_buckets WHERE user_id = ?`)
		.bind(personId)
		.first<{ n: number }>()
	expect(bucketRemains?.n).toBe(1)
	const audit = await auditDb
		.prepare(`SELECT action FROM org_audit_events WHERE org_id = ?`)
		.bind(personId)
		.first<{ action: string }>()
	expect(audit?.action).toBe('org.purged')
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
