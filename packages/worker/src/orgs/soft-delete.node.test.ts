import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { provisionPersonalOrg } from './provision.ts'
import { FreeOrgLimitError, countLiveFreeOwnedOrgs } from './billing.ts'

vi.mock('./billing.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./billing.ts')>()
	return {
		...actual,
		countLiveFreeOwnedOrgs: vi.fn(actual.countLiveFreeOwnedOrgs),
	}
})
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	AccountDeletionWritersActiveError,
	OrgRestoreWindowExpiredError,
	PersonalOrgDeleteRequiresAccountDeletionError,
	UserDeleteBlockedSoleOwnerError,
	assertActorCanRestoreSoftDeletedOrg,
	assertUserDeleteNotBlockedAsSoleOwner,
	listRestorableOrganizationsForPerson,
	loadRestorableOrganizationBySlugForPerson,
	restoreOrg,
	restoreResourceRow,
	softDeleteOrg,
	softDeleteUserAccount,
} from './soft-delete.ts'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import * as JobManager from '#worker/jobs/manager-client.ts'

vi.mock('#worker/jobs/jobs-data.ts', () => ({
	jobsData: () => ({
		softDeleteJobsForUser: vi.fn(async () => 0),
		restoreJobsForUser: vi.fn(async () => 0),
	}),
	jobsService: () => null,
}))

vi.spyOn(JobManager, 'syncJobManagerAlarm').mockResolvedValue({
	ok: true,
	userId: ownerIdFromStored('mock'),
	nextRunAt: null,
})

const now = new Date('2026-10-01T12:00:00.000Z')

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

async function createHarness() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const appDb = createD1FromSqlite(sqlite)
	const auditDb = createAuditDb()
	const meter = createInMemoryUserMeterEnv()
	const env = {
		APP_DB: appDb,
		AUDIT_DB: auditDb,
		USER_METER: meter.env.USER_METER,
		STRIPE_SECRET_KEY: 'sk_test_secret',
	} as Env
	return { env, appDb, auditDb, sqlite }
}

async function seedOrg(db: D1Database, orgId: string, slug: string) {
	const ts = '2026-01-01T00:00:00.000Z'
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, plan, entitlement_ladder, created_at, updated_at)
			VALUES (?, ?, ?, 'free', 'public', ?, ?)`,
		)
		.bind(orgId, slug, slug, ts, ts)
		.run()
}

test('soft delete and restore org within the restore window', async () => {
	const { env, appDb, auditDb } = await createHarness()
	const orgId = ownerIdFromStored('org-team-alpha')
	await seedOrg(appDb, orgId, 'team-alpha')
	const deleted = await softDeleteOrg({
		env,
		orgId,
		actorUserId: 'actor-1',
		now,
	})
	expect(deleted.deletedAt).toBeTruthy()
	const tombstoned = await appDb
		.prepare(`SELECT deleted_at FROM orgs WHERE id = ?`)
		.bind(orgId)
		.first<{ deleted_at: string | null }>()
	expect(tombstoned?.deleted_at).toBe(deleted.deletedAt)
	const restoreNow = new Date(now.getTime() + 60_000)
	await restoreOrg({
		env,
		orgId,
		actorUserId: 'actor-1',
		now: restoreNow,
	})
	const live = await appDb
		.prepare(`SELECT deleted_at FROM orgs WHERE id = ?`)
		.bind(orgId)
		.first<{ deleted_at: string | null }>()
	expect(live?.deleted_at).toBeNull()
	const audits = await auditDb
		.prepare(
			`SELECT action FROM org_audit_events WHERE org_id = ? ORDER BY created_at ASC`,
		)
		.bind(orgId)
		.all<{ action: string }>()
	expect((audits.results ?? []).map((row) => row.action).sort()).toEqual([
		'org.deleted',
		'org.restored',
	])
})

test('only a deletion-generation owner can restore a soft-deleted org', async () => {
	const { env, appDb } = await createHarness()
	const orgId = ownerIdFromStored('org-restore-auth')
	const ownerId = ownerIdFromStored('owner-restore-1')
	const memberId = 'member-restore-1'
	await seedOrg(appDb, orgId, 'restore-auth')
	const ts = '2026-01-01T00:00:00.000Z'
	await appDb
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', ?), (?, ?, 'member', ?)`,
		)
		.bind(orgId, ownerId, ts, orgId, memberId, ts)
		.run()
	await softDeleteOrg({
		env,
		orgId,
		actorUserId: ownerId,
		now,
	})
	await expect(
		assertActorCanRestoreSoftDeletedOrg({
			db: appDb,
			orgId,
			actorUserId: memberId,
		}),
	).rejects.toThrow('org_restore_forbidden')
	const allowed = await assertActorCanRestoreSoftDeletedOrg({
		db: appDb,
		orgId,
		actorUserId: ownerId,
	})
	expect(allowed.deletedAt).toBeTruthy()
	expect(
		await listRestorableOrganizationsForPerson({
			db: appDb,
			actorUserId: ownerId,
			now,
		}),
	).toEqual([
		expect.objectContaining({
			orgId,
			slug: 'restore-auth',
			deletedAt: allowed.deletedAt,
		}),
	])
	expect(
		await listRestorableOrganizationsForPerson({
			db: appDb,
			actorUserId: memberId,
			now,
		}),
	).toEqual([])
	expect(
		await loadRestorableOrganizationBySlugForPerson({
			db: appDb,
			actorUserId: ownerId,
			slug: 'restore-auth',
			now,
		}),
	).toMatchObject({ orgId, slug: 'restore-auth' })
	expect(
		await loadRestorableOrganizationBySlugForPerson({
			db: appDb,
			actorUserId: memberId,
			slug: 'restore-auth',
			now,
		}),
	).toBeNull()
})

