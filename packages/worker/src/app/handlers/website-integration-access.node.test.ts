import { DatabaseSync } from 'node:sqlite'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadAccountIntegrationByName } from '#app/account-integrations-data.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { findOauthAppForProviderSetup } from '#worker/integrations/service.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { isPermissionDeniedError } from '#universal/permission-denied.ts'
import { buildAccountSecretId } from '@kody-internal/shared/account-secret-route.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { expect, test, vi } from 'vitest'
import {
	deleteAccountOauthApp,
	disconnectAccountIntegration,
	rotateAccountOauthAppCredentials,
} from './account-integrations.ts'
import {
	loadDevicePendingSession,
	storeDevicePendingSession,
} from '#worker/integrations/device-flow.ts'
import { resolveConnectClientSecret } from '#worker/integrations/connect-oauth-persist.ts'
import { createMemoryKvNamespace } from '#worker/test-support/memory-kv.ts'
import { updateOrgMemberCreation } from '#worker/orgs/member-creation.ts'
import {
	connectAccountOAuth,
	pollAccountDeviceConnect,
	saveAccountOAuthApp,
	saveAccountSecret,
	startAccountDeviceConnect,
} from './account-secrets.ts'

vi.mock(
	'#worker/test-support/apply-all-migrations.ts',
	async (importOriginal) =>
		(
			await import('#worker/credentials/cached-migrations.test-support.ts')
		).withCachedMigrations(await importOriginal()),
)

type WebsiteUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

const now = '2026-10-12T00:00:00.000Z'
const teamSlug = 'test-team'

const githubApp = {
	provider: 'github',
	tokenUrl: 'https://github.com/login/oauth/access_token',
	authorizeUrl: 'https://github.com/login/oauth/authorize',
	apiBaseUrl: 'https://api.github.com',
	flow: 'confidential',
	clientId: 'team-github-client',
	clientSecret: 'team-github-secret',
	extraAuthorizeParams: {},
}

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
	const people = {
		owner: testStableUserIdFromEmail('team-owner@example.com'),
		member: testStableUserIdFromEmail('team-member@example.com'),
	}
	for (const [username, stableUserId] of Object.entries(people)) {
		await provisionPersonalOrg(db, {
			stableUserId,
			username: `test-${username}`,
			createdAt: now,
		})
	}
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: personIdFromStored(people.owner),
			audit: createTestOrgAuditWriter(),
			slug: teamSlug,
			displayName: 'Test Team',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const team = await db
		.prepare(`SELECT id FROM orgs WHERE slug = ?`)
		.bind(teamSlug)
		.first<{ id: string }>()
	const teamId = ownerIdFromStored(team!.id)
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(teamId, people.member, now)
		.run()

	const userFor = (
		person: keyof typeof people,
		org: { id: OwnerId; role: OrgRole } | null,
	): WebsiteUser => {
		const user = {
			userId: personIdFromStored(people[person]),
			username: `test-${person}`,
		}
		return {
			mcpUser: { ...user, email: `team-${person}@example.com` },
			request: deriveRequestContext({
				user,
				source: { kind: 'session' },
				...(org
					? {
							orgBinding: {
								org: { id: org.id, slug: teamSlug },
								role: org.role,
							},
						}
					: {}),
			}),
		} as unknown as WebsiteUser
	}
	return {
		env,
		db,
		teamId,
		teamOwner: userFor('owner', { id: teamId, role: 'owner' }),
		teamMember: userFor('member', { id: teamId, role: 'member' }),
		memberPersonal: userFor('member', null),
		userFor,
	}
}

async function expectDenied(promise: Promise<unknown>, permission: string) {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught,
	)
	expect(isPermissionDeniedError(error)).toBe(true)
	expect(error).toMatchObject({ status: 403, permission })
	expect((error as Error).message).toContain(`organization`)
	expect((error as Error).message).toContain(permission)
}

const appCount = (db: D1Database, ownerId: string) =>
	db
		.prepare(`SELECT COUNT(*) AS n FROM user_oauth_apps WHERE user_id = ?`)
		.bind(ownerId)
		.first<{ n: number }>()
		.then((row) => row?.n ?? 0)

test('team members without integration:write cannot save, rotate, or delete org OAuth apps; owners and personal orgs can', async () => {
	const { env, db, teamId, teamOwner, teamMember, memberPersonal } =
		await setup()

	await expectDenied(
		saveAccountOAuthApp({ env, user: teamMember, fields: githubApp }),
		'integration:write',
	)
	expect(await appCount(db, teamId)).toBe(0)

	const saved = await saveAccountOAuthApp({
		env,
		user: teamOwner,
		fields: githubApp,
	})
	expect(saved.status).toBe(200)
	expect(await appCount(db, teamId)).toBe(1)

	const personal = await saveAccountOAuthApp({
		env,
		user: memberPersonal,
		fields: { ...githubApp, clientId: 'personal-github-client' },
	})
	expect(personal.status).toBe(200)

	await expectDenied(
		rotateAccountOauthAppCredentials({
			env,
			user: teamMember,
			appSlug: 'github',
			clientId: 'member-rotated-client',
			confirm: true,
		}),
		'integration:write',
	)
	await expectDenied(
		deleteAccountOauthApp({ env, user: teamMember, appSlug: 'github' }),
		'integration:delete',
	)
	await expectDenied(
		disconnectAccountIntegration({ env, user: teamMember, name: 'github' }),
		'integration:delete',
	)
	await expectDenied(
		startAccountDeviceConnect({
			env,
			user: teamMember,
			fields: {
				provider: 'github',
				tokenUrl: githubApp.tokenUrl,
				deviceAuthorizationUrl: 'https://github.com/login/device/code',
				clientId: 'member-device-client',
			},
		}),
		'integration:write',
	)
	expect(await appCount(db, teamId)).toBe(1)

	const deleted = await deleteAccountOauthApp({
		env,
		user: teamOwner,
		appSlug: 'github',
	})
	expect(deleted.status).toBe(200)
})

