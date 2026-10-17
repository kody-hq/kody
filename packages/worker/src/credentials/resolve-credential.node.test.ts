/**
 * Real-boundary coverage for the credential door: migrated APP_DB and
 * AUDIT_DB, real secrets, real org memberships and grants.
 */
import { DatabaseSync } from 'node:sqlite'
import * as Sentry from '@sentry/cloudflare'
import {
	ownerIdFromStored,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { expect, test, vi } from 'vitest'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { upsertGrant } from '#worker/orgs/access-writes.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { IntegrationHostNotAllowedError } from '#mcp/execute-modules/integration-host-allowlist.ts'
import {
	encryptUserOauthAccessToken,
	userIntegrationCredentialContext,
} from '#mcp/secrets/crypto.ts'
import { SecretHostNotApprovedError } from '#mcp/secrets/errors.ts'
import { SecretProviderGrantDeniedError } from '#mcp/secrets/secret-providers/errors.ts'
import { PackageSecretAccessDeniedError } from '#mcp/secrets/package-access.ts'
import {
	deleteSecret,
	saveSecret,
	setSecretAllowedHosts,
	setSecretAllowedPackages,
} from '#mcp/secrets/service.ts'
import {
	attestedPackageStamp,
	claimedPackageStamp,
	type PackageStamp,
} from './package-stamp.ts'
import {
	auditResolvedFetchPlacements,
	resolveCredential,
} from './resolve-credential.ts'

const scheduledAudits = vi.hoisted(() => [] as Array<Promise<unknown>>)

vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof import('cloudflare:workers')>()),
	waitUntil: (promise: Promise<unknown>) => {
		scheduledAudits.push(promise)
	},
}))

const integrationHooks = vi.hoisted(() => ({
	beforeTokenRead: null as null | (() => Promise<void>),
	duringRefresh: null as null | (() => Promise<void>),
}))

vi.mock('#mcp/secrets/secret-providers/declared-provider.ts', () => ({
	readDeclaredSecretProviderId: async () => '1password',
}))

const valueReads = vi.hoisted(() => [] as Array<string>)

vi.mock('#mcp/secrets/crypto.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#mcp/secrets/crypto.ts')>()
	return {
		...actual,
		decryptSecretValue: async (
			...args: Parameters<typeof actual.decryptSecretValue>
		) => {
			valueReads.push('secret')
			return await actual.decryptSecretValue(...args)
		},
	}
})

vi.mock('#worker/integrations/token-refresh.ts', async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import('#worker/integrations/token-refresh.ts')
		>()
	return {
		...actual,
		refreshIntegrationTokens: async (
			...args: Parameters<typeof actual.refreshIntegrationTokens>
		) => {
			const during = integrationHooks.duringRefresh
			if (!during) return await actual.refreshIntegrationTokens(...args)
			integrationHooks.duringRefresh = null
			await during()
			return {
				refreshed: false,
				skippedReason: 'refresh_not_applicable',
				refreshedAt: null,
				refreshTokenRotated: false,
			} as const
		},
	}
})

vi.mock('#worker/integrations/credentials.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#worker/integrations/credentials.ts')>()
	return {
		...actual,
		resolveIntegrationAccessToken: async (
			...args: Parameters<typeof actual.resolveIntegrationAccessToken>
		) => {
			valueReads.push('integration-token')
			await integrationHooks.beforeTokenRead?.()
			return await actual.resolveIntegrationAccessToken(...args)
		},
	}
})

const now = '2026-10-10T00:00:00.000Z'
const secretValue = 'org-secret-value-never-audited'

type AuditRow = {
	org_id: string
	actor_user_id: string | null
	actor_username: string | null
	credential_kind: string | null
	credential_id: string | null
	action: string
	resource_type: string | null
	resource_id: string | null
	result: string
	details_json: string | null
}

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const auditDb = createAuditTestDb()
	const ownerStableId = testStableUserIdFromEmail('owner@example.com')
	const orgId = ownerIdFromStored(ownerStableId)
	const memberId = testStableUserIdFromEmail('member@example.com')
	const collaboratorId = testStableUserIdFromEmail('collab@example.com')
	for (const [stableUserId, username] of [
		[ownerStableId, 'owner'],
		[memberId, 'member'],
		[collaboratorId, 'collab'],
	] as const) {
		await provisionPersonalOrg(db, { stableUserId, username, createdAt: now })
	}
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(orgId, memberId, now)
		.run()
	const packageId = crypto.randomUUID()
	await insertSavedPackage(
		db,
		{
			id: packageId,
			user_id: orgId,
			name: '@owner/notes',
			kody_id: 'notes',
			description: 'notes',
			tags_json: '[]',
			search_text: null,
			source_id: `source-${packageId}`,
			has_app: 0,
			has_skills: 0,
			hidden: 0,
			is_private: 1,
			created_at: now,
			updated_at: now,
		},
		null,
		{ stamp: false },
	)
	const env = {
		APP_DB: db,
		AUDIT_DB: auditDb,
		...createInMemoryUserMeterEnv().env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	await saveSecret({
		env,
		userId: orgId,
		scope: 'user',
		name: 'orgToken',
		value: secretValue,
	})
	await upsertGrant({
		db,
		orgId,
		resourceType: 'package',
		resourceId: packageId,
		family: 'package',
		subject: { type: 'user', id: collaboratorId },
		preset: 'use',
		permissions: null,
		createdByUserId: ownerStableId,
		audit: createTestOrgAuditWriter(),
	})

	const personRequest = (
		stableUserId: string,
		username: string,
		role: OrgRole | null,
	) =>
		deriveRequestContext({
			user: { userId: personIdFromStored(stableUserId), username },
			source: { kind: 'mcp-oauth' },
			orgBinding: { org: { id: orgId, slug: 'owner' }, role },
		})
	const resolveSecretAs = (
		actor: ReturnType<typeof personRequest> | null,
		packageStamp: PackageStamp | null = null,
		name = 'orgToken',
	) =>
		resolveCredential({
			env,
			orgId,
			actor,
			packageStamp,
			baseUrl: 'https://example.com',
			credential: {
				use: 'secret',
				name,
				storageContext: {
					sessionId: null,
					appId: null,
					packageId: packageStamp?.packageId ?? null,
				},
			},
		})
	const secretIdOf = async (name: string) => {
		const row = await db
			.prepare(`SELECT id FROM secret_entries WHERE name = ?`)
			.bind(name)
			.first<{ id: string }>()
		if (!row) throw new Error(`No secret entry named ${name}.`)
		return row.id
	}
	const grantUse = (resourceId: string, userId: string) =>
		upsertGrant({
			db,
			orgId,
			resourceType: 'credential',
			resourceId,
			family: 'secret',
			subject: { type: 'user', id: userId },
			preset: 'use',
			permissions: null,
			createdByUserId: ownerStableId,
			audit: createTestOrgAuditWriter(),
		})
	const auditRows = async () => {
		await Promise.all(scheduledAudits.splice(0))
		const { results } = await auditDb
			.prepare(
				`SELECT * FROM org_audit_events
				 WHERE action = 'credential.resolve' ORDER BY rowid`,
			)
			.all<AuditRow>()
		return results
	}
	return {
		env,
		db,
		auditDb,
		orgId,
		ownerStableId,
		memberId,
		collaboratorId,
		packageId,
		personRequest,
		resolveSecretAs,
		secretIdOf,
		grantUse,
		auditRows,
	}
}

