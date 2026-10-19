import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { adminUserAccountDeleteCapability } from '#mcp/capabilities/admin/admin-user-account-delete.ts'
import { isUsernameClaimedInIdentity } from '#worker/identity/generated-username.ts'
import { getOrgHandleClaimError } from '#worker/orgs/org-handle-claim.ts'
import { createSuccessfulDeletionEnv } from '#worker/test-support/account-deletion.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { softDeleteUserAccount } from '#worker/orgs/soft-delete.ts'
import {
	approveAdminAccountDeletion,
	deleteAdminUserAccount,
	createAdminAccountDeletionApproval,
	executeAdminAccountHardDelete,
	loadAdminAccountDeletionSummary,
	readAdminAccountDeletionApproval,
} from './account-hard-delete.ts'

const createdAt = '2026-01-03T00:00:00.000Z'

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
		get: async (key: string) => store.get(key) ?? null,
		put: async (key: string, value: string) => {
			store.set(key, value)
		},
		delete: async (key: string) => {
			store.delete(key)
		},
		list: async () => ({ keys: [], list_complete: true as const }),
	}
}

function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const appDb = createD1FromSqlite(sqlite)
	const base = createSuccessfulDeletionEnv(appDb, {
		AUDIT_DB: createAuditDb(),
		BUNDLE_ARTIFACTS_KV: createKv(),
	})
	const jobs = base.JOBS as unknown as Record<string, unknown>
	const env = {
		...base,
		APP_BASE_URL: 'https://example.com',
		COOKIE_SECRET: 'cookie-secret-cookie-secret-cookie',
		MCP_OBJECT: {
			idFromString: (id: string) => id,
			get: () => ({
				purgeForAccountDeletion: async () => undefined,
			}),
		},
		JOBS: {
			...jobs,
			countJobsForUser: async () => 1,
			listJobIdsForUser: async () => [],
			listJobStorageIdsForUser: async () => [],
			listJobsForUser: async () => [],
			softDeleteJobsForUser: async () => 0,
			restoreJobsForUser: async () => 0,
			getJobById: async () => null,
			purgeUser: async ({ userId }: { userId: string }) => ({
				ok: true as const,
				userId,
				purged: true,
			}),
			purgeUserJobsData: async () => undefined,
			syncAlarm: async ({ userId }: { userId: string }) => ({
				ok: true as const,
				userId,
				nextRunAt: null,
			}),
		},
	} as unknown as Env
	return { env, appDb }
}

async function seedPerson(
	db: D1Database,
	input: {
		id: number
		username: string
		email: string
		plan?: string
		admin?: boolean
	},
) {
	const stableUserId = testStableUserIdFromEmail(input.email)
	await db
		.prepare(
			`INSERT INTO users (
				id, username, email, password_hash, stable_user_id, personal_org_id,
				created_at, updated_at
			) VALUES (?, ?, ?, 'hash', ?, ?, ?, ?)`,
		)
		.bind(
			input.id,
			input.username,
			input.email,
			stableUserId,
			stableUserId,
			createdAt,
			createdAt,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO orgs (
				id, slug, display_name, plan, entitlement_ladder, created_at, updated_at
			) VALUES (?, ?, ?, ?, 'public', ?, ?)`,
		)
		.bind(
			stableUserId,
			input.username,
			input.username,
			input.plan ?? 'free',
			createdAt,
			createdAt,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', ?)`,
		)
		.bind(stableUserId, stableUserId, createdAt)
		.run()
	await db
		.prepare(
			`INSERT INTO handles (handle, user_id, org_id, created_at)
			 VALUES (?, ?, ?, ?)`,
		)
		.bind(input.username, stableUserId, stableUserId, createdAt)
		.run()
	await db
		.prepare(
			`INSERT INTO user_roles (user_id, role_id)
			 SELECT ?, id FROM roles WHERE name = 'user'`,
		)
		.bind(input.id)
		.run()
	if (input.admin) {
		await db
			.prepare(
				`INSERT INTO user_roles (user_id, role_id)
				 SELECT ?, id FROM roles WHERE name = 'admin'`,
			)
			.bind(input.id)
			.run()
	}
	return stableUserId
}

function caller(
	env: Env,
	stableUserId: string,
	roles: Array<string>,
	email = 'admin@example.com',
) {
	return {
		env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			user: {
				userId: personIdFromStored(stableUserId),
				email,
				displayName: 'admin',
				roles,
			},
		}),
	}
}

