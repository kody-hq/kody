import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureOrgsTestSchema } from './orgs-test-schema.ts'

const updateJob = vi.fn(async () => true)
const deleteJob = vi.fn(async () => true)
const listJobsForUser = vi.fn(async () => [
	{
		id: 'job-1',
		name: 'Nightly',
		user_id: ownerIdFromStored('org-1'),
		created_by_user_id: 'member-1',
		deleted_at: null,
	},
])
const getJobById = vi.fn(async () => ({
	id: 'job-1',
	user_id: ownerIdFromStored('org-1'),
	created_by_user_id: 'member-1',
	callerContextJson: '{}',
	record: {
		id: 'job-1',
		userId: ownerIdFromStored('org-1'),
		name: 'Nightly',
		enabled: true,
		updatedAt: '2026-10-01T00:00:00.000Z',
	},
}))

vi.mock('#worker/jobs/jobs-data.ts', () => ({
	jobsData: () => ({
		listJobsForUser,
		getJobById,
		updateJob,
		deleteJob,
	}),
}))
vi.mock('#worker/jobs/manager-client.ts', () => ({
	syncJobManagerAlarm: vi.fn(async () => ({
		ok: true,
		userId: ownerIdFromStored('mock'),
		nextRunAt: null,
	})),
}))

const { offboardOrgMember, previewMemberOffboarding, revokeOAuthGrantsForOrg } =
	await import('./offboarding.ts')

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	const ts = '2026-01-01T00:00:00.000Z'
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, plan, entitlement_ladder, created_at, updated_at)
			 VALUES ('org-1', 'acme', 'Acme', 'free', 'public', ?, ?)`,
		)
		.bind(ts, ts)
		.run()
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES ('org-1', 'owner-1', 'owner', ?), ('org-1', 'member-1', 'member', ?)`,
		)
		.bind(ts, ts)
		.run()
	await db
		.prepare(
			`INSERT INTO user_oauth_apps (
				user_id, slug, provider, client_id, token_url, flow,
				extra_authorize_params_json, created_at, updated_at
			) VALUES (
				'org-1', 'github', 'github', 'client', 'https://example.com/token', 'confidential',
				'{}', ?, ?
			)`,
		)
		.bind(ts, ts)
		.run()
	await db
		.prepare(
			`INSERT INTO user_integrations (
				user_id, name, app_slug, description, scopes_json, required_hosts_json,
				access_token_encrypted, refresh_token_encrypted, connected_by_user_id,
				connected_at, created_at, updated_at
			) VALUES (
				'org-1', 'github', 'github', '', '[]', '[]',
				'cipher', 'refresh', 'member-1',
				?, ?, ?
			)`,
		)
		.bind(ts, ts, ts)
		.run()
	return db
}

test('preview lists member jobs and own-login integrations', async () => {
	const db = await createDb()
	const preview = await previewMemberOffboarding({
		appDb: db,
		env: { APP_DB: db } as Env,
		orgId: ownerIdFromStored('org-1'),
		memberUserId: 'member-1',
	})
	expect(preview.jobs).toEqual([{ id: 'job-1', name: 'Nightly' }])
	expect(preview.ownLoginIntegrations).toEqual(['github'])
})

test('offboarding soft-deletes membership, disconnects integrations, applies job cancel', async () => {
	const db = await createDb()
	const result = await offboardOrgMember({
		appDb: db,
		env: { APP_DB: db } as Env,
		orgId: ownerIdFromStored('org-1'),
		memberUserId: 'member-1',
		memberLeftVoluntarily: false,
		jobChoices: [{ jobId: 'job-1', disposition: 'cancel' }],
		now: new Date('2026-10-01T12:00:00.000Z'),
	})
	expect(result.membershipSoftDeleted).toBe(true)
	expect(result.disconnectedIntegrations).toEqual(['github'])
	expect(result.jobDispositions).toEqual([
		{ jobId: 'job-1', disposition: 'cancel' },
	])
	expect(updateJob).toHaveBeenCalled()
	const tokens = await db
		.prepare(
			`SELECT access_token_encrypted, refresh_token_encrypted, connected_at
			 FROM user_integrations WHERE user_id = 'org-1' AND name = 'github'`,
		)
		.first<{
			access_token_encrypted: string | null
			refresh_token_encrypted: string | null
			connected_at: string | null
		}>()
	expect(tokens?.access_token_encrypted).toBeNull()
	expect(tokens?.refresh_token_encrypted).toBeNull()
	expect(tokens?.connected_at).toBeNull()
	const membership = await db
		.prepare(
			`SELECT deleted_at FROM org_memberships WHERE org_id = 'org-1' AND user_id = 'member-1'`,
		)
		.first<{ deleted_at: string | null }>()
	expect(membership?.deleted_at).toBeTruthy()
})

test('cannot remove the last live owner', async () => {
	const db = await createDb()
	await expect(
		offboardOrgMember({
			appDb: db,
			env: { APP_DB: db } as Env,
			orgId: ownerIdFromStored('org-1'),
			memberUserId: 'owner-1',
			memberLeftVoluntarily: false,
		}),
	).rejects.toThrow('cannot_remove_last_owner')
})