test('interrupted soft-delete still lists and restores for a live Owner', async () => {
	const { env, appDb } = await createHarness()
	const orgId = ownerIdFromStored('org-restore-interrupted')
	const ownerId = ownerIdFromStored('owner-restore-interrupted')
	await seedOrg(appDb, orgId, 'restore-interrupted')
	const ts = '2026-01-01T00:00:00.000Z'
	const deletedAt = now.toISOString()
	await appDb
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', ?)`,
		)
		.bind(orgId, ownerId, ts)
		.run()
	// Simulate softDeleteOrg stamping the org then failing before membership
	// tombstones (Owner membership stays live).
	await appDb
		.prepare(`UPDATE orgs SET deleted_at = ?, updated_at = ? WHERE id = ?`)
		.bind(deletedAt, deletedAt, orgId)
		.run()
	const allowed = await assertActorCanRestoreSoftDeletedOrg({
		db: appDb,
		orgId,
		actorUserId: ownerId,
	})
	expect(allowed.deletedAt).toBe(deletedAt)
	expect(
		await listRestorableOrganizationsForPerson({
			db: appDb,
			actorUserId: ownerId,
			now,
		}),
	).toEqual([
		expect.objectContaining({
			orgId,
			slug: 'restore-interrupted',
			deletedAt,
		}),
	])
	expect(
		await loadRestorableOrganizationBySlugForPerson({
			db: appDb,
			actorUserId: ownerId,
			slug: 'restore-interrupted',
			now,
		}),
	).toMatchObject({ orgId, slug: 'restore-interrupted' })
	await restoreOrg({
		env,
		orgId,
		actorUserId: ownerId,
		now: new Date(now.getTime() + 60_000),
	})
	const live = await appDb
		.prepare(
			`SELECT o.deleted_at AS org_deleted_at, m.deleted_at AS membership_deleted_at
			 FROM orgs o
			 INNER JOIN org_memberships m ON m.org_id = o.id AND m.user_id = ?
			 WHERE o.id = ?`,
		)
		.bind(ownerId, orgId)
		.first<{
			org_deleted_at: string | null
			membership_deleted_at: string | null
		}>()
	expect(live?.org_deleted_at).toBeNull()
	expect(live?.membership_deleted_at).toBeNull()
})

test('org soft delete revokes team-bound API tokens and bootstrap codes', async () => {
	const { env, appDb } = await createHarness()
	const orgId = ownerIdFromStored('org-token-revoke')
	const memberId = 'member-token-1'
	await seedOrg(appDb, orgId, 'token-revoke')
	const ts = '2026-01-01T00:00:00.000Z'
	await appDb
		.prepare(
			`INSERT INTO api_tokens (
				id, user_id, org_id, name, token_hash, scopes_json,
				idle_ttl_seconds, expires_at, max_expires_at, created_via,
				created_at, updated_at
			) VALUES (
				'token-team', ?, ?, 'team token', 'hash', '[]',
				3600, ?, ?, 'test', ?, ?
			)`,
		)
		.bind(memberId, orgId, ts, ts, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO api_tokens (
				id, user_id, org_id, name, token_hash, scopes_json,
				idle_ttl_seconds, expires_at, max_expires_at, created_via,
				created_at, updated_at
			) VALUES (
				'token-other', ?, 'other-org', 'other token', 'hash2', '[]',
				3600, ?, ?, 'test', ?, ?
			)`,
		)
		.bind(memberId, ts, ts, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO cli_credential_bootstrap_codes (
				id, user_id, org_id, code_hash, name, scopes_json,
				idle_ttl_seconds, max_lifetime_seconds, expires_at, created_at
			) VALUES (
				'boot-team', ?, ?, 'codehash', 'boot', '[]',
				3600, 86400, ?, ?
			)`,
		)
		.bind(memberId, orgId, ts, ts)
		.run()

	const deleted = await softDeleteOrg({
		env,
		orgId,
		actorUserId: 'actor-1',
		now,
	})
	const teamToken = await appDb
		.prepare(
			`SELECT revoked_at, deleted_at FROM api_tokens WHERE id = 'token-team'`,
		)
		.first<{ revoked_at: string | null; deleted_at: string | null }>()
	expect(teamToken?.revoked_at).toBe(deleted.deletedAt)
	expect(teamToken?.deleted_at).toBe(deleted.deletedAt)
	const otherToken = await appDb
		.prepare(
			`SELECT revoked_at, deleted_at FROM api_tokens WHERE id = 'token-other'`,
		)
		.first<{ revoked_at: string | null; deleted_at: string | null }>()
	expect(otherToken?.revoked_at).toBeNull()
	expect(otherToken?.deleted_at).toBeNull()
	const boot = await appDb
		.prepare(
			`SELECT COUNT(*) AS n FROM cli_credential_bootstrap_codes WHERE id = 'boot-team'`,
		)
		.first<{ n: number }>()
	expect(boot?.n).toBe(0)
})

