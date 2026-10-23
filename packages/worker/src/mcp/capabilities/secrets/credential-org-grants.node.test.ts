/**
 * credentialOrgGrant / credentialOrgRevoke / credentialOrgGrantList: the
 * owner of a personal credential grants it to orgs they belong to.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personalOrgId,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { expect, test } from 'vitest'
import { findCredentialIdsByLegacyName } from '#worker/credentials/credential-ids.ts'
import { listPersonalCredentialCandidates } from '#worker/credentials/personal-credentials.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { saveSecret } from '#mcp/secrets/service.ts'
import {
	credentialOrgGrantCapability,
	credentialOrgGrantListCapability,
	credentialOrgRevokeCapability,
} from './credential-org-grants.ts'

const now = '2026-10-13T00:00:00.000Z'
const people = ['ann', 'bea', 'cy'] as const
type Person = (typeof people)[number]

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
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
	// Bea owns Acme; Ann is a member; Cy is not in it.
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: personIdFromStored(ids.bea),
			audit: createTestOrgAuditWriter(),
			slug: 'quillworks-co',
			displayName: 'Acme',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const acme = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'quillworks-co'`)
		.first<{ id: string }>()
	const acmeId = ownerIdFromStored(acme!.id)
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(acmeId, ids.ann, now)
		.run()
	const secretOf = async (username: Person, name: string) => {
		const orgId = personalOrgId(personIdFromStored(ids[username]))
		await saveSecret({ env, userId: orgId, scope: 'user', name, value: 'v' })
		return (
			await findCredentialIdsByLegacyName(db, orgId, { type: 'secret', name })
		)[0]!
	}
	const annToken = await secretOf('ann', 'annToken')
	const cyToken = await secretOf('cy', 'cyToken')
	const as = (
		username: Person,
		org: { id: OwnerId; slug: string; role: OrgRole | null },
		scopes?: Array<OrgPermission>,
	) => ({
		env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			scopes,
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored(ids[username]),
				email: `${username}@example.com`,
				displayName: username,
				username,
			},
			orgBinding: { org: { id: org.id, slug: org.slug }, role: org.role },
		}),
	})
	const personal = (username: Person) => ({
		id: personalOrgId(personIdFromStored(ids[username])),
		slug: username,
		role: 'owner' as const,
	})
	const acmeAs = (role: OrgRole) => ({
		id: acmeId,
		slug: 'quillworks-co',
		role,
	})
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
			details: JSON.parse(row.details_json) as Record<string, unknown>,
		}))
	}
	return {
		db,
		ids,
		acmeId,
		annToken,
		cyToken,
		as,
		personal,
		acmeAs,
		audits,
	}
}

const grant = (args: Record<string, unknown>, ctx: unknown) =>
	credentialOrgGrantCapability.handler(args as never, ctx as never)
const revoke = (args: Record<string, unknown>, ctx: unknown) =>
	credentialOrgRevokeCapability.handler(args as never, ctx as never)
const list = (args: Record<string, unknown>, ctx: unknown) =>
	credentialOrgGrantListCapability.handler(args as never, ctx as never)

test('the owner grants a personal credential to the org the request is bound to, once, audited at home', async () => {
	const t = await setup()
	const annInAcme = t.as('ann', t.acmeAs('member'))
	const annPersonalOrg = personalOrgId(personIdFromStored(t.ids.ann))

	await expect(
		grant({ credential_id: t.annToken }, annInAcme),
	).resolves.toMatchObject({ created: true })
	await expect(
		grant({ credential_id: t.annToken }, annInAcme),
	).resolves.toMatchObject({ created: false })
	expect(await t.audits('credential.personal_org_granted')).toEqual([
		{
			orgId: annPersonalOrg,
			resourceId: t.annToken,
			details: { credentialKind: 'secret', grantedOrgId: t.acmeId },
		},
	])
	expect(
		(
			await listPersonalCredentialCandidates({
				db: t.db,
				actorPersonId: personIdFromStored(t.ids.ann),
				orgId: t.acmeId,
			})
		).map((credential) => credential.id),
	).toEqual([t.annToken])
	await expect(list({}, annInAcme)).resolves.toMatchObject({
		grants: [{ credential_id: t.annToken, active: true }],
	})
})

test('from the personal org the target org is named by slug, and only orgs the owner belongs to take a grant', async () => {
	const t = await setup()
	const annHome = t.as('ann', t.personal('ann'))
	await expect(grant({ credential_id: t.annToken }, annHome)).rejects.toThrow(
		/Pass org/,
	)
	await expect(
		grant({ credential_id: t.annToken, org: 'quillworks-co' }, annHome),
	).resolves.toMatchObject({ created: true })
	await expect(
		grant({ credential_id: t.annToken, org: 'no-such-org' }, annHome),
	).rejects.toThrow(/No org with the slug/)
	await expect(
		grant(
			{ credential_id: t.cyToken, org: 'quillworks-co' },
			t.as('cy', t.personal('cy')),
		),
	).rejects.toThrow(/an org you belong to/)
})

test("nobody grants, revokes, or lists someone else's personal credential, whatever their role", async () => {
	const t = await setup()
	await grant({ credential_id: t.annToken }, t.as('ann', t.acmeAs('member')))
	const beaInAcme = t.as('bea', t.acmeAs('owner'))
	await expect(grant({ credential_id: t.annToken }, beaInAcme)).rejects.toThrow(
		/No personal credential with that id/,
	)
	await expect(
		revoke({ credential_id: t.annToken }, beaInAcme),
	).resolves.toMatchObject({ revoked: false })
	await expect(list({}, beaInAcme)).resolves.toEqual({ grants: [] })
	await expect(
		list({}, t.as('ann', t.acmeAs('member'))),
	).resolves.toMatchObject({ grants: [{ credential_id: t.annToken }] })
})

test('a token needs Write on the credential family to change grants, and lists only families it can read', async () => {
	const t = await setup()
	const readOnly = t.as('ann', t.acmeAs('member'), [
		'secret:read',
		'secret:use',
	])
	await expect(
		grant({ credential_id: t.annToken }, readOnly),
	).rejects.toMatchObject({
		code: 'credential_scope',
		permission: 'secret:write',
	})
	await expect(
		grant(
			{ credential_id: t.annToken },
			t.as('ann', t.acmeAs('member'), ['secret:write']),
		),
	).resolves.toMatchObject({ created: true })
	await expect(list({}, readOnly)).resolves.toMatchObject({
		grants: [{ credential_id: t.annToken }],
	})
	await expect(
		list({}, t.as('ann', t.acmeAs('member'), ['integration:read'])),
	).resolves.toEqual({ grants: [] })
	await expect(
		revoke({ credential_id: t.annToken }, readOnly),
	).rejects.toMatchObject({ code: 'credential_scope' })
})

test('revoke removes the grant at once and audits it; a lost membership shows the grant inactive', async () => {
	const t = await setup()
	const annInAcme = t.as('ann', t.acmeAs('member'))
	await grant({ credential_id: t.annToken }, annInAcme)
	await t.db
		.prepare(
			`UPDATE org_memberships SET deleted_at = ? WHERE org_id = ? AND user_id = ?`,
		)
		.bind(now, t.acmeId, t.ids.ann)
		.run()
	const annHome = t.as('ann', t.personal('ann'))
	await expect(
		list({ credential_id: t.annToken }, annHome),
	).resolves.toMatchObject({
		grants: [{ credential_id: t.annToken, active: false }],
	})
	await expect(
		revoke({ credential_id: t.annToken, org: 'quillworks-co' }, annHome),
	).resolves.toMatchObject({ revoked: true })
	await expect(
		revoke({ credential_id: t.annToken, org: 'quillworks-co' }, annHome),
	).resolves.toMatchObject({ revoked: false })
	expect(await t.audits('credential.personal_org_revoked')).toEqual([
		{
			orgId: personalOrgId(personIdFromStored(t.ids.ann)),
			resourceId: t.annToken,
			details: { credentialKind: 'secret', grantedOrgId: t.acmeId },
		},
	])
	await expect(list({}, annHome)).resolves.toEqual({ grants: [] })
})

test('a grant or revoke that a concurrent call already made reports false and audits nothing', async () => {
	const t = await setup()
	const annInAcme = t.as('ann', t.acmeAs('member'))
	await t.db
		.prepare(
			`INSERT INTO credential_org_grants (credential_id, user_id, org_id, created_at) VALUES (?, ?, ?, ?)`,
		)
		.bind(t.annToken, t.ids.ann, t.acmeId, now)
		.run()
	await expect(
		grant({ credential_id: t.annToken }, annInAcme),
	).resolves.toMatchObject({ created: false })
	expect(await t.audits('credential.personal_org_granted')).toEqual([])
	await t.db
		.prepare(`DELETE FROM credential_org_grants WHERE credential_id = ?`)
		.bind(t.annToken)
		.run()
	await expect(
		revoke({ credential_id: t.annToken }, annInAcme),
	).resolves.toMatchObject({ revoked: false })
	expect(await t.audits('credential.personal_org_revoked')).toEqual([])
})

test('a disabled MCP server lists its grant inactive, and its grant needs integration Write even once deleted', async () => {
	const t = await setup()
	const annPersonalOrg = personalOrgId(personIdFromStored(t.ids.ann))
	await t.db
		.prepare(
			`INSERT INTO mcp_server_settings (id, user_id, name, url) VALUES ('ann-mcp', ?, 'annMcp', 'https://mcp.example.com/mcp')`,
		)
		.bind(annPersonalOrg)
		.run()
	const annInAcme = t.as('ann', t.acmeAs('member'))
	await expect(
		grant(
			{ credential_id: 'ann-mcp' },
			t.as('ann', t.acmeAs('member'), ['secret:write']),
		),
	).rejects.toMatchObject({ permission: 'integration:write' })
	await expect(
		grant({ credential_id: 'ann-mcp' }, annInAcme),
	).resolves.toMatchObject({ credential_kind: 'mcp-server', created: true })
	await t.db
		.prepare(`UPDATE mcp_server_settings SET enabled = 0 WHERE id = 'ann-mcp'`)
		.run()
	await expect(list({}, annInAcme)).resolves.toMatchObject({
		grants: [{ credential_id: 'ann-mcp', active: false }],
	})
	await t.db
		.prepare(
			`UPDATE mcp_server_settings SET deleted_at = ? WHERE id = 'ann-mcp'`,
		)
		.bind(now)
		.run()
	await expect(
		revoke(
			{ credential_id: 'ann-mcp' },
			t.as('ann', t.acmeAs('member'), ['secret:write']),
		),
	).rejects.toMatchObject({ permission: 'integration:write' })
	await expect(
		revoke(
			{ credential_id: 'no-such-credential' },
			t.as('ann', t.acmeAs('member'), ['secret:write']),
		),
	).rejects.toMatchObject({ permission: 'integration:write' })
	await expect(
		revoke({ credential_id: 'ann-mcp' }, annInAcme),
	).resolves.toMatchObject({ revoked: true })
})