function details(row: AuditRow | undefined) {
	return JSON.parse(row?.details_json ?? 'null') as Record<string, unknown>
}

async function denial(promise: Promise<unknown>) {
	return promise.then(
		() => null,
		(error: unknown) => error,
	)
}

test('owner resolves an ad-hoc secret; the door schedules exactly one audit row without the value', async () => {
	const t = await setup()
	const owner = t.personRequest(t.ownerStableId, 'owner', 'owner')

	const resolved = await t.resolveSecretAs(owner)
	expect(resolved).toMatchObject({ found: true, value: secretValue })
	expect(scheduledAudits).toHaveLength(1)
	const credentialId = await t.secretIdOf('orgToken')

	const rows = await t.auditRows()
	expect(rows).toHaveLength(1)
	expect(rows[0]).toMatchObject({
		org_id: t.orgId,
		actor_user_id: t.ownerStableId,
		actor_username: 'owner',
		credential_kind: 'mcp-oauth',
		action: 'credential.resolve',
		resource_type: 'secret',
		resource_id: credentialId,
		result: 'success',
	})
	expect(details(rows[0])).toEqual({
		use: 'secret',
		name: 'orgToken',
		actorKind: 'person',
		ownerKind: 'org',
		packageStampKind: 'none',
		packageId: null,
		host: null,
	})
	expect(JSON.stringify(rows)).not.toContain(secretValue)

	// One row per resolution, including a missing credential.
	await t.resolveSecretAs(owner)
	await expect(
		t.resolveSecretAs(owner, null, 'missingToken'),
	).resolves.toMatchObject({ found: false })
	const more = await t.auditRows()
	expect(more.map((row) => [row.resource_id, row.result])).toEqual([
		[credentialId, 'success'],
		[credentialId, 'success'],
		[null, 'failure'],
	])
	expect(details(more[2])).toMatchObject({
		name: 'missingToken',
		reason: 'not_found',
	})
})

test('ad-hoc use without secret:use is denied and audited as denied (#3169)', async () => {
	const t = await setup()
	for (const actor of [
		t.personRequest(t.memberId, 'member', 'member'),
		t.personRequest(t.collaboratorId, 'collab', null),
	]) {
		const error = await denial(t.resolveSecretAs(actor))
		expect(error).toBeInstanceOf(AuthorizationError)
		expect(error).toMatchObject({
			code: 'missing_permission',
			permission: 'secret:use',
		})
	}
	const rows = await t.auditRows()
	expect(rows.map((row) => [row.actor_user_id, row.result])).toEqual([
		[t.memberId, 'denied'],
		[t.collaboratorId, 'denied'],
	])
	expect(details(rows[0])).toMatchObject({
		reason: 'missing_permission',
		packageStampKind: 'none',
	})
})

test('no package stamp skips the person’s Use, claimed or attested (#3210)', async () => {
	const t = await setup()
	const member = t.personRequest(t.memberId, 'member', 'member')

	for (const stamp of [
		claimedPackageStamp(t.packageId),
		attestedPackageStamp(t.packageId),
	]) {
		const error = await denial(t.resolveSecretAs(member, stamp))
		expect(error).toBeInstanceOf(AuthorizationError)
		expect(error).toMatchObject({ code: 'missing_permission' })
	}

	const rows = await t.auditRows()
	expect(rows.map((row) => row.result)).toEqual(['denied', 'denied'])
	expect(details(rows[0])).toMatchObject({
		packageStampKind: 'claimed',
		packageId: t.packageId,
	})
	expect(details(rows[1])).toMatchObject({
		packageStampKind: 'attested',
		packageId: t.packageId,
	})
})