test('org soft delete tombstones bucket child rows and inbox addresses', async () => {
	const { env, appDb } = await createHarness()
	const orgId = ownerIdFromStored('org-child-rows')
	await seedOrg(appDb, orgId, 'child-rows')
	const ts = '2026-01-01T00:00:00.000Z'
	await appDb
		.prepare(
			`INSERT INTO secret_buckets (
				id, user_id, scope, binding_key, created_at, updated_at
			) VALUES ('sec-bucket', ?, 'user', 'default', ?, ?)`,
		)
		.bind(orgId, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO secret_entries (
				bucket_id, name, encrypted_value, created_at, updated_at
			) VALUES ('sec-bucket', 'api-key', 'cipher', ?, ?)`,
		)
		.bind(ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO email_inboxes (
				id, user_id, name, created_at, updated_at
			) VALUES ('inbox-1', ?, 'main', ?, ?)`,
		)
		.bind(orgId, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO email_inbox_addresses (
				id, inbox_id, user_id, address, local_part, domain,
				enabled, created_at, updated_at
			) VALUES (
				'addr-1', 'inbox-1', ?, 'child@example.com', 'child', 'example.com',
				1, ?, ?
			)`,
		)
		.bind(orgId, ts, ts)
		.run()

	const deleted = await softDeleteOrg({
		env,
		orgId,
		actorUserId: 'actor-1',
		now,
	})
	const secret = await appDb
		.prepare(
			`SELECT deleted_at FROM secret_entries WHERE bucket_id = 'sec-bucket' AND name = 'api-key'`,
		)
		.first<{ deleted_at: string | null }>()
	expect(secret?.deleted_at).toBe(deleted.deletedAt)
	const address = await appDb
		.prepare(`SELECT deleted_at FROM email_inbox_addresses WHERE id = 'addr-1'`)
		.first<{ deleted_at: string | null }>()
	expect(address?.deleted_at).toBe(deleted.deletedAt)

	await restoreOrg({
		env,
		orgId,
		actorUserId: 'actor-1',
		now: new Date(now.getTime() + 60_000),
	})
	const restoredSecret = await appDb
		.prepare(
			`SELECT deleted_at FROM secret_entries WHERE bucket_id = 'sec-bucket' AND name = 'api-key'`,
		)
		.first<{ deleted_at: string | null }>()
	expect(restoredSecret?.deleted_at).toBeNull()
	const restoredAddress = await appDb
		.prepare(`SELECT deleted_at FROM email_inbox_addresses WHERE id = 'addr-1'`)
		.first<{ deleted_at: string | null }>()
	expect(restoredAddress?.deleted_at).toBeNull()
})

test('resourceRestore clears one org-owned row while the org is still soft-deleted', async () => {
	const { env, appDb } = await createHarness()
	const orgId = ownerIdFromStored('org-resource-restore')
	await seedOrg(appDb, orgId, 'resource-restore')
	const ts = '2026-01-01T00:00:00.000Z'
	await appDb
		.prepare(
			`INSERT INTO mcp_memories (
				id, user_id, subject, summary, created_at, updated_at
			) VALUES ('mem-1', ?, 'demo', 'summary', ?, ?)`,
		)
		.bind(orgId, ts, ts)
		.run()
	const deleted = await softDeleteOrg({
		env,
		orgId,
		actorUserId: 'actor-1',
		now,
	})
	const before = await appDb
		.prepare(`SELECT deleted_at FROM mcp_memories WHERE id = 'mem-1'`)
		.first<{ deleted_at: string | null }>()
	expect(before?.deleted_at).toBe(deleted.deletedAt)
	const result = await restoreResourceRow({
		env,
		orgId,
		resourceType: 'memory',
		resourceId: 'mem-1',
		now: new Date(now.getTime() + 60_000),
	})
	expect(result.restored).toBe(true)
	const after = await appDb
		.prepare(`SELECT deleted_at FROM mcp_memories WHERE id = 'mem-1'`)
		.first<{ deleted_at: string | null }>()
	expect(after?.deleted_at).toBeNull()
	const orgStillDeleted = await appDb
		.prepare(`SELECT deleted_at FROM orgs WHERE id = ?`)
		.bind(orgId)
		.first<{ deleted_at: string | null }>()
	expect(orgStillDeleted?.deleted_at).toBe(deleted.deletedAt)
})

test('org restore does not revive memberships for soft-deleted users', async () => {
	const { env, appDb } = await createHarness()
	const orgId = ownerIdFromStored('org-restore-members')
	const liveMember = 'live-member-1'
	const deletedMember = 'deleted-member-1'
	await seedOrg(appDb, orgId, 'restore-members')
	const ts = '2026-01-01T00:00:00.000Z'
	await appDb
		.prepare(
			`INSERT INTO users (
				id, email, username, password_hash, created_at, updated_at, stable_user_id
			) VALUES
				(1, 'live@example.com', 'live', 'x', ?, ?, ?),
				(2, 'gone@example.com', 'gone', 'x', ?, ?, ?)`,
		)
		.bind(ts, ts, liveMember, ts, ts, deletedMember)
		.run()
	await appDb
		.prepare(`UPDATE users SET deleted_at = ? WHERE stable_user_id = ?`)
		.bind(ts, deletedMember)
		.run()
	await appDb
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?), (?, ?, 'member', ?)`,
		)
		.bind(orgId, liveMember, ts, orgId, deletedMember, ts)
		.run()
	const deleted = await softDeleteOrg({
		env,
		orgId,
		actorUserId: 'actor-1',
		now,
	})
	await restoreOrg({
		env,
		orgId,
		actorUserId: 'actor-1',
		now: new Date(now.getTime() + 60_000),
	})
	const live = await appDb
		.prepare(
			`SELECT deleted_at FROM org_memberships WHERE org_id = ? AND user_id = ?`,
		)
		.bind(orgId, liveMember)
		.first<{ deleted_at: string | null }>()
	expect(live?.deleted_at).toBeNull()
	const gone = await appDb
		.prepare(
			`SELECT deleted_at FROM org_memberships WHERE org_id = ? AND user_id = ?`,
		)
		.bind(orgId, deletedMember)
		.first<{ deleted_at: string | null }>()
	expect(gone?.deleted_at).toBe(deleted.deletedAt)
})

test('restore outside the 30-day window fails', async () => {
	const { env, appDb } = await createHarness()
	const orgId = ownerIdFromStored('org-old-delete')
	await seedOrg(appDb, orgId, 'old-delete')
	const oldDeletedAt = '2025-08-01T00:00:00.000Z'
	await appDb
		.prepare(`UPDATE orgs SET deleted_at = ?, updated_at = ? WHERE id = ?`)
		.bind(oldDeletedAt, oldDeletedAt, orgId)
		.run()
	await expect(
		restoreOrg({ env, orgId, now: new Date('2026-10-01T00:00:00.000Z') }),
	).rejects.toBeInstanceOf(OrgRestoreWindowExpiredError)
})