test('offboarding revokes team-bound API tokens and bootstrap codes', async () => {
	const db = await createDb()
	const ts = '2026-01-01T00:00:00.000Z'
	await db
		.prepare(
			`INSERT INTO api_tokens (
				id, user_id, org_id, name, token_hash, scopes_json,
				idle_ttl_seconds, expires_at, max_expires_at, created_via,
				created_at, updated_at
			) VALUES (
				'token-team', 'member-1', 'org-1', 'team token', 'hash', '[]',
				3600, ?, ?, 'test', ?, ?
			)`,
		)
		.bind(ts, ts, ts, ts)
		.run()
	await db
		.prepare(
			`INSERT INTO api_tokens (
				id, user_id, org_id, name, token_hash, scopes_json,
				idle_ttl_seconds, expires_at, max_expires_at, created_via,
				created_at, updated_at
			) VALUES (
				'token-other', 'member-1', 'other-org', 'other token', 'hash2', '[]',
				3600, ?, ?, 'test', ?, ?
			)`,
		)
		.bind(ts, ts, ts, ts)
		.run()
	await db
		.prepare(
			`INSERT INTO cli_credential_bootstrap_codes (
				id, user_id, org_id, code_hash, name, scopes_json,
				idle_ttl_seconds, max_lifetime_seconds, expires_at, created_at
			) VALUES (
				'boot-team', 'member-1', 'org-1', 'codehash', 'boot', '[]',
				3600, 86400, ?, ?
			)`,
		)
		.bind(ts, ts)
		.run()

	const result = await offboardOrgMember({
		appDb: db,
		env: { APP_DB: db } as Env,
		orgId: ownerIdFromStored('org-1'),
		memberUserId: 'member-1',
		memberLeftVoluntarily: false,
		jobChoices: [{ jobId: 'job-1', disposition: 'keep_running' }],
		now: new Date('2026-10-01T12:00:00.000Z'),
	})
	expect(result.revokedApiTokens).toBe(1)
	expect(result.revokedCliBootstrapCodes).toBe(1)
	const teamToken = await db
		.prepare(`SELECT revoked_at FROM api_tokens WHERE id = 'token-team'`)
		.first<{ revoked_at: string | null }>()
	expect(teamToken?.revoked_at).toBeTruthy()
	const otherToken = await db
		.prepare(`SELECT revoked_at FROM api_tokens WHERE id = 'token-other'`)
		.first<{ revoked_at: string | null }>()
	expect(otherToken?.revoked_at).toBeNull()
	const boot = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM cli_credential_bootstrap_codes WHERE id = 'boot-team'`,
		)
		.first<{ n: number }>()
	expect(boot?.n).toBe(0)
})

test('revokeOAuthGrantsForOrg matches metadata.orgId only', async () => {
	const revokeGrant = vi.fn(async () => undefined)
	const helpers = {
		listUserGrants: async () => ({
			items: [
				{
					id: 'g1',
					clientId: 'c1',
					scope: [],
					metadata: { orgId: ownerIdFromStored('org-1') },
				},
				{
					id: 'g2',
					clientId: 'c2',
					scope: [],
					metadata: { orgId: ownerIdFromStored('other') },
				},
				{ id: 'g3', clientId: 'c3', scope: [] },
			],
		}),
		revokeGrant,
	}
	const revoked = await revokeOAuthGrantsForOrg({
		helpers,
		memberUserId: 'member-1',
		orgId: ownerIdFromStored('org-1'),
	})
	expect(revoked).toBe(1)
	expect(revokeGrant).toHaveBeenCalledWith('g1', 'member-1')

	revokeGrant.mockClear()
	const revokedUnstamped = await revokeOAuthGrantsForOrg({
		helpers,
		memberUserId: 'member-1',
		orgId: ownerIdFromStored('member-1'),
	})
	expect(revokedUnstamped).toBe(0)
	expect(revokeGrant).not.toHaveBeenCalled()
})

test('offboarding hard-deletes the member’s personal credential grants to the org, and only theirs', async () => {
	const db = await createDb()
	await db
		.prepare(
			`INSERT INTO credential_org_grants (credential_id, user_id, org_id, created_at)
			 VALUES ('cred-member', 'member-1', 'org-1', ?), ('cred-owner', 'owner-1', 'org-1', ?)`,
		)
		.bind('2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
		.run()
	await offboardOrgMember({
		appDb: db,
		env: { APP_DB: db } as Env,
		orgId: ownerIdFromStored('org-1'),
		memberUserId: 'member-1',
		memberLeftVoluntarily: true,
		now: new Date('2026-10-01T12:00:00.000Z'),
	})
	const rows = await db
		.prepare(
			`SELECT credential_id FROM credential_org_grants ORDER BY credential_id`,
		)
		.all<{ credential_id: string }>()
	expect(rows.results.map((row) => row.credential_id)).toEqual(['cred-owner'])
})