test('a removed member is denied at resolve time even with a stale request context', async () => {
	const t = await setup()
	const attested = attestedPackageStamp(t.packageId)
	const beforeRemoval = await denial(
		t.resolveSecretAs(
			t.personRequest(t.memberId, 'member', 'member'),
			attested,
		),
	)
	expect(beforeRemoval).toMatchObject({ code: 'missing_permission' })

	// Only the membership row ends: the door re-reads access itself instead
	// of relying on the removal cascade or the role baked into the request.
	await t.db
		.prepare(
			`UPDATE org_memberships SET deleted_at = ? WHERE org_id = ? AND user_id = ?`,
		)
		.bind(now, t.orgId, t.memberId)
		.run()
	const staleRequest = t.personRequest(t.memberId, 'member', 'member')
	for (const packageStamp of [null, attested]) {
		const error = await denial(t.resolveSecretAs(staleRequest, packageStamp))
		expect(error).toBeInstanceOf(AuthorizationError)
		expect(error).toMatchObject({ code: 'wrong_org' })
	}

	// A live grant left in place makes them an outside collaborator, who keeps
	// access to what the grant covers.
	await t.grantUse(await t.secretIdOf('orgToken'), t.memberId)
	await expect(
		t.resolveSecretAs(t.personRequest(t.memberId, 'member', null)),
	).resolves.toMatchObject({ found: true })

	const rows = await t.auditRows()
	expect(rows.map((row) => row.result)).toEqual([
		'denied',
		'denied',
		'denied',
		'success',
	])
	expect(details(rows[1])).toMatchObject({ reason: 'wrong_org' })
})

test('a trigger with no enablement holds nothing; webhook verification still resolves', async () => {
	const t = await setup()
	const schedule = deriveRequestContext({
		user: { userId: personIdFromStored(t.ownerStableId), username: 'owner' },
		source: { kind: 'schedule', jobId: 'job-1' },
		orgBinding: { org: { id: t.orgId, slug: 'owner' }, role: 'owner' },
	})
	const noPerson = await denial(
		resolveCredential({
			env: t.env,
			orgId: t.orgId,
			actor: schedule,
			baseUrl: 'https://example.com',
			credential: {
				use: 'secret',
				name: 'orgToken',
				storageContext: { sessionId: null, appId: null, packageId: null },
			},
		}),
	)
	expect(noPerson).toMatchObject({ code: 'missing_permission' })
	await expect(
		resolveCredential({
			env: t.env,
			orgId: t.orgId,
			actor: null,
			packageStamp: attestedPackageStamp(t.packageId),
			baseUrl: 'https://example.com',
			credential: { use: 'webhook-secret', name: 'orgToken' },
		}),
	).resolves.toMatchObject({ found: true })

	const rows = await t.auditRows()
	expect(rows).toHaveLength(2)
	expect(rows[0]).toMatchObject({
		actor_user_id: null,
		credential_kind: 'schedule',
		credential_id: 'job-1',
		result: 'denied',
	})
	expect(details(rows[0])).toMatchObject({
		use: 'secret',
		actorKind: 'automation',
		packageStampKind: 'none',
	})
	expect(rows[1]).toMatchObject({ actor_user_id: null, credential_kind: null })
	expect(details(rows[1])).toMatchObject({
		use: 'webhook-secret',
		actorKind: 'platform',
		packageStampKind: 'attested',
		packageId: t.packageId,
	})
})

test('a webhook reads only a secret its own package may read (#3245)', async () => {
	const t = await setup()
	const forkId = crypto.randomUUID()
	await insertSavedPackage(
		t.db,
		{
			id: forkId,
			user_id: t.orgId,
			name: '@owner/forked',
			kody_id: 'forked',
			description: 'an unadopted community fork',
			tags_json: '[]',
			search_text: null,
			source_id: `source-${forkId}`,
			has_app: 0,
			has_skills: 0,
			hidden: 0,
			is_private: 1,
			created_at: now,
			updated_at: now,
		},
		null,
		{ stamp: false },
	)
	await t.db
		.prepare(
			`INSERT INTO community_forks (
				id, listing_id, forker_user_id, origin_commit, forked_package_id,
				forked_source_id, target_kody_id, created_at
			) VALUES (?, ?, ?, 'origin', ?, ?, 'forked', ?)`,
		)
		.bind(
			`fork-${forkId}`,
			'listing-1',
			t.orgId,
			forkId,
			`source-${forkId}`,
			now,
		)
		.run()
	await setSecretAllowedPackages({
		env: t.env,
		userId: t.orgId,
		name: 'orgToken',
		scope: 'user',
		allowedPackages: [t.packageId],
	})
	const webhookRead = (input: {
		actor: ReturnType<typeof t.personRequest> | null
		packageId: string | null
	}) =>
		resolveCredential({
			env: t.env,
			orgId: t.orgId,
			actor: input.actor,
			packageStamp: input.packageId
				? attestedPackageStamp(input.packageId)
				: null,
			baseUrl: 'https://example.com',
			credential: { use: 'webhook-secret', name: 'orgToken' },
		})
	const owner = () => t.personRequest(t.ownerStableId, 'owner', 'owner')

	// Signature verification at ingress has no person, so the package check is
	// the only gate there; an Owner applying a delivery is held to it too.
	expect(
		await denial(webhookRead({ actor: null, packageId: forkId })),
	).toBeInstanceOf(PackageSecretAccessDeniedError)
	expect(
		await denial(webhookRead({ actor: owner(), packageId: forkId })),
	).toBeInstanceOf(PackageSecretAccessDeniedError)
	expect(
		await denial(webhookRead({ actor: null, packageId: null })),
	).toBeInstanceOf(Error)
	await expect(
		webhookRead({ actor: null, packageId: t.packageId }),
	).resolves.toMatchObject({ found: true, value: secretValue })

	const rows = await t.auditRows()
	expect(rows.map((row) => row.result)).toEqual([
		'denied',
		'denied',
		'failure',
		'success',
	])
	for (const row of rows) {
		expect(row.details_json ?? '').not.toContain(secretValue)
	}
})