test('user delete blocked when sole owner of multi-member org', async () => {
	const { appDb } = await createHarness()
	const ownerId = testStableUserIdFromEmail('owner@example.com')
	const memberId = testStableUserIdFromEmail('member@example.com')
	const orgId = ownerIdFromStored('org-shared')
	await seedOrg(appDb, orgId, 'shared')
	const ts = '2026-01-01T00:00:00.000Z'
	await appDb
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			VALUES (?, ?, 'owner', ?), (?, ?, 'member', ?)`,
		)
		.bind(orgId, ownerId, ts, orgId, memberId, ts)
		.run()
	await expect(
		assertUserDeleteNotBlockedAsSoleOwner({
			db: appDb,
			userId: ownerIdFromStored(ownerId),
		}),
	).rejects.toBeInstanceOf(UserDeleteBlockedSoleOwnerError)
})

test('softDeleteOrg refuses a live personal org; account deletion soft-deletes it', async () => {
	const { env, appDb, auditDb } = await createHarness()
	const stableUserId = testStableUserIdFromEmail('solo@example.com')
	const ts = '2026-01-01T00:00:00.000Z'
	await appDb
		.prepare(
			`INSERT INTO users (
				id, email, username, password_hash, created_at, updated_at, stable_user_id
			) VALUES (90001, 'solo@example.com', 'solo', 'x', ?, ?, ?)`,
		)
		.bind(ts, ts, stableUserId)
		.run()
	await provisionPersonalOrg(appDb, {
		stableUserId,
		username: 'solo',
		createdAt: ts,
		plan: 'free',
	})
	await expect(
		softDeleteOrg({
			env,
			orgId: ownerIdFromStored(stableUserId),
			actorUserId: stableUserId,
			now,
		}),
	).rejects.toBeInstanceOf(PersonalOrgDeleteRequiresAccountDeletionError)

	const deleted = await softDeleteUserAccount({
		env,
		userId: ownerIdFromStored(stableUserId),
		now,
	})
	expect(deleted.deletedOrgIds).toEqual([stableUserId])
	const orgAudit = await auditDb
		.prepare(
			`SELECT action FROM org_audit_events WHERE org_id = ? AND action = 'org.deleted'`,
		)
		.bind(stableUserId)
		.first<{ action: string }>()
	expect(orgAudit?.action).toBe('org.deleted')
	const userAudit = await auditDb
		.prepare(
			`SELECT action FROM org_audit_events WHERE org_id = ? AND action = 'user.deleted'`,
		)
		.bind(stableUserId)
		.first<{ action: string }>()
	expect(userAudit?.action).toBe('user.deleted')
})

test('softDeleteUserAccount resumes after a sole-member org lease refusal', async () => {
	const { env, appDb } = await createHarness()
	const stableUserId = testStableUserIdFromEmail('lease-busy@example.com')
	const ts = '2026-01-01T00:00:00.000Z'
	await appDb
		.prepare(
			`INSERT INTO users (
				id, email, username, password_hash, created_at, updated_at, stable_user_id
			) VALUES (91001, 'lease-busy@example.com', 'leasebusy', 'x', ?, ?, ?)`,
		)
		.bind(ts, ts, stableUserId)
		.run()
	await provisionPersonalOrg(appDb, {
		stableUserId,
		username: 'leasebusy',
		createdAt: ts,
		plan: 'free',
	})

	let releaseLease!: () => void
	const hold = new Promise<void>((resolve) => {
		releaseLease = resolve
	})
	let leaseAcquired!: () => void
	const acquired = new Promise<void>((resolve) => {
		leaseAcquired = resolve
	})
	const writePromise = withAccountWriteLease({
		db: appDb,
		stableUserId: ownerIdFromStored(stableUserId),
		env,
		holder: 'packageSave',
		write: async () => {
			leaseAcquired()
			await hold
			return 'saved'
		},
	})
	await acquired

	await expect(
		softDeleteUserAccount({
			env,
			userId: ownerIdFromStored(stableUserId),
			now,
		}),
	).rejects.toBeInstanceOf(AccountDeletionWritersActiveError)

	const personAfterRefuse = await appDb
		.prepare(`SELECT deleted_at FROM users WHERE stable_user_id = ?`)
		.bind(stableUserId)
		.first<{ deleted_at: string | null }>()
	expect(personAfterRefuse?.deleted_at).toBe(now.toISOString())
	const orgAfterRefuse = await appDb
		.prepare(`SELECT deleted_at, deleting_at FROM orgs WHERE id = ?`)
		.bind(stableUserId)
		.first<{ deleted_at: string | null; deleting_at: string | null }>()
	expect(orgAfterRefuse?.deleted_at).toBeNull()
	expect(orgAfterRefuse?.deleting_at).toBeNull()

	releaseLease()
	await expect(writePromise).resolves.toBe('saved')

	await expect(
		softDeleteUserAccount({
			env,
			userId: ownerIdFromStored(stableUserId),
			now,
		}),
	).resolves.toMatchObject({
		userId: stableUserId,
		deletedAt: now.toISOString(),
		deletedOrgIds: [stableUserId],
	})
	const orgAfterResume = await appDb
		.prepare(`SELECT deleted_at FROM orgs WHERE id = ?`)
		.bind(stableUserId)
		.first<{ deleted_at: string | null }>()
	expect(orgAfterResume?.deleted_at).toBe(now.toISOString())
	const audits = await env.AUDIT_DB.prepare(
		`SELECT action, details_json FROM org_audit_events
		 WHERE org_id = ? AND action = 'user.deleted'`,
	)
		.bind(stableUserId)
		.all<{ action: string; details_json: string }>()
	expect(audits.results).toHaveLength(1)
	expect(audits.results?.[0]?.details_json).toContain('"resumed":true')
})

test('softDeleteOrg refuses while an org OwnerId write lease is held', async () => {
	const { env, appDb } = await createHarness()
	const orgId = ownerIdFromStored('org-lease-busy')
	await seedOrg(appDb, orgId, 'lease-busy')

	let releaseLease!: () => void
	const hold = new Promise<void>((resolve) => {
		releaseLease = resolve
	})
	let leaseAcquired!: () => void
	const acquired = new Promise<void>((resolve) => {
		leaseAcquired = resolve
	})
	const writePromise = withAccountWriteLease({
		db: appDb,
		stableUserId: orgId,
		env,
		holder: 'packageSave',
		write: async () => {
			leaseAcquired()
			await hold
			return 'saved'
		},
	})
	await acquired

	await expect(
		softDeleteOrg({
			env,
			orgId,
			actorUserId: 'actor-1',
			now,
		}),
	).rejects.toBeInstanceOf(AccountDeletionWritersActiveError)

	const stillLive = await appDb
		.prepare(`SELECT deleted_at, deleting_at FROM orgs WHERE id = ?`)
		.bind(orgId)
		.first<{ deleted_at: string | null; deleting_at: string | null }>()
	expect(stillLive?.deleted_at).toBeNull()
	expect(stillLive?.deleting_at).toBeNull()

	releaseLease()
	await expect(writePromise).resolves.toBe('saved')

	await expect(
		softDeleteOrg({
			env,
			orgId,
			actorUserId: 'actor-1',
			now,
		}),
	).resolves.toMatchObject({ orgId })
})

test('retrying an org soft-delete finishes the same generation', async () => {
	const { env, appDb } = await createHarness()
	const orgId = ownerIdFromStored('org-resume')
	await seedOrg(appDb, orgId, 'resume')
	const ts = '2026-01-01T00:00:00.000Z'
	await appDb
		.prepare(
			`INSERT INTO secret_buckets (
				id, user_id, scope, binding_key, created_at, updated_at
			) VALUES ('sec-resume', ?, 'user', 'default', ?, ?)`,
		)
		.bind(orgId, ts, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO secret_entries (
				bucket_id, name, encrypted_value, created_at, updated_at
			) VALUES ('sec-resume', 'api-key', 'cipher', ?, ?)`,
		)
		.bind(ts, ts)
		.run()
	const deleted = await softDeleteOrg({
		env,
		orgId,
		actorUserId: 'actor-1',
		now,
	})
	expect(deleted.resumed).toBe(false)
	await appDb
		.prepare(
			`UPDATE secret_buckets SET deleted_at = NULL WHERE id = 'sec-resume'`,
		)
		.run()
	await appDb
		.prepare(
			`UPDATE secret_entries SET deleted_at = NULL
			 WHERE bucket_id = 'sec-resume' AND name = 'api-key'`,
		)
		.run()
	const later = new Date(now.getTime() + 60_000)
	const resumed = await softDeleteOrg({
		env,
		orgId,
		actorUserId: 'actor-1',
		now: later,
	})
	expect(resumed.resumed).toBe(true)
	expect(resumed.deletedAt).toBe(deleted.deletedAt)
	expect(resumed.deletedAt).not.toBe(later.toISOString())
	const org = await appDb
		.prepare(`SELECT deleted_at FROM orgs WHERE id = ?`)
		.bind(orgId)
		.first<{ deleted_at: string }>()
	expect(org?.deleted_at).toBe(deleted.deletedAt)
	const bucket = await appDb
		.prepare(`SELECT deleted_at FROM secret_buckets WHERE id = 'sec-resume'`)
		.first<{ deleted_at: string | null }>()
	expect(bucket?.deleted_at).toBe(deleted.deletedAt)
	const entry = await appDb
		.prepare(
			`SELECT deleted_at FROM secret_entries
			 WHERE bucket_id = 'sec-resume' AND name = 'api-key'`,
		)
		.first<{ deleted_at: string | null }>()
	expect(entry?.deleted_at).toBe(deleted.deletedAt)
})