test('team members can connect through an existing org OAuth app but not create or rewrite one', async () => {
	const { env, db, teamId, teamOwner, teamMember } = await setup()
	await saveAccountOAuthApp({ env, user: teamOwner, fields: githubApp })
	const { clientSecret: _secret, ...connectFields } = githubApp
	const connect = (
		fields: Partial<typeof connectFields> & {
			clientSecret?: string
		},
	) =>
		connectAccountOAuth({
			request: new Request('https://kody.local/connect/oauth'),
			refresh: {} as never,
			env,
			user: teamMember,
			fields: {
				...connectFields,
				...fields,
				allowedHosts: ['api.github.com'],
				scopes: ['repo'],
				tokenPayload: { access_token: 'member-access-token' },
			},
		})

	await expectDenied(
		connect({ clientId: 'member-own-client' }),
		'integration:write',
	)
	await expectDenied(
		connect({ clientSecret: 'member-replacement-secret' }),
		'integration:write',
	)
	expect(await appCount(db, teamId)).toBe(1)

	const connected = await connect({})
	expect(connected.status).toBe(200)
	expect(connected.data).toMatchObject({ ok: true, integrationName: 'github' })

	await expectDenied(connect({}), 'integration:write')
})

test('an OAuth app saved in one org is never prefilled or returned for another org', async () => {
	const { env, teamId, teamOwner, memberPersonal } = await setup()
	await saveAccountOAuthApp({ env, user: teamOwner, fields: githubApp })
	const personalOrgId = memberPersonal.request!.org.id

	expect(
		await findOauthAppForProviderSetup({ env, userId: teamId, name: 'github' }),
	).toMatchObject({ clientId: githubApp.clientId })
	for (const name of ['github', 'github-work']) {
		expect(
			await findOauthAppForProviderSetup({
				env,
				userId: personalOrgId,
				name,
			}),
		).toBeNull()
	}
	expect(
		await loadAccountIntegrationByName(env, teamOwner, 'github-work', {
			appSlug: 'github',
		}),
	).toMatchObject({ clientId: githubApp.clientId })
	const ownerPersonal = {
		...teamOwner,
		request: deriveRequestContext({
			user: teamOwner.mcpUser,
			source: { kind: 'session' },
		}),
	} as WebsiteUser
	for (const user of [ownerPersonal, memberPersonal]) {
		const found = await loadAccountIntegrationByName(env, user, 'github-work', {
			appSlug: 'github',
		})
		expect(found?.clientId ?? null).not.toBe(githubApp.clientId)
	}
})

test('a device poll rechecks connect access before persisting tokens', async () => {
	const { env: baseEnv, teamId, teamOwner, teamMember } = await setup()
	const env = { ...baseEnv, OAUTH_KV: createMemoryKvNamespace().kv } as Env
	await saveAccountOAuthApp({ env, user: teamOwner, fields: githubApp })
	const sessionId = 'member-device-session'
	// Started while allowed; the team's app or connection changed before approval.
	await storeDevicePendingSession({
		env,
		sessionId,
		session: {
			userId: teamId,
			deviceCode: 'device-code',
			intervalSeconds: 5,
			expiresAtMs: Date.now() + 600_000,
			nextPollAtMs: 0,
			provider: 'github',
			platformAppSlug: null,
			tokenUrl: githubApp.tokenUrl,
			apiBaseUrl: githubApp.apiBaseUrl,
			authorizeUrl: null,
			deviceAuthorizationUrl: 'https://github.com/login/device/code',
			flow: 'device',
			usePkce: null,
			clientId: 'member-device-client',
			tokenExchangeStyle: null,
			allowedHosts: ['api.github.com'],
			scopes: ['repo'],
			scopeSeparator: null,
			extraAuthorizeParams: {},
			clientSecret: null,
			approvedTokenPayload: { access_token: 'member-device-token' },
		},
	})

	await expectDenied(
		pollAccountDeviceConnect({ env, user: teamMember, fields: { sessionId } }),
		'integration:write',
	)
	expect(
		await loadDevicePendingSession({ env, userId: teamId, sessionId }),
	).toMatchObject({
		approvedTokenPayload: { access_token: 'member-device-token' },
	})
	const connections = await env.APP_DB.prepare(
		`SELECT COUNT(*) AS n FROM user_integrations WHERE user_id = ?`,
	)
		.bind(teamId)
		.first<{ n: number }>()
	expect(connections?.n ?? 0).toBe(0)
})