test('a package app in a team org acts as its visitor, never as the org itself; a deleted org is denied', async () => {
	const t = await setup()
	const created = await createOrganization(
		t.db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: personIdFromStored(t.ownerStableId),
			audit: createTestOrgAuditWriter(),
			slug: 'zeta-co',
			displayName: 'Zeta Co',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const teamOrg = await t.db
		.prepare(`SELECT id FROM orgs WHERE slug = 'zeta-co'`)
		.first<{ id: string }>()
	const teamOrgId = ownerIdFromStored(teamOrg!.id)
	const teamPackageId = 'pkg-team-app'
	await t.db
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
			 VALUES (?, ?, 'team-app', 'team-app', '', 'source-pkg-team-app')`,
		)
		.bind(teamPackageId, teamOrgId)
		.run()
	await saveSecret({
		env: t.env,
		userId: teamOrgId,
		scope: 'user',
		name: 'teamToken',
		value: secretValue,
	})
	// What `PackageAppRuntimeBridge` builds for its Owner visitor.
	const visitorRequest = () =>
		deriveRequestContext({
			user: { userId: personIdFromStored(t.ownerStableId) },
			source: { kind: 'package-app' },
			orgBinding: { org: { id: teamOrgId, slug: 'zeta-co' }, role: 'owner' },
		})
	const orgAsActor = deriveRequestContext({
		user: { userId: personIdFromStored(teamOrg!.id) },
		source: { kind: 'package-app' },
		orgBinding: { org: { id: teamOrgId, slug: 'zeta-co' }, role: 'owner' },
	})
	const resolve = (actor = visitorRequest()) =>
		resolveCredential({
			env: t.env,
			orgId: teamOrgId,
			actor,
			packageStamp: attestedPackageStamp(teamPackageId),
			baseUrl: 'https://example.com',
			credential: {
				use: 'secret',
				name: 'teamToken',
				storageContext: {
					sessionId: null,
					appId: null,
					packageId: teamPackageId,
				},
			},
		})

	await expect(resolve()).resolves.toMatchObject({ value: secretValue })
	// The org's own id is no person and has no membership in it.
	await expect(resolve(orgAsActor)).rejects.toMatchObject({
		code: 'wrong_org',
	})
	await t.db
		.prepare(`UPDATE orgs SET deleted_at = ? WHERE id = ?`)
		.bind(now, teamOrgId)
		.run()
	await expect(resolve()).rejects.toMatchObject({ code: 'wrong_org' })

	const rows = await t.auditRows()
	expect(rows.map((row) => [row.org_id, row.result])).toEqual([
		[teamOrgId, 'success'],
		[teamOrgId, 'denied'],
		[teamOrgId, 'denied'],
	])
})

test('an actor from another org is denied before any credential read', async () => {
	const t = await setup()
	const otherOrg = ownerIdFromStored(t.memberId) as OwnerId
	const memberInOwnOrg = deriveRequestContext({
		user: { userId: personIdFromStored(t.memberId), username: 'member' },
		source: { kind: 'mcp-oauth' },
		orgBinding: { org: { id: otherOrg, slug: 'member' }, role: 'owner' },
	})
	const error = await denial(t.resolveSecretAs(memberInOwnOrg))
	expect(error).toMatchObject({ code: 'wrong_org' })
	const rows = await t.auditRows()
	expect(rows).toHaveLength(1)
	expect(rows[0]).toMatchObject({ org_id: t.orgId, result: 'denied' })
})

test('a host the secret is not approved for is an audited denial, not a success', async () => {
	const t = await setup()
	const owner = t.personRequest(t.ownerStableId, 'owner', 'owner')
	const resolveForHost = (requestHost: string) =>
		resolveCredential({
			env: t.env,
			orgId: t.orgId,
			actor: owner,
			baseUrl: 'https://example.com',
			credential: {
				use: 'secret',
				name: 'orgToken',
				storageContext: { sessionId: null, appId: null, packageId: null },
				requestHost,
			},
		})

	const error = await denial(resolveForHost('evil.example'))
	expect(error).toBeInstanceOf(SecretHostNotApprovedError)
	expect(error).toMatchObject({
		secretName: 'orgToken',
		host: 'evil.example',
		scope: 'user',
	})
	expect(String(error)).not.toContain(secretValue)

	await setSecretAllowedHosts({
		env: t.env,
		userId: t.orgId,
		name: 'orgToken',
		scope: 'user',
		allowedHosts: ['api.example.com'],
	})
	await expect(resolveForHost('api.example.com')).resolves.toMatchObject({
		value: secretValue,
	})

	const rows = await t.auditRows()
	expect(rows.map((row) => row.result)).toEqual(['denied', 'success'])
	const credentialId = await t.secretIdOf('orgToken')
	expect(rows.map((row) => row.resource_id)).toEqual([
		credentialId,
		credentialId,
	])
	expect(details(rows[0])).toMatchObject({
		reason: 'SecretHostNotApprovedError',
		host: 'evil.example',
	})
	expect(details(rows[1])).toMatchObject({ host: 'api.example.com' })
	expect(JSON.stringify(rows)).not.toContain(secretValue)
})

test('fetch placements are one audit row each, and a later place does not read the credential again', async () => {
	const t = await setup()
	const owner = t.personRequest(t.ownerStableId, 'owner', 'owner')
	await setSecretAllowedHosts({
		env: t.env,
		userId: t.orgId,
		name: 'orgToken',
		scope: 'user',
		allowedHosts: ['api.example.com'],
	})
	const readsBefore = valueReads.length
	const credential = {
		use: 'secret' as const,
		name: 'orgToken',
		storageContext: { sessionId: null, appId: null, packageId: null },
		requestHost: 'api.example.com',
	}
	expect(
		auditResolvedFetchPlacements({
			env: t.env,
			orgId: t.orgId,
			actor: owner,
			baseUrl: 'https://example.com',
			credential: {
				...credential,
				placements: [{ kind: 'body' }],
			},
		}),
	).toBe(false)
	expect(await t.auditRows()).toHaveLength(0)

	await resolveCredential({
		env: t.env,
		orgId: t.orgId,
		actor: owner,
		baseUrl: 'https://example.com',
		credential: {
			...credential,
			placements: [
				{ kind: 'header', name: 'Authorization' },
				{ kind: 'url' },
				{ kind: 'header', name: 'authorization' },
			],
		},
	})
	expect(valueReads.length - readsBefore).toBe(1)
	expect(
		auditResolvedFetchPlacements({
			env: t.env,
			orgId: t.orgId,
			actor: owner,
			baseUrl: 'https://example.com',
			credential: {
				...credential,
				requestHost: 'other.example.com',
				placements: [{ kind: 'body' }],
			},
		}),
	).toBe(false)
	// A different package stamp was not authorized by the earlier read.
	expect(
		auditResolvedFetchPlacements({
			env: t.env,
			orgId: t.orgId,
			actor: owner,
			packageStamp: claimedPackageStamp(t.packageId),
			baseUrl: 'https://example.com',
			credential: {
				...credential,
				placements: [{ kind: 'body' }],
			},
		}),
	).toBe(false)
	expect(
		auditResolvedFetchPlacements({
			env: t.env,
			orgId: t.orgId,
			actor: owner,
			baseUrl: 'https://example.com',
			credential: {
				...credential,
				placements: [{ kind: 'body' }, { kind: 'url' }],
			},
		}),
	).toBe(true)
	expect(valueReads.length - readsBefore).toBe(1)

	const rows = await t.auditRows()
	const credentialId = await t.secretIdOf('orgToken')
	expect(rows.map((row) => [row.resource_id, row.result])).toEqual([
		[credentialId, 'success'],
		[credentialId, 'success'],
		[credentialId, 'success'],
	])
	expect(rows.map((row) => details(row).placement)).toEqual([
		'authorization',
		'url',
		'body',
	])
	expect(details(rows[2])).toMatchObject({
		host: 'api.example.com',
		name: 'orgToken',
		packageStampKind: 'none',
	})
	expect(JSON.stringify(rows)).not.toContain(secretValue)
})

test('a header named body stays distinct from a body placement', async () => {
	const t = await setup()
	const owner = t.personRequest(t.ownerStableId, 'owner', 'owner')
	await setSecretAllowedHosts({
		env: t.env,
		userId: t.orgId,
		name: 'orgToken',
		scope: 'user',
		allowedHosts: ['api.example.com'],
	})
	const readsBefore = valueReads.length
	await resolveCredential({
		env: t.env,
		orgId: t.orgId,
		actor: owner,
		baseUrl: 'https://example.com',
		credential: {
			use: 'secret',
			name: 'orgToken',
			storageContext: { sessionId: null, appId: null, packageId: null },
			requestHost: 'api.example.com',
			placements: [{ kind: 'header', name: 'Body' }, { kind: 'body' }],
		},
	})
	expect(valueReads.length - readsBefore).toBe(1)
	const rows = await t.auditRows()
	expect(rows.map((row) => details(row).placement)).toEqual([
		'header:body',
		'body',
	])
	expect(JSON.stringify(rows)).not.toContain(secretValue)
})

test('a refused fetch placement is audited for every place the placeholder appeared', async () => {
	const t = await setup()
	const owner = t.personRequest(t.ownerStableId, 'owner', 'owner')
	const readsBefore = valueReads.length
	const error = await denial(
		resolveCredential({
			env: t.env,
			orgId: t.orgId,
			actor: owner,
			baseUrl: 'https://example.com',
			credential: {
				use: 'secret',
				name: 'orgToken',
				storageContext: { sessionId: null, appId: null, packageId: null },
				requestHost: 'evil.example',
				placements: [{ kind: 'header', name: 'x-api-key' }, { kind: 'body' }],
			},
		}),
	)
	expect(error).toBeInstanceOf(SecretHostNotApprovedError)
	expect(valueReads.length - readsBefore).toBe(0)
	const rows = await t.auditRows()
	const credentialId = await t.secretIdOf('orgToken')
	expect(rows.map((row) => [row.resource_id, row.result])).toEqual([
		[credentialId, 'denied'],
		[credentialId, 'denied'],
	])
	expect(rows.map((row) => details(row).placement)).toEqual([
		'x-api-key',
		'body',
	])
	expect(details(rows[0])).toMatchObject({
		reason: 'SecretHostNotApprovedError',
		host: 'evil.example',
	})
	expect(JSON.stringify(rows)).not.toContain(secretValue)
})

test('a claimed package stamp is held to vault grants, and an invalid provider id is still audited', async () => {
	const t = await setup()
	const doorSecretName = 'onePasswordServiceAccountToken'
	await t.db
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
			 VALUES ('pkg-provider', ?, 'op', 'op', '', 'source-pkg-provider')`,
		)
		.bind(t.orgId)
		.run()
	await saveSecret({
		env: t.env,
		userId: t.orgId,
		scope: 'user',
		name: doorSecretName,
		value: 'op-sa-token',
	})
	await t.db
		.prepare(
			`INSERT INTO secret_provider_bindings (
				user_id, provider_id, package_id, door_secret_name, config_json
			) VALUES (?, '1password', 'pkg-provider', ?, '{}')`,
		)
		.bind(t.orgId, doorSecretName)
		.run()
	const owner = t.personRequest(t.ownerStableId, 'owner', 'owner')
	const resolveVault = (provider: string) =>
		resolveCredential({
			env: t.env,
			orgId: t.orgId,
			actor: owner,
			packageStamp: claimedPackageStamp(t.packageId),
			baseUrl: 'https://example.com',
			credential: {
				use: 'provider-secret',
				provider,
				ref: 'i/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/password',
				storageContext: {
					sessionId: null,
					appId: null,
					packageId: t.packageId,
				},
			},
		})

	// The owner has Use on the door key; the claimed package has no grant.
	await expect(resolveVault('1password')).rejects.toBeInstanceOf(
		SecretProviderGrantDeniedError,
	)
	await expect(resolveVault('x'.repeat(65))).rejects.toThrow(/is invalid/)

	const binding = await t.db
		.prepare(`SELECT id FROM secret_provider_bindings WHERE user_id = ?`)
		.bind(t.orgId)
		.first<{ id: string }>()
	const rows = await t.auditRows()
	expect(rows.map((row) => [row.resource_id, row.result])).toEqual([
		[binding?.id, 'denied'],
		[null, 'failure'],
	])
	expect(details(rows[0])).toMatchObject({
		name: '1password',
		reason: 'SecretProviderGrantDeniedError',
		packageStampKind: 'claimed',
	})
})