test('retrying a user soft-delete finishes sole-org rows from the same generation', async () => {
	const { env, appDb } = await createHarness()
	const userId = testStableUserIdFromEmail('resume-user@example.com')
	const orgId = ownerIdFromStored('org-user-resume')
	const ts = '2026-01-01T00:00:00.000Z'
	await appDb
		.prepare(
			`INSERT INTO users (
				id, email, username, password_hash, created_at, updated_at, stable_user_id
			) VALUES (11, 'resume-user@example.com', 'resumeuser', 'x', ?, ?, ?)`,
		)
		.bind(ts, ts, userId)
		.run()
	await seedOrg(appDb, orgId, 'user-resume')
	await appDb
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', ?)`,
		)
		.bind(orgId, userId, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO secret_buckets (
				id, user_id, scope, binding_key, created_at, updated_at
			) VALUES ('sec-user-resume', ?, 'user', 'default', ?, ?)`,
		)
		.bind(orgId, ts, ts)
		.run()
	const deleted = await softDeleteUserAccount({
		env,
		userId: ownerIdFromStored(userId),
		now,
	})
	expect(deleted.resumed).toBe(false)
	expect(deleted.deletedOrgIds).toEqual([orgId])
	await appDb
		.prepare(
			`UPDATE secret_buckets SET deleted_at = NULL WHERE id = 'sec-user-resume'`,
		)
		.run()
	const later = new Date(now.getTime() + 60_000)
	const resumed = await softDeleteUserAccount({
		env,
		userId: ownerIdFromStored(userId),
		now: later,
	})
	expect(resumed.resumed).toBe(true)
	expect(resumed.deletedAt).toBe(deleted.deletedAt)
	const user = await appDb
		.prepare(`SELECT deleted_at FROM users WHERE stable_user_id = ?`)
		.bind(userId)
		.first<{ deleted_at: string }>()
	expect(user?.deleted_at).toBe(deleted.deletedAt)
	const bucket = await appDb
		.prepare(
			`SELECT deleted_at FROM secret_buckets WHERE id = 'sec-user-resume'`,
		)
		.first<{ deleted_at: string | null }>()
	expect(bucket?.deleted_at).toBe(deleted.deletedAt)
})

test('retrying a user soft-delete revokes org credentials left by a partial offboard', async () => {
	const { env, appDb } = await createHarness()
	const userId = testStableUserIdFromEmail('partial-offboard@example.com')
	const ownerId = testStableUserIdFromEmail('partial-owner@example.com')
	const orgId = ownerIdFromStored('org-partial-offboard')
	const ts = '2026-01-01T00:00:00.000Z'
	const deletedAt = now.toISOString()
	await appDb
		.prepare(
			`INSERT INTO users (
				id, email, username, password_hash, created_at, updated_at,
				stable_user_id, deleted_at
			) VALUES
				(21, 'partial-owner@example.com', 'partialowner', 'x', ?, ?, ?, NULL),
				(22, 'partial-offboard@example.com', 'partialmember', 'x', ?, ?, ?, ?)`,
		)
		.bind(ts, ts, ownerId, ts, ts, userId, deletedAt)
		.run()
	await seedOrg(appDb, orgId, 'partial-offboard')
	await appDb
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at, deleted_at)
			 VALUES (?, ?, 'owner', ?, NULL), (?, ?, 'member', ?, ?)`,
		)
		.bind(orgId, ownerId, ts, orgId, userId, ts, deletedAt)
		.run()
	await appDb
		.prepare(
			`INSERT INTO api_tokens (
				id, user_id, org_id, name, token_hash, scopes_json,
				idle_ttl_seconds, expires_at, max_expires_at, created_via,
				created_at, updated_at
			) VALUES (
				'token-partial', ?, ?, 'team token', 'hash', '[]',
				3600, ?, ?, 'test', ?, ?
			)`,
		)
		.bind(userId, orgId, ts, ts, ts, ts)
		.run()
	const resumed = await softDeleteUserAccount({
		env,
		userId: ownerIdFromStored(userId),
		now: new Date(now.getTime() + 60_000),
	})
	expect(resumed.resumed).toBe(true)
	expect(resumed.deletedAt).toBe(deletedAt)
	const token = await appDb
		.prepare(`SELECT revoked_at FROM api_tokens WHERE id = 'token-partial'`)
		.first<{ revoked_at: string | null }>()
	expect(token?.revoked_at).toBe(deletedAt)
})