test('a device poll does not write a start-time app secret over a rotated one', async () => {
	const { env: baseEnv, teamId, teamOwner } = await setup()
	const env = { ...baseEnv, OAUTH_KV: createMemoryKvNamespace().kv } as Env
	await saveAccountOAuthApp({ env, user: teamOwner, fields: githubApp })
	const sessionId = 'owner-device-session'
	await storeDevicePendingSession({
		env,
		sessionId,
		session: {
			userId: teamId,
			deviceCode: 'device-code',
			intervalSeconds: 5,
			expiresAtMs: Date.now() + 600_000,
			nextPollAtMs: 0,
			provider: 'github',
			platformAppSlug: null,
			tokenUrl: githubApp.tokenUrl,
			apiBaseUrl: githubApp.apiBaseUrl,
			authorizeUrl: null,
			deviceAuthorizationUrl: 'https://github.com/login/device/code',
			flow: 'device',
			usePkce: null,
			clientId: githubApp.clientId,
			tokenExchangeStyle: null,
			allowedHosts: ['api.github.com'],
			scopes: ['repo'],
			scopeSeparator: null,
			extraAuthorizeParams: {},
			// Read from the saved app at start; the owner rotated it since.
			clientSecret: 'stale-start-secret',
			clientSecretFromInput: false,
			approvedTokenPayload: { access_token: 'owner-device-token' },
		},
	})

	await pollAccountDeviceConnect({
		env,
		user: teamOwner,
		fields: { sessionId },
	})
	expect(
		await resolveConnectClientSecret({
			env,
			userId: teamId,
			provider: 'github',
		}),
	).toBe(githubApp.clientSecret)
})

test('Members add team secrets and OAuth connections unless an Owner turns member credentials off', async () => {
	const { env, db, teamId, teamOwner, teamMember, userFor } = await setup()
	await saveAccountOAuthApp({ env, user: teamOwner, fields: githubApp })
	const { clientSecret: _secret, ...connectFields } = githubApp
	const connect = (user: WebsiteUser, name: string) =>
		connectAccountOAuth({
			request: new Request('https://kody.local/connect/oauth'),
			refresh: {} as never,
			env,
			user,
			fields: {
				...connectFields,
				integrationName: name,
				allowedHosts: ['api.github.com'],
				scopes: ['repo'],
				tokenPayload: { access_token: `${name}-access-token` },
			} as never,
		})
	const saveSecret = (user: WebsiteUser, name: string, currentId?: string) =>
		saveAccountSecret({
			request: new Request('https://kody.local/connect/secrets'),
			env,
			user,
			fields: {
				...(currentId ? { currentId } : {}),
				name,
				scope: 'user',
				value: `${name}-value`,
				description: '',
				allowedHosts: [],
				allowedPackages: [],
				placement: null,
			} as never,
		})

	const memberSecret = await saveSecret(teamMember, 'memberDefaultKey')
	expect(memberSecret.data).toMatchObject({ ok: true })
	const memberSecretId = buildAccountSecretId({
		name: 'memberDefaultKey',
		scope: 'user',
		packageId: null,
	})

	const turnedOff = await updateOrgMemberCreation(db, {
		orgId: teamId,
		credentials: false,
		audit: createTestOrgAuditWriter({ appDb: db }),
	})
	expect(turnedOff).toMatchObject({ ok: true, changed: true })
	// A request context keeps the access it compiled, so take a new one, as
	// the next website request would.
	const nextMember = userFor('member', { id: teamId, role: 'member' })

	const deniedSecret = await saveSecret(nextMember, 'memberOffKey').catch(
		(error: unknown) => error,
	)
	expect(deniedSecret).toMatchObject({
		status: 403,
		permission: 'secret:create',
	})
	expect(isPermissionDeniedError(deniedSecret)).toBe(true)
	expect((deniedSecret as Error).message).toContain(
		'Members can create credentials',
	)
	await expectDenied(connect(nextMember, 'github'), 'integration:create')

	// Updating a secret the member already made still works.
	expect(
		(await saveSecret(nextMember, 'memberDefaultKey', memberSecretId)).data,
	).toMatchObject({ ok: true })
	// Owners always can.
	expect((await saveSecret(teamOwner, 'ownerKey')).data).toMatchObject({
		ok: true,
	})
	expect((await connect(teamOwner, 'github')).status).toBe(200)

	// Changing a secret someone else made needs Write on it, as in secretSet.
	const ownerSecretId = buildAccountSecretId({
		name: 'ownerKey',
		scope: 'user',
		packageId: null,
	})
	const deniedUpdate = await saveSecret(
		nextMember,
		'ownerKey',
		ownerSecretId,
	).catch((error: unknown) => error)
	expect(deniedUpdate).toMatchObject({
		status: 403,
		permission: 'secret:write',
	})
})