async function userCount(db: D1Database, username: string) {
	const row = await db
		.prepare(`SELECT COUNT(*) AS count FROM users WHERE username = ?`)
		.bind(username)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

test('adminUserAccountDelete returns an approval URL and deletes only after approve', async () => {
	const { env, appDb } = createEnv()
	const adminId = await seedPerson(appDb, {
		id: 1,
		username: 'ops-admin',
		email: 'admin@example.com',
		admin: true,
	})
	const targetId = await seedPerson(appDb, {
		id: 2,
		username: 'ada-lovelace',
		email: 'ada@example.com',
	})
	const otherId = await seedPerson(appDb, {
		id: 3,
		username: 'grace-hopper',
		email: 'grace@example.com',
	})
	await appDb
		.prepare(
			`INSERT INTO orgs (
				id, slug, display_name, plan, entitlement_ladder, created_at, updated_at
			) VALUES ('org-shared', 'shared-lab', 'Shared', 'free', 'public', ?, ?)`,
		)
		.bind(createdAt, createdAt)
		.run()
	await appDb
		.prepare(
			`INSERT INTO handles (handle, org_id, created_at) VALUES ('shared-lab', 'org-shared', ?)`,
		)
		.bind(createdAt)
		.run()
	await appDb
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES ('org-shared', ?, 'owner', ?), ('org-shared', ?, 'owner', ?)`,
		)
		.bind(targetId, createdAt, otherId, createdAt)
		.run()
	await appDb
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, source_id, created_at, updated_at
			) VALUES ('pkg-ada', ?, 'notes', 'notes', 'Notes', 'src-ada', ?, ?)`,
		)
		.bind(targetId, createdAt, createdAt)
		.run()
	await appDb
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, source_id, created_at, updated_at
			) VALUES ('pkg-grace', ?, 'logs', 'logs', 'Logs', 'src-grace', ?, ?)`,
		)
		.bind(otherId, createdAt, createdAt)
		.run()
	await appDb
		.prepare(
			`INSERT INTO oauth_connections (provider_name, provider_id, user_id)
			 VALUES ('github', 'gh-ada', 2)`,
		)
		.run()
	await appDb
		.prepare(
			`INSERT INTO mcp_memories (id, user_id, subject, summary)
			 VALUES ('mem-ada', ?, 'notes', 'Ada notes')`,
		)
		.bind(targetId)
		.run()
	await appDb
		.prepare(
			`INSERT INTO webhook_endpoints (
				id, user_id, package_id, webhook_name, url_secret_hash, created_at, rotated_at
			) VALUES ('hook-ada', ?, 'pkg-ada', 'build', 'hash', ?, ?)`,
		)
		.bind(targetId, createdAt, createdAt)
		.run()
	await appDb
		.prepare(
			`INSERT INTO usage_rollups (user_id, metric, month, event_count, updated_at)
			 VALUES (?, 'execute', '2026-01', 4, ?)`,
		)
		.bind(targetId, createdAt)
		.run()
	await appDb
		.prepare(
			`INSERT INTO credit_wallets (user_id, balance_micro_usd, created_at, updated_at)
			 VALUES (?, 2500000, ?, ?)`,
		)
		.bind(targetId, createdAt, createdAt)
		.run()
	await appDb
		.prepare(
			`INSERT INTO secret_buckets (
				id, user_id, scope, binding_key, created_at, updated_at
			) VALUES ('bucket-ada', ?, 'user', 'default', ?, ?)`,
		)
		.bind(targetId, createdAt, createdAt)
		.run()
	await appDb
		.prepare(
			`INSERT INTO secret_entries (bucket_id, name, encrypted_value, created_at, updated_at)
			 VALUES ('bucket-ada', 'api', 'cipher', ?, ?)`,
		)
		.bind(createdAt, createdAt)
		.run()
	await appDb
		.prepare(
			`INSERT INTO mcp_agent_sessions (do_id, user_id, org_id)
			 VALUES ('session-ada', ?, ?)`,
		)
		.bind(targetId, targetId)
		.run()

	const userCtx = caller(env, adminId, ['user'])
	await expect(
		adminUserAccountDeleteCapability.handler(
			{ stableUserId: targetId },
			userCtx,
		),
	).rejects.toThrow('lacks required role "admin"')
	expect(await userCount(appDb, 'ada-lovelace')).toBe(1)

	const summary = await loadAdminAccountDeletionSummary(env, {
		stableUserId: targetId,
	})
	expect(summary).toMatchObject({
		handle: 'ada-lovelace',
		email: 'ada@example.com',
		plan: 'free',
		counts: {
			packages: 1,
			jobs: 1,
			credentials: 1,
			connections: 1,
			sessions: 1,
			orgMemberships: 2,
			memories: 1,
			webhooks: 1,
			usage: 4,
		},
		creditBalanceMicroUsd: 2_500_000,
		acknowledgementRequired: true,
		acknowledgementReasons: ['packages'],
		deletionBlocked: null,
	})

	const adminCtx = caller(env, adminId, ['admin'])
	const started = await adminUserAccountDeleteCapability.handler(
		{ username: 'ada-lovelace' },
		adminCtx,
	)
	expect(started.status).toBe('approval_required')
	expect(started.approvalUrl).toContain('/admin/account-deletions/')
	expect(started.acknowledgementRequired).toBe(true)
	expect(started.message).toContain('Nothing was deleted')
	expect(await userCount(appDb, 'ada-lovelace')).toBe(1)
	expect(await isUsernameClaimedInIdentity(appDb, 'ada-lovelace')).toBe(true)

	const approvalId =
		new URL(started.approvalUrl).pathname.split('/').at(-1) ?? ''
	const actor = {
		stableUserId: adminId,
		email: 'admin@example.com',
		username: 'ops-admin',
	}
	await expect(
		approveAdminAccountDeletion({
			env,
			actor,
			approvalId,
			acknowledge: false,
		}),
	).rejects.toThrow(/acknowledg/i)
	expect(await userCount(appDb, 'ada-lovelace')).toBe(1)

	const deleted = await approveAdminAccountDeletion({
		env,
		actor,
		approvalId,
		acknowledge: true,
	})
	expect(deleted.handle).toBe('ada-lovelace')
	expect(await userCount(appDb, 'ada-lovelace')).toBe(0)
	expect(await isUsernameClaimedInIdentity(appDb, 'ada-lovelace')).toBe(false)
	expect(await getOrgHandleClaimError('ada-lovelace', appDb)).toBeNull()
	expect(await userCount(appDb, 'grace-hopper')).toBe(1)
	expect(await userCount(appDb, 'ops-admin')).toBe(1)
	const shared = await appDb
		.prepare(`SELECT slug FROM orgs WHERE id = 'org-shared'`)
		.first<{ slug: string }>()
	expect(shared?.slug).toBe('shared-lab')
	const gracePackage = await appDb
		.prepare(`SELECT id FROM saved_packages WHERE id = 'pkg-grace'`)
		.first<{ id: string }>()
	expect(gracePackage?.id).toBe('pkg-grace')
	const graceMembership = await appDb
		.prepare(
			`SELECT role FROM org_memberships
			 WHERE org_id = 'org-shared' AND user_id = ?`,
		)
		.bind(otherId)
		.first<{ role: string }>()
	expect(graceMembership?.role).toBe('owner')
	expect(auditEventSummaries()).toContain('admin_user_account_delete:success')
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'admin_user_account_delete',
			result: 'success',
		}),
	)
})

test('sole ownership of a non-personal org and paid billing require acknowledgement', async () => {
	const { env, appDb } = createEnv()
	const adminId = await seedPerson(appDb, {
		id: 1,
		username: 'ops-admin',
		email: 'admin@example.com',
		admin: true,
	})
	const ownerId = await seedPerson(appDb, {
		id: 2,
		username: 'solo-owner',
		email: 'solo@example.com',
	})
	const memberId = await seedPerson(appDb, {
		id: 3,
		username: 'team-member',
		email: 'member@example.com',
	})
	await appDb
		.prepare(
			`INSERT INTO orgs (
				id, slug, display_name, plan, entitlement_ladder, created_at, updated_at
			) VALUES ('org-solo', 'solo-team', 'Solo', 'free', 'public', ?, ?)`,
		)
		.bind(createdAt, createdAt)
		.run()
	await appDb
		.prepare(
			`INSERT INTO handles (handle, org_id, created_at) VALUES ('solo-team', 'org-solo', ?)`,
		)
		.bind(createdAt)
		.run()
	await appDb
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES ('org-solo', ?, 'owner', ?), ('org-solo', ?, 'member', ?)`,
		)
		.bind(ownerId, createdAt, memberId, createdAt)
		.run()
	await appDb
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, source_id, created_at, updated_at
			) VALUES ('pkg-member', ?, 'member-pkg', 'member-pkg', 'Member', 'src-member', ?, ?)`,
		)
		.bind(memberId, createdAt, createdAt)
		.run()

	const soleSummary = await loadAdminAccountDeletionSummary(env, {
		username: 'solo-owner',
	})
	expect(soleSummary?.acknowledgementReasons).toContain('sole_owner')
	const adminCtx = caller(env, adminId, ['admin'])
	const started = await adminUserAccountDeleteCapability.handler(
		{ email: 'solo@example.com' },
		adminCtx,
	)
	const approvalId =
		new URL(started.approvalUrl).pathname.split('/').at(-1) ?? ''
	const actor = {
		stableUserId: adminId,
		email: 'admin@example.com',
		username: 'ops-admin',
	}
	await expect(
		approveAdminAccountDeletion({
			env,
			actor,
			approvalId,
			acknowledge: false,
		}),
	).rejects.toThrow(/acknowledg/i)
	const soloStillThere = await appDb
		.prepare(`SELECT slug FROM orgs WHERE id = 'org-solo'`)
		.first<{ slug: string }>()
	expect(soloStillThere?.slug).toBe('solo-team')

	await approveAdminAccountDeletion({
		env,
		actor,
		approvalId,
		acknowledge: true,
	})
	expect(await userCount(appDb, 'solo-owner')).toBe(0)
	expect(await isUsernameClaimedInIdentity(appDb, 'solo-owner')).toBe(false)
	expect(await isUsernameClaimedInIdentity(appDb, 'solo-team')).toBe(false)
	expect(await userCount(appDb, 'team-member')).toBe(1)
	const memberPackage = await appDb
		.prepare(`SELECT id FROM saved_packages WHERE id = 'pkg-member'`)
		.first<{ id: string }>()
	expect(memberPackage?.id).toBe('pkg-member')
	const memberOrg = await appDb
		.prepare(`SELECT slug FROM orgs WHERE id = ?`)
		.bind(memberId)
		.first<{ slug: string }>()
	expect(memberOrg?.slug).toBe('team-member')

	const paidId = await seedPerson(appDb, {
		id: 4,
		username: 'paid-user',
		email: 'paid@example.com',
		plan: 'pro',
	})
	const paidSummary = await loadAdminAccountDeletionSummary(env, {
		stableUserId: paidId,
	})
	expect(paidSummary?.plan).toBe('pro')
	expect(paidSummary?.acknowledgementReasons).toContain('paid_billing')
	await expect(
		deleteAdminUserAccount({
			env,
			actor: { ...actor, roles: ['user'] },
			stableUserId: paidId,
			handleConfirmation: 'paid-user',
			acknowledge: true,
		}),
	).rejects.toThrow('Admin role is required.')
	expect(await userCount(appDb, 'paid-user')).toBe(1)
	await expect(
		deleteAdminUserAccount({
			env,
			actor: { ...actor, roles: ['admin'] },
			stableUserId: paidId,
			handleConfirmation: 'not-the-handle',
			acknowledge: true,
		}),
	).rejects.toThrow(/Type @paid-user/)
	expect(await userCount(appDb, 'paid-user')).toBe(1)
	const removed = await deleteAdminUserAccount({
		env,
		actor: { ...actor, roles: ['admin'] },
		stableUserId: paidId,
		handleConfirmation: 'paid-user',
		acknowledge: true,
	})
	expect(removed).toEqual({ ok: true, handle: 'paid-user' })
	expect(await userCount(appDb, 'paid-user')).toBe(0)
	expect(await isUsernameClaimedInIdentity(appDb, 'paid-user')).toBe(false)
})

test('a partial delete resumes from the tombstone and the last admin is kept', async () => {
	const { env, appDb } = createEnv()
	const adminId = await seedPerson(appDb, {
		id: 1,
		username: 'only-admin',
		email: 'admin@example.com',
		admin: true,
	})
	const actor = {
		stableUserId: adminId,
		email: 'admin@example.com',
		username: 'only-admin',
		roles: ['admin'],
	}
	await expect(
		createAdminAccountDeletionApproval({
			env,
			actor,
			target: { stableUserId: adminId },
		}),
	).rejects.toThrow(/last admin/i)
	await expect(
		deleteAdminUserAccount({
			env,
			actor,
			stableUserId: adminId,
			handleConfirmation: 'only-admin',
			acknowledge: true,
		}),
	).rejects.toThrow(/last admin/i)
	expect(await userCount(appDb, 'only-admin')).toBe(1)

	const targetId = await seedPerson(appDb, {
		id: 2,
		username: 'half-deleted',
		email: 'half@example.com',
	})
	const approval = await createAdminAccountDeletionApproval({
		env,
		actor,
		target: { stableUserId: targetId },
	})
	await softDeleteUserAccount({
		env,
		userId: targetId as never,
		actorUserId: adminId,
		actorUsername: 'only-admin',
	})
	const page = await readAdminAccountDeletionApproval({
		env,
		approvalId: approval.approvalId,
	})
	expect(page.status).toBe('pending')
	if (page.status === 'pending') {
		expect(page.summary.handle).toBe('half-deleted')
	}
	expect(await isUsernameClaimedInIdentity(appDb, 'half-deleted')).toBe(true)
	const finished = await executeAdminAccountHardDelete({
		env,
		actor,
		targetStableUserId: targetId,
		acknowledge: true,
		path: '/admin/account-deletions',
	})
	expect(finished.handle).toBe('half-deleted')
	expect(await userCount(appDb, 'half-deleted')).toBe(0)
	expect(await isUsernameClaimedInIdentity(appDb, 'half-deleted')).toBe(false)
	expect(await userCount(appDb, 'only-admin')).toBe(1)
})