test('a user-delete retry does not soft-delete a shared org after the other member leaves', async () => {
	const { env, appDb } = await createHarness()
	const userId = testStableUserIdFromEmail('alice-retry@example.com')
	const otherId = testStableUserIdFromEmail('bob-left@example.com')
	const orgId = ownerIdFromStored('org-shared-retry')
	const ts = '2026-01-01T00:00:00.000Z'
	const deletedAt = now.toISOString()
	await appDb
		.prepare(
			`INSERT INTO users (
				id, email, username, password_hash, created_at, updated_at,
				stable_user_id, deleted_at
			) VALUES
				(31, 'alice-retry@example.com', 'aliceretry', 'x', ?, ?, ?, ?),
				(32, 'bob-left@example.com', 'bobleft', 'x', ?, ?, ?, NULL)`,
		)
		.bind(ts, ts, userId, deletedAt, ts, ts, otherId)
		.run()
	await seedOrg(appDb, orgId, 'shared-retry')
	await appDb
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at, deleted_at)
			 VALUES (?, ?, 'member', ?, ?), (?, ?, 'owner', ?, ?)`,
		)
		.bind(orgId, userId, ts, deletedAt, orgId, otherId, ts, deletedAt)
		.run()
	await appDb
		.prepare(
			`INSERT INTO secret_buckets (
				id, user_id, scope, binding_key, created_at, updated_at
			) VALUES ('sec-shared-retry', ?, 'user', 'default', ?, ?)`,
		)
		.bind(orgId, ts, ts)
		.run()

	const resumed = await softDeleteUserAccount({
		env,
		userId: ownerIdFromStored(userId),
		now: new Date(now.getTime() + 60_000),
	})
	expect(resumed.deletedOrgIds).toEqual([])
	const org = await appDb
		.prepare(`SELECT deleted_at FROM orgs WHERE id = ?`)
		.bind(orgId)
		.first<{ deleted_at: string | null }>()
	expect(org?.deleted_at).toBeNull()
	const bucket = await appDb
		.prepare(
			`SELECT deleted_at FROM secret_buckets WHERE id = 'sec-shared-retry'`,
		)
		.first<{ deleted_at: string | null }>()
	expect(bucket?.deleted_at).toBeNull()
})

test('restoring a free org refuses when an Owner is already at the free-org cap', async () => {
	const { env, appDb } = await createHarness()
	const ownerId = 'owner-at-cap'
	const ts = '2026-01-01T00:00:00.000Z'
	for (const [orgId, slug] of [
		['org-cap-a', 'cap-a'],
		['org-cap-b', 'cap-b'],
		['org-cap-c', 'cap-c'],
	] as const) {
		await seedOrg(appDb, orgId, slug)
		await appDb
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, 'owner', ?)`,
			)
			.bind(orgId, ownerId, ts)
			.run()
	}
	await appDb
		.prepare(
			`INSERT INTO handles (handle, user_id, created_at) VALUES ('capowner', ?, ?)`,
		)
		.bind(ownerId, ts)
		.run()
	await appDb
		.prepare(
			`INSERT INTO users (id, email, username, password_hash, created_at, updated_at, stable_user_id)
			 VALUES (41, 'capowner@example.com', 'capowner', 'x', ?, ?, ?)`,
		)
		.bind(ts, ts, ownerId)
		.run()
	await softDeleteOrg({
		env,
		orgId: ownerIdFromStored('org-cap-a'),
		actorUserId: ownerId,
		now,
	})
	const restoreNow = new Date(now.getTime() + 60_000)
	await expect(
		restoreOrg({
			env,
			orgId: ownerIdFromStored('org-cap-a'),
			actorUserId: ownerId,
			now: restoreNow,
		}),
	).rejects.toThrow(
		'Restoring this organization would give @capowner more than 2 free organizations.',
	)
	const stillDeleted = await appDb
		.prepare(`SELECT deleted_at FROM orgs WHERE id = ?`)
		.bind('org-cap-a')
		.first<{ deleted_at: string | null }>()
	expect(stillDeleted?.deleted_at).toBeTruthy()

	// A paid org restores regardless of the cap.
	await appDb
		.prepare(`UPDATE orgs SET plan = 'pro' WHERE id = ?`)
		.bind('org-cap-a')
		.run()
	await restoreOrg({
		env,
		orgId: ownerIdFromStored('org-cap-a'),
		actorUserId: ownerId,
		now: restoreNow,
	})

	// Under the cap, a free org restores.
	await softDeleteOrg({
		env,
		orgId: ownerIdFromStored('org-cap-b'),
		actorUserId: ownerId,
		now,
	})
	await appDb
		.prepare(`UPDATE orgs SET plan = 'pro' WHERE id = ?`)
		.bind('org-cap-c')
		.run()
	await restoreOrg({
		env,
		orgId: ownerIdFromStored('org-cap-b'),
		actorUserId: ownerId,
		now: restoreNow,
	})
	const live = await appDb
		.prepare(`SELECT deleted_at FROM orgs WHERE id = ?`)
		.bind('org-cap-b')
		.first<{ deleted_at: string | null }>()
	expect(live?.deleted_at).toBeNull()
	const membership = await appDb
		.prepare(
			`SELECT deleted_at FROM org_memberships WHERE org_id = ? AND user_id = ?`,
		)
		.bind('org-cap-b', ownerId)
		.first<{ deleted_at: string | null }>()
	expect(membership?.deleted_at).toBeNull()
	expect(await countLiveFreeOwnedOrgs(appDb, ownerId)).toBe(1)
})

