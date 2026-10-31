/**
 * Team-org Members create credentials over MCP by default, and an Owner turns
 * that off with "Members can create credentials". Owners always can.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { expect, test } from 'vitest'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { updateOrgMemberCreation } from '#worker/orgs/member-creation.ts'
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
import { integrationDeviceConnectStartCapability } from './integrations/integration-device-connect-start.ts'
import { integrationSaveCapability } from './integrations/integration-save.ts'
import { mcpServerAddCapability } from './mcp-servers/mcp-server-add.ts'
import { secretSetCapability } from './secrets/secret-set.ts'

const now = '2026-10-30T00:00:00.000Z'
const people = ['ann', 'bea'] as const
type Person = (typeof people)[number]

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const env = {
		APP_DB: db,
		AUDIT_DB: createAuditTestDb(),
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
	// Bea owns the team org; Ann is a Member.
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: personIdFromStored(ids.bea),
			audit: createTestOrgAuditWriter(),
			slug: 'quillworks-co',
			displayName: 'Quillworks',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const row = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'quillworks-co'`)
		.first<{ id: string }>()
	const orgId = ownerIdFromStored(row!.id)
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(orgId, ids.ann, now)
		.run()
	// A fresh caller per call: compiled access is memoized per request.
	const as = (username: Person, role: OrgRole) => ({
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
			orgBinding: { org: { id: orgId, slug: 'quillworks-co' }, role },
		}),
	})
	const setCredentials = async (credentials: boolean) => {
		const result = await updateOrgMemberCreation(db, {
			orgId,
			credentials,
			audit: createTestOrgAuditWriter(),
		})
		if (!result.ok) throw new Error(result.error)
	}
	return { as, setCredentials }
}

const call = (
	capability: { handler: (args: never, ctx: never) => Promise<unknown> },
	args: Record<string, unknown>,
	ctx: unknown,
) =>
	capability.handler(args as never, ctx as never).then(
		(value) => ({ ok: true as const, value }),
		(error: unknown) => ({
			ok: false as const,
			message: error instanceof Error ? error.message : String(error),
		}),
	)

const integration = {
	name: 'spotify',
	tokenUrl: 'https://accounts.spotify.com/api/token',
	apiBaseUrl: 'https://api.spotify.com/v1',
	flow: 'pkce',
	clientId: 'spotify-client-id-value',
	requiredHosts: ['api.spotify.com'],
	authorization: {
		authorizeUrl: 'https://accounts.spotify.com/authorize',
		scopes: ['user-read-email'],
		scopeSeparator: ' ',
		extraAuthorizeParams: {},
	},
}

const denial = /Members can create credentials/

test('a Member creates team secrets and connections over MCP by default, and not once an Owner turns it off', async () => {
	const { as, setCredentials } = await setup()

	const secret = await call(
		secretSetCapability,
		{ name: 'deployToken', value: 'v1', scope: 'user' },
		as('ann', 'member'),
	)
	expect(secret.ok).toBe(true)
	const saved = await call(
		integrationSaveCapability,
		integration,
		as('ann', 'member'),
	)
	expect(saved).toMatchObject({ ok: true })
	// Device connect authorizes before it looks up the app, so a missing app
	// proves the create check passed.
	const device = await call(
		integrationDeviceConnectStartCapability,
		{ provider: 'github', platformAppSlug: 'no-such-app' },
		as('ann', 'member'),
	)
	expect(device.ok ? '' : device.message).not.toMatch(denial)

	await setCredentials(false)

	for (const [capability, args] of [
		[secretSetCapability, { name: 'otherToken', value: 'v', scope: 'user' }],
		[integrationSaveCapability, { ...integration, name: 'google' }],
		[
			integrationDeviceConnectStartCapability,
			{ provider: 'github', platformAppSlug: 'no-such-app' },
		],
		[mcpServerAddCapability, { name: 'docs', url: 'https://mcp.example.com' }],
	] as const) {
		const result = await call(capability, args, as('ann', 'member'))
		expect(result.ok ? 'allowed' : result.message).toMatch(denial)
	}

	// Updating what she already created still goes through Write, which her
	// creator grant holds.
	const update = await call(
		secretSetCapability,
		{ name: 'deployToken', value: 'v2', scope: 'user' },
		as('ann', 'member'),
	)
	expect(update.ok).toBe(true)

	// Owners always create.
	const owner = await call(
		secretSetCapability,
		{ name: 'ownerToken', value: 'v', scope: 'user' },
		as('bea', 'owner'),
	)
	expect(owner.ok).toBe(true)
})
