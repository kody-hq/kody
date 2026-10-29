/**
 * ADR 0068 amendment 2026-10-29: a member's own connection through an org's
 * OAuth app lives in their personal org, is pinned to that org, and ends
 * when an admin revokes it, the member leaves, or the app is deleted.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personalOrgId,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { afterEach, expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { resolveCredential } from '#worker/credentials/resolve-credential.ts'
import {
	integrationMemberConnectionListCapability,
	integrationMemberConnectionRevokeCapability,
} from '#mcp/capabilities/integrations/integration-member-connections.ts'
import {
	grantPersonalCredentialToOrg,
	listPersonalCredentialCandidates,
	loadPinnedOrgId,
} from '#worker/credentials/personal-credentials.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { integrationUsableInOrgSql } from './connected.ts'
import { persistUserOauthAppClientSecret } from './credentials.ts'
import {
	pinnedConnectionName,
	resolvePinnedConnectTarget,
	savePinnedConnection,
	pinnedReconnectHref,
} from './pinned-connect.ts'
import {
	listPinnedConnectionsForOrg,
	pinnedConnectionAuditActions,
	planPinnedConnectionWipes,
	wipePinnedConnectionsForMember,
} from './pinned-connections.ts'
import { upsertOauthApp } from './repo.ts'
import { deleteOauthAppWithConnections } from './service.ts'

vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof import('cloudflare:workers')>()),
	waitUntil: () => {},
}))

const now = '2026-10-29T00:00:00.000Z'
const people = ['ann', 'bea', 'cy'] as const
type Person = (typeof people)[number]
const fixtureTokens = {
	access_token: 'fixture-access-token',
	refresh_token: 'fixture-refresh-token',
	token_type: 'bearer',
}

afterEach(() => {
	vi.unstubAllGlobals()
})

function stubUpstream(result: number | Error) {
	const fetchMock = vi.fn(async () => {
		if (result instanceof Error) throw result
		return new Response(null, { status: result })
	})
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const auditDb = createAuditTestDb()
	const env = {
		APP_DB: db,
		AUDIT_DB: auditDb,
		...createInMemoryUserMeterEnv().env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
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
	// Bea owns Acme, Cy owns the other team org; Ann is a member of both.
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
		return id
	}
	const acmeId = await team('quillworks-co', 'bea')
	const otherId = await team('tidewater-co', 'cy')
	await upsertOauthApp({
		db,
		row: {
			user_id: acmeId,
			slug: 'github',
			provider: 'github',
			label: 'GitHub',
			client_id: 'fixture-client-id',
			token_url: 'https://github.com/login/oauth/access_token',
			authorize_url: 'https://github.com/login/oauth/authorize',
			device_authorization_url: null,
			api_base_url: 'https://api.github.com',
			flow: 'confidential',
			use_pkce: 0,
			token_exchange_style: null,
			scope_separator: null,
			extra_authorize_params_json: '{}',
		},
	})
	await persistUserOauthAppClientSecret({
		env,
		userId: acmeId,
		slug: 'github',
		value: 'fixture-client-secret',
	})
	const orgs = {
		acme: { id: acmeId, slug: 'quillworks-co' },
		other: { id: otherId, slug: 'tidewater-co' },
	}
	const personalOf = (username: Person) =>
		personalOrgId(personIdFromStored(ids[username]))
	const as = (
		username: Person,
		org: { id: OwnerId; slug: string },
		role: OrgRole | null,
	) => ({
		env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored(ids[username]),
				email: `${username}@example.com`,
				displayName: username,
				username,
			},
			orgBinding: { org: { id: org.id, slug: org.slug }, role },
		}),
	})
	const connect = async (
		username: Person,
		org: { id: OwnerId; slug: string },
		role: OrgRole | null = 'member',
	) => {
		const ctx = as(username, org, role)
		const target = await resolvePinnedConnectTarget({
			env,
			request: ctx.callerContext.request!,
			mcpUser: ctx.callerContext.user!,
			appSlug: 'github',
		})
		if (!target.ok) return target
		return savePinnedConnection({
			env,
			request: ctx.callerContext.request!,
			target,
			scopes: ['repo'],
			allowedHosts: ['api.github.com'],
			tokenRecord: fixtureTokens,
		})
	}
	const usableIn = async (ownerOrgId: OwnerId, runOrgId: OwnerId) => {
		const row = await db
			.prepare(
				`SELECT COUNT(*) AS n FROM user_integrations
				WHERE user_id = ?1 AND ${integrationUsableInOrgSql('?2')}`,
			)
			.bind(ownerOrgId, runOrgId)
			.first<{ n: number }>()
		return row!.n
	}
	const audits = async (action: string) => {
		const { results } = await auditDb
			.prepare(
				`SELECT org_id, resource_id, details_json FROM org_audit_events WHERE action = ? ORDER BY rowid`,
			)
			.bind(action)
			.all<{ org_id: string; resource_id: string; details_json: string }>()
		return results.map((row) => ({
			orgId: row.org_id,
			resourceId: row.resource_id,
			details: row.details_json,
		}))
	}
	return { env, db, ids, orgs, personalOf, as, connect, usableIn, audits }
}

const listMembers = (ctx: unknown) =>
	integrationMemberConnectionListCapability.handler({} as never, ctx as never)
const revokeMember = (credentialId: string, ctx: unknown) =>
	integrationMemberConnectionRevokeCapability.handler(
		{ credential_id: credentialId } as never,
		ctx as never,
	)

test('a member connects their own account through the org app: saved at home, pinned and granted to that org only', async () => {
	const t = await setup()
	const saved = await t.connect('ann', t.orgs.acme)
	if (!saved.ok) throw new Error(saved.error)
	const annHome = t.personalOf('ann')

	const row = await t.db
		.prepare(
			`SELECT user_id, app_owner_id, app_slug FROM user_integrations WHERE id = ?`,
		)
		.bind(saved.credentialId)
		.first()
	expect(row).toEqual({
		user_id: annHome,
		app_owner_id: t.orgs.acme.id,
		app_slug: 'github',
	})
	expect(await loadPinnedOrgId(t.db, annHome, saved.credentialId)).toBe(
		t.orgs.acme.id,
	)
	// The org's client secret is never copied into the member's org.
	const homeApps = await t.db
		.prepare(`SELECT COUNT(*) AS n FROM user_oauth_apps WHERE user_id = ?`)
		.bind(annHome)
		.first<{ n: number }>()
	expect(homeApps!.n).toBe(0)
	const candidates = await listPersonalCredentialCandidates({
		db: t.db,
		actorPersonId: personIdFromStored(t.ids.ann),
		orgId: t.orgs.acme.id,
	})
	expect(candidates.map((candidate) => candidate.id)).toEqual([
		saved.credentialId,
	])
	const [created] = await t.audits('credential.created')
	expect(created).toMatchObject({
		orgId: annHome,
		resourceId: saved.credentialId,
	})
	// Reconnecting refreshes the same connection.
	const again = await t.connect('ann', t.orgs.acme)
	expect(again).toMatchObject({ ok: true, credentialId: saved.credentialId })
})

test('connecting your own account needs a live team-org binding', async () => {
	const t = await setup()
	await expect(t.connect('cy', t.orgs.acme)).resolves.toMatchObject({
		ok: false,
		status: 403,
	})
	await expect(
		t.connect('ann', { id: t.personalOf('ann'), slug: 'ann' }, 'owner'),
	).resolves.toMatchObject({ ok: false, status: 400 })
	await expect(t.connect('ann', t.orgs.other)).resolves.toMatchObject({
		ok: false,
		status: 404,
	})
})

test('a binding that ends mid-connect leaves no connection behind', async () => {
	const t = await setup()
	const ctx = t.as('ann', t.orgs.acme, 'member')
	const target = await resolvePinnedConnectTarget({
		env: t.env,
		request: ctx.callerContext.request!,
		mcpUser: ctx.callerContext.user!,
		appSlug: 'github',
	})
	if (!target.ok) throw new Error(target.error)
	await t.db
		.prepare(`DELETE FROM org_memberships WHERE org_id = ? AND user_id = ?`)
		.bind(t.orgs.acme.id, t.ids.ann)
		.run()
	stubUpstream(204)
	await expect(
		savePinnedConnection({
			env: t.env,
			request: ctx.callerContext.request!,
			target,
			scopes: ['repo'],
			allowedHosts: ['api.github.com'],
			tokenRecord: fixtureTokens,
		}),
	).rejects.toThrow()
	const remaining = await t.db
		.prepare(`SELECT COUNT(*) AS n FROM user_integrations WHERE user_id = ?`)
		.bind(t.personalOf('ann'))
		.first<{ n: number }>()
	expect(remaining!.n).toBe(0)
})

test('a pinned connection is usable only in the pinned org, only in its owner’s runs', async () => {
	const t = await setup()
	const saved = await t.connect('ann', t.orgs.acme)
	if (!saved.ok) throw new Error(saved.error)
	const annHome = t.personalOf('ann')

	// The run-org predicate every resolver (placeholders, credential(),
	// createAuthenticatedFetch, refresh) applies.
	expect(await t.usableIn(annHome, t.orgs.acme.id)).toBe(1)
	expect(await t.usableIn(annHome, t.orgs.other.id)).toBe(0)
	expect(await t.usableIn(annHome, annHome)).toBe(0)

	await expect(
		grantPersonalCredentialToOrg({
			db: t.db,
			ownerPersonId: personIdFromStored(t.ids.ann),
			credentialId: saved.credentialId,
			orgId: t.orgs.other.id,
		}),
	).rejects.toThrow(/pinned to that org/)
	for (const [actorPersonId, orgId] of [
		[personIdFromStored(t.ids.ann), t.orgs.other.id],
		[personIdFromStored(t.ids.ann), annHome],
		// An Owner acting in the org, another member, and Automation.
		[personIdFromStored(t.ids.bea), t.orgs.acme.id],
		[personIdFromStored(t.ids.cy), t.orgs.acme.id],
		[null, t.orgs.acme.id],
	] as const) {
		const candidates = await listPersonalCredentialCandidates({
			db: t.db,
			actorPersonId,
			orgId,
		})
		expect(candidates.map((candidate) => candidate.id)).not.toContain(
			saved.credentialId,
		)
	}
})

test('admins list members’ connections without tokens and revoke them upstream, audited in both orgs', async () => {
	const t = await setup()
	const saved = await t.connect('ann', t.orgs.acme)
	if (!saved.ok) throw new Error(saved.error)
	const admin = t.as('bea', t.orgs.acme, 'owner')

	// A Member is not an admin here, even with their own connection.
	await expect(listMembers(t.as('ann', t.orgs.acme, 'member'))).rejects.toThrow(
		/integration:manage_access/,
	)
	const listed = await listMembers(admin)
	expect(listed.connections).toEqual([
		expect.objectContaining({
			credential_id: saved.credentialId,
			app_slug: 'github',
			member: expect.objectContaining({ username: 'ann' }),
		}),
	])
	const serialized = JSON.stringify(listed)
	for (const secret of [
		'fixture-access-token',
		'fixture-refresh-token',
		'fixture-client-secret',
		'repo',
	]) {
		expect(serialized).not.toContain(secret)
	}

	const fetchMock = stubUpstream(204)
	await expect(revokeMember(saved.credentialId, admin)).resolves.toEqual({
		revoked: true,
		upstream: 'revoked',
	})
	expect(fetchMock).toHaveBeenCalledTimes(1)
	expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(
		'https://api.github.com/applications/fixture-client-id/token',
	)
	expect(
		await listPinnedConnectionsForOrg({
			db: t.db,
			pinnedOrgId: t.orgs.acme.id,
		}),
	).toEqual([])
	expect(await t.usableIn(t.personalOf('ann'), t.orgs.acme.id)).toBe(0)
	const revokedAudits = await t.audits(pinnedConnectionAuditActions.revoked)
	const wipedAudits = await t.audits(pinnedConnectionAuditActions.wiped)
	expect(revokedAudits.map((event) => event.orgId)).toEqual([t.orgs.acme.id])
	expect(wipedAudits.map((event) => event.orgId)).toEqual([t.personalOf('ann')])
	for (const event of [...revokedAudits, ...wipedAudits]) {
		expect(event.details).not.toContain('fixture-')
	}
	await expect(revokeMember(saved.credentialId, admin)).rejects.toThrow(
		/No member connection/,
	)
})

test('an upstream revoke failure still wipes the connection locally', async () => {
	const t = await setup()
	const saved = await t.connect('ann', t.orgs.acme)
	if (!saved.ok) throw new Error(saved.error)
	stubUpstream(new Error('provider unreachable'))
	consoleWarn.mockImplementation(() => {})
	await expect(
		revokeMember(saved.credentialId, t.as('bea', t.orgs.acme, 'owner')),
	).resolves.toEqual({ revoked: true, upstream: 'failed' })
	expect(await t.usableIn(t.personalOf('ann'), t.orgs.acme.id)).toBe(0)
	// Logged without any token material.
	expect(consoleWarn).toHaveBeenCalledWith(
		'pinned-connection-upstream-revoke-failed',
		expect.not.objectContaining({ accessToken: expect.anything() }),
	)
	expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain('fixture-')
})

test('leaving or removal wipes the member’s pinned connections and revokes upstream', async () => {
	const t = await setup()
	const saved = await t.connect('ann', t.orgs.acme)
	if (!saved.ok) throw new Error(saved.error)
	const fetchMock = stubUpstream(204)
	await wipePinnedConnectionsForMember({
		env: t.env,
		orgId: t.orgs.acme.id,
		personId: t.ids.ann,
		audit: null,
	})
	expect(fetchMock).toHaveBeenCalledTimes(1)
	const remaining = await t.db
		.prepare(`SELECT COUNT(*) AS n FROM user_integrations WHERE user_id = ?`)
		.bind(t.personalOf('ann'))
		.first<{ n: number }>()
	expect(remaining!.n).toBe(0)
})

test('deleting the org app cuts members off: wiped and revoked upstream', async () => {
	const t = await setup()
	const saved = await t.connect('ann', t.orgs.acme)
	if (!saved.ok) throw new Error(saved.error)
	const fetchMock = stubUpstream(204)
	await expect(
		deleteOauthAppWithConnections({
			env: t.env,
			userId: t.orgs.acme.id,
			slug: 'github',
			audit: null,
		}),
	).resolves.toMatchObject({ deleted: true })
	expect(fetchMock).toHaveBeenCalledTimes(1)
	const remaining = await t.db
		.prepare(
			`SELECT COUNT(*) AS n FROM user_integrations WHERE app_owner_id = ?`,
		)
		.bind(t.orgs.acme.id)
		.first<{ n: number }>()
	expect(remaining!.n).toBe(0)
})

test('deleting the org app without SECRET_STORE_KEY still wipes members locally', async () => {
	const t = await setup()
	const saved = await t.connect('ann', t.orgs.acme)
	if (!saved.ok) throw new Error(saved.error)
	consoleWarn.mockImplementation(() => {})
	const fetchMock = stubUpstream(204)
	await expect(
		deleteOauthAppWithConnections({
			env: { ...t.env, SECRET_STORE_KEY: undefined } as unknown as Env,
			userId: t.orgs.acme.id,
			slug: 'github',
			audit: null,
		}),
	).resolves.toMatchObject({ deleted: true })
	// Recorded as a failed upstream revoke: the provider grant may be live.
	expect(consoleWarn).toHaveBeenCalledWith(
		'pinned-connection-upstream-revoke-failed',
		expect.objectContaining({ status: null }),
	)
	expect(fetchMock).not.toHaveBeenCalled()
	const remaining = await t.db
		.prepare(
			`SELECT COUNT(*) AS n FROM user_integrations WHERE app_owner_id = ?`,
		)
		.bind(t.orgs.acme.id)
		.first<{ n: number }>()
	expect(remaining!.n).toBe(0)
})

test('a planned wipe (org transfer) deletes nothing and revokes nothing until its batch commits', async () => {
	const t = await setup()
	const saved = await t.connect('ann', t.orgs.acme)
	if (!saved.ok) throw new Error(saved.error)
	const fetchMock = stubUpstream(204)
	const count = async () =>
		(await t.db
			.prepare(
				`SELECT COUNT(*) AS n FROM user_integrations WHERE app_owner_id = ?`,
			)
			.bind(t.orgs.acme.id)
			.first<{ n: number }>())!.n
	const plan = await planPinnedConnectionWipes({
		env: t.env,
		connections: await listPinnedConnectionsForOrg({
			db: t.db,
			pinnedOrgId: t.orgs.acme.id,
		}),
		reason: 'app_deleted',
		audit: null,
	})
	// A batch that never runs (the transfer failed) leaves the member intact.
	expect(await count()).toBe(1)
	expect(fetchMock).not.toHaveBeenCalled()
	await t.db.batch(plan.statements)
	await expect(plan.afterCommit()).resolves.toMatchObject([
		{ credentialId: saved.credentialId, wiped: true },
	])
	expect(await count()).toBe(0)
	expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('placeholders, credential(), createAuthenticatedFetch and refresh resolve it only for its owner in the pinned org', async () => {
	const t = await setup()
	const saved = await t.connect('ann', t.orgs.acme)
	if (!saved.ok) throw new Error(saved.error)
	const name = pinnedConnectionName('github', t.orgs.acme.slug)
	const annHome = { id: t.personalOf('ann'), slug: 'ann' }
	// Every integration surface goes through this one door.
	const resolve = (
		use: 'integration-token' | 'integration-refresh',
		org: { id: OwnerId },
		actor: ReturnType<typeof t.as> | null,
	) =>
		resolveCredential({
			env: t.env,
			orgId: org.id,
			actor: actor?.callerContext.request ?? null,
			baseUrl: 'https://heykody.dev',
			credential: { use, name },
		})

	await expect(
		resolve(
			'integration-token',
			t.orgs.acme,
			t.as('ann', t.orgs.acme, 'member'),
		),
	).resolves.toBe('fixture-access-token')

	for (const use of ['integration-token', 'integration-refresh'] as const) {
		// Ann's own runs anywhere but the pinned org.
		await expect(
			resolve(use, t.orgs.other, t.as('ann', t.orgs.other, 'member')),
		).rejects.toThrow(/Not allowed to use this personal credential/)
		await expect(
			resolve(use, annHome, t.as('ann', annHome, 'owner')),
		).rejects.toThrow(/Not allowed to use this personal credential/)
		// The Owner, another member, and Automation (no person) in the pinned org.
		for (const actor of [
			t.as('bea', t.orgs.acme, 'owner'),
			t.as('cy', t.orgs.acme, 'member'),
			null,
		]) {
			const result = await resolve(use, t.orgs.acme, actor).catch(
				(error: unknown) => error,
			)
			expect(JSON.stringify(result ?? null)).not.toContain(
				'fixture-access-token',
			)
			expect(JSON.stringify(result ?? null)).not.toContain(
				'fixture-refresh-token',
			)
		}
	}
})

test('a plain reconnect link for a pinned connection goes back through the org app', async () => {
	const t = await setup()
	const saved = await t.connect('ann', t.orgs.acme)
	if (!saved.ok) throw new Error(saved.error)
	const home = t.as('ann', { id: t.personalOf('ann'), slug: 'ann' }, 'owner')
	await expect(
		pinnedReconnectHref({
			env: t.env,
			request: home.callerContext.request!,
			mcpUser: home.callerContext.user!,
			name: saved.integrationName,
		}),
	).resolves.toBe(
		`/connect/oauth?provider=github&app=github&org=${t.orgs.acme.slug}&mode=personal`,
	)
	const inOrg = t.as('ann', t.orgs.acme, 'member')
	await expect(
		pinnedReconnectHref({
			env: t.env,
			request: inOrg.callerContext.request!,
			mcpUser: inOrg.callerContext.user!,
			name: saved.integrationName,
		}),
	).resolves.toBeNull()
})