test('restoring a tombstoned org with a stale Stripe plan still enforces the free-org cap', async () => {
	const { env, appDb } = await createHarness()
	const ownerId = testStableUserIdFromEmail('stripe-paid-restore@example.com')
	const ts = '2026-01-01T00:00:00.000Z'
	await appDb
		.prepare(
			`INSERT INTO users (id, email, username, password_hash, created_at, updated_at, stable_user_id)
			 VALUES (45, 'stripe-paid-restore@example.com', 'stripepaidrestore', 'x', ?, ?, ?)`,
		)
		.bind(ts, ts, ownerId)
		.run()
	for (const [orgId, slug] of [
		['org-stripe-cap-free-a', 'stripe-cap-free-a'],
		['org-stripe-cap-free-b', 'stripe-cap-free-b'],
		['org-stripe-cap-paid', 'stripe-cap-paid'],
	] as const) {
		await seedOrg(appDb, orgId, slug)
		await appDb
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, 'owner', ?)`,
			)
			.bind(orgId, ownerId, ts)
			.run()
	}
	await appDb
		.prepare(`UPDATE orgs SET stripe_plan = 'pro' WHERE id = ?`)
		.bind('org-stripe-cap-paid')
		.run()
	await softDeleteOrg({
		env,
		orgId: ownerIdFromStored('org-stripe-cap-paid'),
		actorUserId: ownerId,
		now,
	})
	await appDb
		.prepare(`UPDATE orgs SET stripe_plan = 'pro' WHERE id = ?`)
		.bind('org-stripe-cap-paid')
		.run()

	await expect(
		restoreOrg({
			env,
			orgId: ownerIdFromStored('org-stripe-cap-paid'),
			actorUserId: ownerId,
			now: new Date(now.getTime() + 60_000),
		}),
	).rejects.toBeInstanceOf(FreeOrgLimitError)
	const restored = await appDb
		.prepare(`SELECT deleted_at FROM orgs WHERE id = ?`)
		.bind('org-stripe-cap-paid')
		.first<{ deleted_at: string | null }>()
	expect(restored?.deleted_at).toBeTruthy()
	expect(await countLiveFreeOwnedOrgs(appDb, ownerId)).toBe(2)
})

test('restoring a manual-free org counts other live orgs by effective plan', async () => {
	const { env, appDb } = await createHarness()
	const ownerId = testStableUserIdFromEmail(
		'restore-live-stripe-paid@example.com',
	)
	const ts = '2026-01-01T00:00:00.000Z'
	await appDb
		.prepare(
			`INSERT INTO users (id, email, username, password_hash, created_at, updated_at, stable_user_id)
			 VALUES (46, 'restore-live-stripe-paid@example.com', 'restorestripepaid', 'x', ?, ?, ?)`,
		)
		.bind(ts, ts, ownerId)
		.run()
	for (const [orgId, slug] of [
		['org-restore-live-free', 'restore-live-free'],
		['org-restore-live-paid', 'restore-live-paid'],
		['org-restore-manual-free', 'restore-manual-free'],
	] as const) {
		await seedOrg(appDb, orgId, slug)
		await appDb
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, 'owner', ?)`,
			)
			.bind(orgId, ownerId, ts)
			.run()
	}
	await appDb
		.prepare(`UPDATE orgs SET stripe_plan = 'pro' WHERE id = ?`)
		.bind('org-restore-live-paid')
		.run()
	await softDeleteOrg({
		env,
		orgId: ownerIdFromStored('org-restore-manual-free'),
		actorUserId: ownerId,
		now,
	})

	await expect(
		restoreOrg({
			env,
			orgId: ownerIdFromStored('org-restore-manual-free'),
			actorUserId: ownerId,
			now: new Date(now.getTime() + 60_000),
		}),
	).resolves.toBeDefined()
	expect(await countLiveFreeOwnedOrgs(appDb, ownerId)).toBe(2)
})

test('restore refreshes a linked Stripe customer and clears a canceled subscription plan', async () => {
	const { env, appDb } = await createHarness()
	const orgId = ownerIdFromStored('org-restore-stripe-refresh')
	await seedOrg(appDb, orgId, 'restore-stripe-refresh')
	await softDeleteOrg({ env, orgId, now })
	await appDb
		.prepare(
			`UPDATE orgs
			 SET stripe_customer_id = 'cus_restore_refresh', stripe_plan = 'pro'
			 WHERE id = ?`,
		)
		.bind(orgId)
		.run()
	const fetchMock = vi.fn(
		async () =>
			new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
	)
	vi.stubGlobal('fetch', fetchMock)
	try {
		await restoreOrg({
			env,
			orgId,
			now: new Date(now.getTime() + 60_000),
		})
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(
			await appDb
				.prepare(`SELECT stripe_plan FROM orgs WHERE id = ?`)
				.bind(orgId)
				.first<{ stripe_plan: string | null }>(),
		).toMatchObject({ stripe_plan: null })
	} finally {
		vi.unstubAllGlobals()
	}
})