test('a failed org access lookup is retried on the next resolution, not cached', async () => {
	const t = await setup()
	let failNextPrepare = true
	const flakyDb = new Proxy(t.db, {
		get(target, property) {
			if (property === 'prepare' && failNextPrepare) {
				return () => {
					failNextPrepare = false
					throw new Error('D1 unavailable')
				}
			}
			const value = Reflect.get(target, property, target) as unknown
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
	const env = { ...t.env, APP_DB: flakyDb } as Env
	const owner = t.personRequest(t.ownerStableId, 'owner', 'owner')
	const resolve = () =>
		resolveCredential({
			env,
			orgId: t.orgId,
			actor: owner,
			baseUrl: 'https://example.com',
			credential: {
				use: 'secret',
				name: 'orgToken',
				storageContext: { sessionId: null, appId: null, packageId: null },
			},
		})

	await expect(resolve()).rejects.toThrow('D1 unavailable')
	await expect(resolve()).resolves.toMatchObject({ value: secretValue })

	const rows = await t.auditRows()
	expect(rows.map((row) => row.result)).toEqual(['failure', 'success'])
})

test('an audit write failure is logged without the value and never fails the resolution', async () => {
	const t = await setup()
	// D1 failures can echo bound parameters on the Error; keep a sentinel in
	// the message so a regression that logs the object fails this test.
	const auditWriteError = new Error(
		`audit db unavailable binding=${secretValue}`,
	)
	const env = {
		...t.env,
		AUDIT_DB: {
			prepare() {
				throw auditWriteError
			},
		} as unknown as D1Database,
	} as Env
	consoleError.mockImplementation(() => {})
	const captureException = vi.spyOn(Sentry, 'captureException')
	await expect(
		resolveCredential({
			env,
			orgId: t.orgId,
			actor: t.personRequest(t.ownerStableId, 'owner', 'owner'),
			baseUrl: 'https://example.com',
			credential: {
				use: 'secret',
				name: 'orgToken',
				storageContext: { sessionId: null, appId: null, packageId: null },
			},
		}),
	).resolves.toMatchObject({ value: secretValue })
	await Promise.all(scheduledAudits.splice(0))
	expect(consoleError).toHaveBeenCalledTimes(1)
	expect(consoleError.mock.calls[0]?.[0]).toBe(
		'Failed to record credential resolution audit event:',
	)
	expect(consoleError.mock.calls[0]?.[1]).toEqual({
		action: 'credential.resolve',
		orgId: t.orgId,
		result: 'success',
		errorName: 'Error',
	})
	const consolePayload = JSON.stringify(consoleError.mock.calls[0]?.[1])
	expect(consolePayload).not.toContain(secretValue)
	expect(consolePayload).not.toContain('audit db unavailable')
	expect(consolePayload).not.toContain('binding=')
	expect(captureException).toHaveBeenCalledExactlyOnceWith(auditWriteError)
	captureException.mockRestore()
})

test('a Use grant follows the credential id through a rename; a deleted and recreated name does not inherit it', async () => {
	const t = await setup()
	const collaborator = () => t.personRequest(t.collaboratorId, 'collab', null)
	const owner = t.personRequest(t.ownerStableId, 'owner', 'owner')
	const originalId = await t.secretIdOf('orgToken')
	await t.grantUse(originalId, t.collaboratorId)
	await expect(t.resolveSecretAs(collaborator())).resolves.toMatchObject({
		value: secretValue,
	})

	await t.db
		.prepare(`UPDATE secret_entries SET name = 'renamedToken' WHERE id = ?`)
		.bind(originalId)
		.run()
	await expect(
		t.resolveSecretAs(collaborator(), null, 'renamedToken'),
	).resolves.toMatchObject({ value: secretValue })
	// The old name no longer exists; a non-holder of secret:use gets a
	// denial, not a not-found that would reveal it.
	await expect(t.resolveSecretAs(collaborator())).rejects.toMatchObject({
		code: 'missing_permission',
	})

	await deleteSecret({
		env: t.env,
		userId: t.orgId,
		scope: 'user',
		name: 'renamedToken',
	})
	await saveSecret({
		env: t.env,
		userId: t.orgId,
		scope: 'user',
		name: 'renamedToken',
		value: 'recreated-value',
	})
	expect(await t.secretIdOf('renamedToken')).not.toBe(originalId)
	const error = await denial(
		t.resolveSecretAs(collaborator(), null, 'renamedToken'),
	)
	expect(error).toBeInstanceOf(AuthorizationError)
	expect(String(error)).not.toContain('recreated-value')
	await expect(
		t.resolveSecretAs(owner, null, 'renamedToken'),
	).resolves.toMatchObject({ value: 'recreated-value' })

	const rows = await t.auditRows()
	expect(rows.map((row) => [row.resource_id, row.result])).toEqual([
		[originalId, 'success'],
		[originalId, 'success'],
		[null, 'denied'],
		[await t.secretIdOf('renamedToken'), 'denied'],
		[await t.secretIdOf('renamedToken'), 'success'],
	])
})

test('a vault Use grant is keyed by the binding: it survives a door key rename, not a recreated binding', async () => {
	const t = await setup()
	await t.db
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
			 VALUES ('pkg-provider', ?, 'op', 'op', '', 'source-pkg-provider')`,
		)
		.bind(t.orgId)
		.run()
	await saveSecret({
		env: t.env,
		userId: t.orgId,
		scope: 'user',
		name: 'opToken',
		value: 'op-sa-token',
	})
	const insertBinding = (doorSecretName: string) =>
		t.db
			.prepare(
				`INSERT INTO secret_provider_bindings (
					user_id, provider_id, package_id, door_secret_name, config_json
				) VALUES (?, '1password', 'pkg-provider', ?, '{}')`,
			)
			.bind(t.orgId, doorSecretName)
			.run()
	const bindingId = async () =>
		(
			await t.db
				.prepare(`SELECT id FROM secret_provider_bindings WHERE user_id = ?`)
				.bind(t.orgId)
				.first<{ id: string }>()
		)?.id ?? ''
	await insertBinding('opToken')
	// The claimed package has no vault grant, so passing Use surfaces as the
	// package-grant denial and failing it as an AuthorizationError.
	const resolveVault = () =>
		resolveCredential({
			env: t.env,
			orgId: t.orgId,
			actor: t.personRequest(t.collaboratorId, 'collab', null),
			packageStamp: claimedPackageStamp(t.packageId),
			baseUrl: 'https://example.com',
			credential: {
				use: 'provider-secret',
				provider: '1password',
				ref: 'i/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/password',
				storageContext: {
					sessionId: null,
					appId: null,
					packageId: t.packageId,
				},
			},
		})

	await expect(resolveVault()).rejects.toBeInstanceOf(AuthorizationError)
	// The denial names the vault, not its door key.
	await expect(resolveVault()).rejects.toThrow(/secret 1password\b/)
	// Use on the door key secret alone is not Use on the vault.
	await t.grantUse(await t.secretIdOf('opToken'), t.collaboratorId)
	await expect(resolveVault()).rejects.toBeInstanceOf(AuthorizationError)

	const originalBindingId = await bindingId()
	await t.grantUse(originalBindingId, t.collaboratorId)
	await expect(resolveVault()).rejects.toBeInstanceOf(
		SecretProviderGrantDeniedError,
	)

	await t.db.batch([
		t.db.prepare(
			`UPDATE secret_entries SET name = 'opTokenRenamed' WHERE name = 'opToken'`,
		),
		t.db
			.prepare(
				`UPDATE secret_provider_bindings SET door_secret_name = 'opTokenRenamed' WHERE id = ?`,
			)
			.bind(originalBindingId),
	])
	await expect(resolveVault()).rejects.toBeInstanceOf(
		SecretProviderGrantDeniedError,
	)

	await t.db
		.prepare(`DELETE FROM secret_provider_bindings WHERE id = ?`)
		.bind(originalBindingId)
		.run()
	await insertBinding('opTokenRenamed')
	expect(await bindingId()).not.toBe(originalBindingId)
	await expect(resolveVault()).rejects.toBeInstanceOf(AuthorizationError)
})

test('an integration Use grant does not carry over to a deleted and recreated connection of the same name', async () => {
	const t = await setup()
	const insertConnection = () =>
		t.db
			.prepare(
				`INSERT INTO user_integrations (user_id, name, app_slug) VALUES (?, 'orgGoogle', 'google')`,
			)
			.bind(t.orgId)
			.run()
	const connectionId = async () =>
		(
			await t.db
				.prepare(`SELECT id FROM user_integrations WHERE name = 'orgGoogle'`)
				.first<{ id: string }>()
		)?.id ?? ''
	const resolveToken = () =>
		resolveCredential({
			env: t.env,
			orgId: t.orgId,
			actor: t.personRequest(t.collaboratorId, 'collab', null),
			baseUrl: 'https://example.com',
			credential: { use: 'integration-token', name: 'orgGoogle' },
		})
	await t.db
		.prepare(
			`INSERT INTO user_oauth_apps (user_id, slug, provider, client_id, token_url, flow)
			 VALUES (?, 'google', 'google', 'client-id', 'https://oauth2.example.com/token', 'pkce')`,
		)
		.bind(t.orgId)
		.run()
	await insertConnection()
	await expect(resolveToken()).rejects.toMatchObject({
		code: 'missing_permission',
		permission: 'integration:use',
	})

	const originalId = await connectionId()
	await upsertGrant({
		db: t.db,
		orgId: t.orgId,
		resourceType: 'credential',
		resourceId: originalId,
		family: 'integration',
		subject: { type: 'user', id: t.collaboratorId },
		preset: 'use',
		permissions: null,
		createdByUserId: t.ownerStableId,
		audit: createTestOrgAuditWriter(),
	})
	// Granted, with no stored token yet.
	await expect(resolveToken()).resolves.toBeNull()

	await t.db
		.prepare(`DELETE FROM user_integrations WHERE id = ?`)
		.bind(originalId)
		.run()
	await insertConnection()
	expect(await connectionId()).not.toBe(originalId)
	await expect(resolveToken()).rejects.toMatchObject({
		code: 'missing_permission',
		permission: 'integration:use',
	})
})

test('authorize runs before apply: a denied actor or a refused host never decrypts the secret', async () => {
	const t = await setup()
	await setSecretAllowedHosts({
		env: t.env,
		userId: t.orgId,
		name: 'orgToken',
		scope: 'user',
		allowedHosts: ['api.example.com'],
	})
	const owner = t.personRequest(t.ownerStableId, 'owner', 'owner')
	const resolveAs = (
		actor: ReturnType<typeof t.personRequest>,
		requestHost: string,
	) =>
		resolveCredential({
			env: t.env,
			orgId: t.orgId,
			actor,
			baseUrl: 'https://example.com',
			credential: {
				use: 'secret',
				name: 'orgToken',
				storageContext: { sessionId: null, appId: null, packageId: null },
				requestHost,
			},
		})
	valueReads.splice(0)

	await expect(
		resolveAs(
			t.personRequest(t.collaboratorId, 'collab', null),
			'api.example.com',
		),
	).rejects.toBeInstanceOf(AuthorizationError)
	await expect(resolveAs(owner, 'evil.example')).rejects.toBeInstanceOf(
		SecretHostNotApprovedError,
	)
	expect(valueReads).toEqual([])

	await expect(resolveAs(owner, 'api.example.com')).resolves.toMatchObject({
		value: secretValue,
	})
	expect(valueReads).toEqual(['secret'])
	expect((await t.auditRows()).map((row) => row.result)).toEqual([
		'denied',
		'denied',
		'success',
	])
})

test('a host the integration does not allow never reads or refreshes its token', async () => {
	const t = await setup()
	await t.db
		.prepare(
			`INSERT INTO user_oauth_apps (user_id, slug, provider, client_id, token_url, api_base_url, flow)
			 VALUES (?, 'google', 'google', 'client-id', 'https://oauth2.example.com/token', 'https://api.example.com', 'pkce')`,
		)
		.bind(t.orgId)
		.run()
	const accessToken = 'integration-token-never-audited'
	await t.db
		.prepare(
			`INSERT INTO user_integrations (user_id, name, app_slug, required_hosts_json, access_token_encrypted)
			 VALUES (?, 'org-google', 'google', '["api.example.com"]', ?)`,
		)
		.bind(
			t.orgId,
			await encryptUserOauthAccessToken(
				t.env,
				accessToken,
				userIntegrationCredentialContext(t.orgId, 'org-google'),
			),
		)
		.run()
	const resolveToken = (requestHost: string) =>
		resolveCredential({
			env: t.env,
			orgId: t.orgId,
			actor: t.personRequest(t.ownerStableId, 'owner', 'owner'),
			baseUrl: 'https://example.com',
			credential: { use: 'integration-token', name: 'org-google', requestHost },
		})
	valueReads.splice(0)

	await expect(resolveToken('evil.example')).rejects.toBeInstanceOf(
		IntegrationHostNotAllowedError,
	)
	expect(valueReads).toEqual([])

	await expect(resolveToken('api.example.com')).resolves.toBe(accessToken)
	expect(valueReads).toEqual(['integration-token'])
	expect((await t.auditRows()).map((row) => row.result)).toEqual([
		'denied',
		'success',
	])
})

test('a connection replaced after the Use check never hands its token to the old grant', async () => {
	const t = await setup()
	await t.db
		.prepare(
			`INSERT INTO user_oauth_apps (user_id, slug, provider, client_id, token_url, flow)
			 VALUES (?, 'google', 'google', 'client-id', 'https://oauth2.example.com/token', 'pkce')`,
		)
		.bind(t.orgId)
		.run()
	const insertConnection = () =>
		t.db
			.prepare(
				`INSERT INTO user_integrations (user_id, name, app_slug) VALUES (?, 'orgGoogle', 'google')`,
			)
			.bind(t.orgId)
			.run()
	await insertConnection()
	const originalId =
		(
			await t.db
				.prepare(`SELECT id FROM user_integrations WHERE name = 'orgGoogle'`)
				.first<{ id: string }>()
		)?.id ?? ''
	await upsertGrant({
		db: t.db,
		orgId: t.orgId,
		resourceType: 'credential',
		resourceId: originalId,
		family: 'integration',
		subject: { type: 'user', id: t.collaboratorId },
		preset: 'use',
		permissions: null,
		createdByUserId: t.ownerStableId,
		audit: createTestOrgAuditWriter(),
	})
	integrationHooks.beforeTokenRead = async () => {
		integrationHooks.beforeTokenRead = null
		await t.db
			.prepare(`DELETE FROM user_integrations WHERE id = ?`)
			.bind(originalId)
			.run()
		await insertConnection()
	}
	await expect(
		resolveCredential({
			env: t.env,
			orgId: t.orgId,
			actor: t.personRequest(t.collaboratorId, 'collab', null),
			baseUrl: 'https://example.com',
			credential: { use: 'integration-token', name: 'orgGoogle' },
		}),
	).rejects.toThrow(/orgGoogle/)

	integrationHooks.duringRefresh = async () => {
		await t.db
			.prepare(`DELETE FROM user_integrations WHERE name = 'orgGoogle'`)
			.run()
		await insertConnection()
	}
	const replacementId =
		(
			await t.db
				.prepare(`SELECT id FROM user_integrations WHERE name = 'orgGoogle'`)
				.first<{ id: string }>()
		)?.id ?? ''
	await upsertGrant({
		db: t.db,
		orgId: t.orgId,
		resourceType: 'credential',
		resourceId: replacementId,
		family: 'integration',
		subject: { type: 'user', id: t.collaboratorId },
		preset: 'use',
		permissions: null,
		createdByUserId: t.ownerStableId,
		audit: createTestOrgAuditWriter(),
	})
	await expect(
		resolveCredential({
			env: t.env,
			orgId: t.orgId,
			actor: t.personRequest(t.collaboratorId, 'collab', null),
			baseUrl: 'https://example.com',
			credential: { use: 'integration-refresh', name: 'orgGoogle' },
		}),
	).rejects.toThrow(/orgGoogle/)
	expect(integrationHooks.duringRefresh).toBeNull()
})

test('a vault reference with no binding is checked for Use like any credential that was not found', async () => {
	const t = await setup()
	const resolveVaultAs = (actor: ReturnType<typeof t.personRequest>) =>
		resolveCredential({
			env: t.env,
			orgId: t.orgId,
			actor,
			baseUrl: 'https://example.com',
			credential: {
				use: 'provider-secret',
				provider: '1password',
				ref: 'i/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/password',
				storageContext: { sessionId: null, appId: null, packageId: null },
			},
		})
	const missingBinding = /No secret provider is bound for "1password"/

	const denied = await resolveVaultAs(
		t.personRequest(t.collaboratorId, 'collab', null),
	).then(
		() => null,
		(caught: unknown) => caught,
	)
	expect(denied).toBeInstanceOf(AuthorizationError)
	expect(String(denied)).toMatch(/Missing secret:use on secret 1password\b/)
	expect(String(denied)).not.toMatch(missingBinding)

	await expect(
		resolveVaultAs(t.personRequest(t.ownerStableId, 'owner', 'owner')),
	).rejects.toThrow(missingBinding)

	expect((await t.auditRows()).map((row) => row.result)).toEqual([
		'denied',
		'failure',
	])
})
