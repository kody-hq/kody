/**
 * Members' personal connections pinned to a team org's OAuth apps (ADR 0068
 * amendment 2026-10-29) end with the org: soft delete wipes them and revokes
 * them upstream, and hard purge removes any left behind so the org's apps
 * (ON DELETE RESTRICT parents) can be deleted.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personalOrgId,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { afterEach, expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createSuccessfulDeletionEnv } from '#worker/test-support/account-deletion.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { persistUserOauthAppClientSecret } from '#worker/integrations/credentials.ts'
import {
	resolvePinnedConnectTarget,
	savePinnedConnection,
} from '#worker/integrations/pinned-connect.ts'
import { pinnedConnectionAuditActions } from '#worker/integrations/pinned-connections.ts'
import { upsertOauthApp } from '#worker/integrations/repo.ts'

vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof import('cloudflare:workers')>()),
	waitUntil: () => {},
}))

vi.mock('#worker/jobs/manager-client.ts', () => ({
	syncJobManagerAlarm: vi.fn(async () => ({
		ok: true as const,
		userId: ownerIdFromStored('mock'),
		nextRunAt: null,
	})),
	purgeJobManagerForUser: vi.fn(async () => ({
		ok: true as const,
		userId: ownerIdFromStored('mock'),
		purged: true,
	})),
}))

vi.mock('#worker/jobs/jobs-data.ts', () => ({
	jobsData: () => ({
		softDeleteJobsForUser: vi.fn(async () => 0),
		restoreJobsForUser: vi.fn(async () => 0),
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

const { softDeleteOrg } = await import('./soft-delete.ts')
const { hardPurgeOrg } = await import('./hard-purge.ts')

const now = '2026-10-29T00:00:00.000Z'
const people = ['ann', 'bea', 'cy'] as const
type Person = (typeof people)[number]

afterEach(() => {
	vi.unstubAllGlobals()
})

function stubUpstream() {
	const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

const githubApp = (userId: string) => ({
	user_id: userId,
	slug: 'github',
	provider: 'github',
	label: 'GitHub',
	client_id: `client-${userId}`,
	token_url: 'https://github.com/login/oauth/access_token',
	authorize_url: 'https://github.com/login/oauth/authorize',
	device_authorization_url: null,
	api_base_url: 'https://api.github.com',
	flow: 'confidential' as const,
	use_pkce: 0,
	token_exchange_style: null,
	scope_separator: null,
	extra_authorize_params_json: '{}',
})

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const auditDb = createAuditTestDb()
	const env = createSuccessfulDeletionEnv(db, {
		AUDIT_DB: auditDb,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	}) as unknown as Env
	const ids = Object.fromEntries(
		people.map((username) => [
			username,
			testStableUserIdFromEmail(`${username}@example.com`),
		]),
	) as Record<Person, string>
	for (const [index, username] of people.entries()) {
		await db
			.prepare(
				`INSERT INTO users (id, username, email, password_hash, created_at, updated_at, stable_user_id)
				 VALUES (?, ?, ?, 'h', ?, ?, ?)`,
			)
			.bind(
				index + 1,
				username,
				`${username}@example.com`,
				now,
				now,
				ids[username],
			)
			.run()
		await provisionPersonalOrg(db, {
			stableUserId: ids[username],
			username,
			createdAt: now,
		})
	}
	const personalOf = (username: Person) =>
		personalOrgId(personIdFromStored(ids[username]))
	// Bea owns Acme, Cy owns Tidewater; Ann is a member of both. Both orgs
	// have a GitHub app.
	const team = async (slug: string, owner: Person) => {
		const created = await createOrganization(
			db,
			{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
			{
				personId: personIdFromStored(ids[owner]),
				audit: createTestOrgAuditWriter(),
				slug,
				displayName: slug,
			},
		)
		if (!created.ok) throw new Error(created.error)
		const row = await db
			.prepare(`SELECT id FROM orgs WHERE slug = ?`)
			.bind(slug)
			.first<{ id: string }>()
		const id = ownerIdFromStored(row!.id)
		await db
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, 'member', ?)`,
			)
			.bind(id, ids.ann, now)
			.run()
		await upsertOauthApp({ db, row: githubApp(id) })
		await persistUserOauthAppClientSecret({
			env,
			userId: id,
			slug: 'github',
			value: `secret-${slug}`,
		})
		return { id, slug }
	}
	const acme = await team('quillworks-co', 'bea')
	const other = await team('tidewater-co', 'cy')

	const connect = async (
		username: Person,
		org: { id: OwnerId; slug: string },
	) => {
		const callerContext = createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored(ids[username]),
				email: `${username}@example.com`,
				displayName: username,
				username,
			},
			orgBinding: {
				org: { id: org.id, slug: org.slug },
				role: username === 'bea' ? 'owner' : 'member',
			},
		})
		const target = await resolvePinnedConnectTarget({
			env,
			request: callerContext.request!,
			mcpUser: callerContext.user!,
			appSlug: 'github',
		})
		if (!target.ok) throw new Error(target.error)
		const saved = await savePinnedConnection({
			env,
			request: callerContext.request!,
			target,
			scopes: ['repo'],
			allowedHosts: ['api.github.com'],
			tokenRecord: {
				access_token: `access-${username}-${org.slug}`,
				refresh_token: `refresh-${username}-${org.slug}`,
				token_type: 'bearer',
			},
		})
		if (!saved.ok) throw new Error(saved.error)
		return saved.credentialId
	}

	// Ann's own app and connection in her personal org: unrelated personal
	// data that no org delete may touch.
	const annHome = personalOf('ann')
	await upsertOauthApp({ db, row: githubApp(annHome) })
	await db
		.prepare(
			`INSERT INTO user_integrations (
				user_id, name, app_slug, app_owner_id, id, provider, created_at, updated_at
			) VALUES (?, 'github-mine', 'github', ?, 'cred-ann-mine', 'github', ?, ?)`,
		)
		.bind(annHome, annHome, now, now)
		.run()

	const pinnedCount = async (orgId: OwnerId) =>
		(await db
			.prepare(
				`SELECT COUNT(*) AS n FROM user_integrations
				 WHERE app_owner_id = ? AND user_id <> app_owner_id`,
			)
			.bind(orgId)
			.first<{ n: number }>())!.n
	const rowExists = async (sql: string, ...binds: Array<string>) =>
		(await db
			.prepare(`SELECT COUNT(*) AS n FROM ${sql}`)
			.bind(...binds)
			.first<{ n: number }>())!.n
	const wipedAudits = async () => {
		const { results } = await auditDb
			.prepare(
				`SELECT org_id, resource_id, details_json FROM org_audit_events
				 WHERE action = ? ORDER BY rowid`,
			)
			.bind(pinnedConnectionAuditActions.wiped)
			.all<{ org_id: string; resource_id: string; details_json: string }>()
		return results.map((row) => ({
			orgId: row.org_id,
			resourceId: row.resource_id,
			details: JSON.parse(row.details_json) as Record<string, unknown>,
		}))
	}
	return {
		env,
		db,
		ids,
		acme,
		other,
		annHome,
		personalOf,
		connect,
		pinnedCount,
		rowExists,
		wipedAudits,
	}
}

test('soft-deleting a team org wipes members’ connections pinned to it and revokes them upstream', async () => {
	const t = await setup()
	const annAcme = await t.connect('ann', t.acme)
	const beaAcme = await t.connect('bea', t.acme)
	const annOther = await t.connect('ann', t.other)
	const fetchMock = stubUpstream()

	await softDeleteOrg({
		env: t.env,
		orgId: t.acme.id,
		actorUserId: t.ids.bea,
		now: new Date('2026-10-30T00:00:00.000Z'),
	})

	expect(await t.pinnedCount(t.acme.id)).toBe(0)
	// Grants that made the connections usable in Acme go with them.
	expect(
		await t.rowExists(
			`credential_org_grants WHERE credential_id IN (?, ?)`,
			annAcme,
			beaAcme,
		),
	).toBe(0)
	// Ann's connection pinned to another org and her own personal connection stay.
	expect(await t.pinnedCount(t.other.id)).toBe(1)
	expect(await t.rowExists(`user_integrations WHERE id = ?`, annOther)).toBe(1)
	expect(
		await t.rowExists(
			`credential_org_grants WHERE credential_id = ?`,
			annOther,
		),
	).toBe(1)
	expect(
		await t.rowExists(
			`user_integrations WHERE id = 'cred-ann-mine' AND deleted_at IS NULL`,
		),
	).toBe(1)
	// Each wiped connection was revoked at the provider with Acme's app.
	expect(fetchMock).toHaveBeenCalledTimes(2)
	const audits = await t.wipedAudits()
	expect(audits).toHaveLength(2)
	expect(audits).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				orgId: t.annHome,
				resourceId: annAcme,
				details: expect.objectContaining({
					reason: 'org_deleted',
					pinnedOrgId: t.acme.id,
					upstreamRevocation: 'revoked',
				}),
			}),
			expect.objectContaining({
				orgId: t.personalOf('bea'),
				resourceId: beaAcme,
				details: expect.objectContaining({ reason: 'org_deleted' }),
			}),
		]),
	)
})

test('hard purge removes pinned connections a soft delete left behind, then the org apps', async () => {
	const t = await setup()
	const annAcme = await t.connect('ann', t.acme)
	const annOther = await t.connect('ann', t.other)
	stubUpstream()
	// An org soft-deleted before the fix: tombstoned, pinned rows still live.
	await t.db
		.prepare(`UPDATE orgs SET deleted_at = ? WHERE id = ?`)
		.bind('2026-09-01T00:00:00.000Z', t.acme.id)
		.run()
	await t.db
		.prepare(`UPDATE user_oauth_apps SET deleted_at = ? WHERE user_id = ?`)
		.bind('2026-09-01T00:00:00.000Z', t.acme.id)
		.run()
	expect(await t.pinnedCount(t.acme.id)).toBe(1)
	// Other org-keyed rows the purge inventory used to skip.
	for (const [orgId, suffix] of [
		[t.acme.id, 'acme'],
		[t.other.id, 'other'],
	] as const) {
		await t.db
			.prepare(
				`INSERT INTO follow_recent_updates (
					id, follower_org_id, follow_id, event, dedupe_key, detail_json, occurred_at, created_at
				) VALUES (?, ?, ?, 'published', 'd', '{}', ?, ?)`,
			)
			.bind(`fru-${suffix}`, orgId, `follow-${suffix}`, now, now)
			.run()
		await t.db
			.prepare(
				`INSERT INTO execution_context_notices (
					context_id, org_id, kind, fingerprint, detail_json, raised_at, updated_at
				) VALUES (?, ?, 'misconfigured', 'f', '{}', ?, ?)`,
			)
			.bind(`ctx-${suffix}`, orgId, now, now)
			.run()
	}

	await hardPurgeOrg({ env: t.env, orgId: t.acme.id })

	for (const [table, column] of [
		['follow_recent_updates', 'follower_org_id'],
		['execution_context_notices', 'org_id'],
	] as const) {
		expect(await t.rowExists(`${table} WHERE ${column} = ?`, t.acme.id)).toBe(0)
		expect(await t.rowExists(`${table} WHERE ${column} = ?`, t.other.id)).toBe(
			1,
		)
	}

	expect(await t.rowExists(`orgs WHERE id = ?`, t.acme.id)).toBe(0)
	expect(
		await t.rowExists(`user_oauth_apps WHERE user_id = ?`, t.acme.id),
	).toBe(0)
	expect(await t.pinnedCount(t.acme.id)).toBe(0)
	expect(
		await t.rowExists(`credential_org_grants WHERE credential_id = ?`, annAcme),
	).toBe(0)
	expect(await t.wipedAudits()).toEqual([
		expect.objectContaining({
			orgId: t.annHome,
			resourceId: annAcme,
			details: expect.objectContaining({ reason: 'org_deleted' }),
		}),
	])
	// Other-org and personal data survive.
	expect(await t.rowExists(`orgs WHERE id = ?`, t.other.id)).toBe(1)
	expect(await t.rowExists(`user_integrations WHERE id = ?`, annOther)).toBe(1)
	expect(
		await t.rowExists(`user_oauth_apps WHERE user_id = ?`, t.other.id),
	).toBe(1)
	expect(
		await t.rowExists(`user_integrations WHERE id = 'cred-ann-mine'`),
	).toBe(1)
	expect(
		await t.rowExists(`user_oauth_apps WHERE user_id = ?`, t.annHome),
	).toBe(1)
})

test('a leftover pinned connection blocks deleting the org app; soft delete clears the blocker', async () => {
	const t = await setup()
	await t.connect('ann', t.acme)
	stubUpstream()
	// The app FK is ON DELETE RESTRICT: a pinned row keeps the org app alive.
	await expect(
		t.db
			.prepare(`DELETE FROM user_oauth_apps WHERE user_id = ?`)
			.bind(t.acme.id)
			.run(),
	).rejects.toThrow(/FOREIGN KEY constraint failed/)

	await softDeleteOrg({
		env: t.env,
		orgId: t.acme.id,
		actorUserId: t.ids.bea,
		now: new Date('2026-10-30T00:00:00.000Z'),
	})

	const deleted = await t.db
		.prepare(`DELETE FROM user_oauth_apps WHERE user_id = ?`)
		.bind(t.acme.id)
		.run()
	expect(deleted.meta.changes).toBe(1)
	expect(
		await t.rowExists(`user_oauth_apps WHERE user_id = ?`, t.other.id),
	).toBe(1)
})