test('a failed Stripe refresh does not fail an org restore', async () => {
	const { env, appDb } = await createHarness()
	const orgId = ownerIdFromStored('org-restore-stripe-failure')
	await seedOrg(appDb, orgId, 'restore-stripe-failure')
	await softDeleteOrg({ env, orgId, now })
	await appDb
		.prepare(
			`UPDATE orgs
			 SET stripe_customer_id = 'cus_restore_failure', stripe_plan = 'pro'
			 WHERE id = ?`,
		)
		.bind(orgId)
		.run()
	const error = new Error('Stripe unavailable')
	const fetchMock = vi.fn(async () => {
		throw error
	})
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	vi.stubGlobal('fetch', fetchMock)
	try {
		await expect(
			restoreOrg({
				env,
				orgId,
				now: new Date(now.getTime() + 60_000),
			}),
		).resolves.toBeDefined()
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(warn).toHaveBeenCalledWith('org-restore-stripe-refresh-failed', {
			orgId,
			error: expect.any(Error),
		})
		expect(
			await appDb
				.prepare(`SELECT deleted_at FROM orgs WHERE id = ?`)
				.bind(orgId)
				.first<{ deleted_at: string | null }>(),
		).toMatchObject({ deleted_at: null })
	} finally {
		warn.mockRestore()
		vi.unstubAllGlobals()
	}
})

test('the restore UPDATE refuses when a concurrent restore filled the free-org cap first', async () => {
	const { env, appDb } = await createHarness()
	const ownerId = 'owner-racing'
	const ts = '2026-01-01T00:00:00.000Z'
	await appDb
		.prepare(
			`INSERT INTO users (id, email, username, password_hash, created_at, updated_at, stable_user_id)
			 VALUES (42, 'racer@example.com', 'racer', 'x', ?, ?, ?)`,
		)
		.bind(ts, ts, ownerId)
		.run()
	for (const [orgId, slug] of [
		['org-race-live', 'race-live'],
		['org-race-a', 'race-a'],
		['org-race-b', 'race-b'],
	] as const) {
		await seedOrg(appDb, orgId, slug)
		await appDb
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, 'owner', ?)`,
			)
			.bind(orgId, ownerId, ts)
			.run()
	}
	await softDeleteOrg({
		env,
		orgId: ownerIdFromStored('org-race-a'),
		actorUserId: ownerId,
		now,
	})
	await softDeleteOrg({
		env,
		orgId: ownerIdFromStored('org-race-b'),
		actorUserId: ownerId,
		now,
	})
	const restoreNow = new Date(now.getTime() + 60_000)
	await restoreOrg({
		env,
		orgId: ownerIdFromStored('org-race-a'),
		actorUserId: ownerId,
		now: restoreNow,
	})
	expect(await countLiveFreeOwnedOrgs(appDb, ownerId)).toBe(2)

	// Stand in for a restore whose pre-check read the cap before org-race-a
	// went live: the pre-check passes, the guarded UPDATE must still refuse.
	vi.mocked(countLiveFreeOwnedOrgs).mockResolvedValueOnce(1)
	await expect(
		restoreOrg({
			env,
			orgId: ownerIdFromStored('org-race-b'),
			actorUserId: ownerId,
			now: restoreNow,
		}),
	).rejects.toBeInstanceOf(FreeOrgLimitError)
	const rows = await appDb
		.prepare(
			`SELECT o.deleted_at AS org_deleted_at, m.deleted_at AS membership_deleted_at
			 FROM orgs o INNER JOIN org_memberships m ON m.org_id = o.id
			 WHERE o.id = 'org-race-b'`,
		)
		.first<{
			org_deleted_at: string | null
			membership_deleted_at: string | null
		}>()
	expect(rows?.org_deleted_at).toBeTruthy()
	expect(rows?.membership_deleted_at).toBeTruthy()
	expect(await countLiveFreeOwnedOrgs(appDb, ownerId)).toBe(2)
})

test('a deleted co-Owner does not count against the free-org cap on restore', async () => {
	const { env, appDb } = await createHarness()
	const live = 'owner-live-co'
	const gone = 'owner-gone-co'
	const ts = '2026-01-01T00:00:00.000Z'
	await appDb
		.prepare(
			`INSERT INTO users (id, email, username, password_hash, created_at, updated_at, stable_user_id)
			 VALUES (43, 'live-co@example.com', 'liveco', 'x', ?, ?, ?),
			        (44, 'gone-co@example.com', 'goneco', 'x', ?, ?, ?)`,
		)
		.bind(ts, ts, live, ts, ts, gone)
		.run()
	await seedOrg(appDb, 'org-shared-co', 'shared-co')
	await appDb
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES ('org-shared-co', ?, 'owner', ?), ('org-shared-co', ?, 'owner', ?)`,
		)
		.bind(live, ts, gone, ts)
		.run()
	// The departed Owner still owns two live free orgs from an interrupted
	// account deletion.
	for (const [orgId, slug] of [
		['org-gone-1', 'gone-1'],
		['org-gone-2', 'gone-2'],
	] as const) {
		await seedOrg(appDb, orgId, slug)
		await appDb
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, 'owner', ?)`,
			)
			.bind(orgId, gone, ts)
			.run()
	}
	await softDeleteOrg({
		env,
		orgId: ownerIdFromStored('org-shared-co'),
		actorUserId: live,
		now,
	})
	await appDb
		.prepare(`UPDATE users SET deleted_at = ? WHERE stable_user_id = ?`)
		.bind(now.toISOString(), gone)
		.run()
	await restoreOrg({
		env,
		orgId: ownerIdFromStored('org-shared-co'),
		actorUserId: live,
		now: new Date(now.getTime() + 60_000),
	})
	const rows = await appDb
		.prepare(
			`SELECT user_id, deleted_at FROM org_memberships WHERE org_id = 'org-shared-co' ORDER BY user_id`,
		)
		.all<{ user_id: string; deleted_at: string | null }>()
	expect(rows.results).toEqual([
		{ user_id: gone, deleted_at: expect.any(String) },
		{ user_id: live, deleted_at: null },
	])
})
