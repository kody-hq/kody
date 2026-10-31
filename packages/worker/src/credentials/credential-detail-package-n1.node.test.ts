/**
 * Resolving credential needs across N packages must not re-query
 * mcp_server_settings / user-scope secrets once per package (Sentry KODY-BD /
 * issue 7810484425). Shared org rows load once; package-bound Keys batch.
 */
import { DatabaseSync } from 'node:sqlite'
import { maxD1BoundParameters } from '@kody-internal/shared/chunk.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { expect, test, vi } from 'vitest'
import { saveSecret } from '#mcp/secrets/service.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { type CredentialListItem } from '#universal/credential-contracts.ts'
import {
	listUsableCredentials,
	listUsableCredentialsByPackage,
} from './credential-candidates.ts'
import { loadCredentialDetail } from './credential-detail.ts'
import * as needsClosure from './credential-needs-closure.ts'
import { isPackageCredentialSuppliersEnabled } from './credential-suppliers-flag.ts'

vi.mock(
	'#worker/test-support/apply-all-migrations.ts',
	async (importOriginal) =>
		(await import('./cached-migrations.test-support.ts')).withCachedMigrations(
			await importOriginal(),
		),
)

const now = '2026-10-24T16:05:00.000Z'

function isMcpServerSettingsListLookup(query: string) {
	const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
	return (
		normalized.includes('from mcp_server_settings') &&
		normalized.includes('user_id = ?') &&
		normalized.includes('enabled = 1') &&
		!normalized.includes(' id in (')
	)
}

function isUserScopeSecretListLookup(query: string) {
	const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
	return (
		normalized.includes('from secret_entries') &&
		normalized.includes("b.scope = 'user'") &&
		normalized.includes('b.user_id = ?') &&
		!normalized.includes("b.scope = 'package'")
	)
}

function isPackageBoundSecretListLookup(query: string) {
	const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
	return (
		normalized.includes('from secret_entries') &&
		normalized.includes("b.scope = 'package'") &&
		normalized.includes('b.binding_key in (')
	)
}

function isOrgOwnerLookup(query: string) {
	const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
	return (
		normalized.includes('from org_memberships') &&
		normalized.includes("m.role = 'owner'") &&
		normalized.includes('limit 1')
	)
}

function credentialItem(
	overrides: Partial<CredentialListItem> & { id: string; name: string },
): CredentialListItem {
	return {
		kind: 'secret',
		scope: 'org',
		provider: 'openai',
		description: '',
		hosts: [],
		inject: null,
		placement: null,
		placementOrigin: null,
		packageId: null,
		lockedToPackageIds: [],
		expiresAt: null,
		createdAt: now,
		updatedAt: now,
		status: 'ok',
		statusMessage: null,
		mcp: null,
		...overrides,
	}
}

async function setup(packageCount: number) {
	const queries: Array<string> = []
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite, {
		queries,
		maxBindings: maxD1BoundParameters,
	})
	const env = {
		APP_DB: db,
		AUDIT_DB: createAuditTestDb(),
		...createInMemoryUserMeterEnv().env,
		COOKIE_SECRET: 'test-cookie-secret',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	const stableUserId = testStableUserIdFromEmail('bea@example.com')
	const personId = personIdFromStored(stableUserId)
	await provisionPersonalOrg(db, {
		stableUserId,
		username: 'bea',
		createdAt: now,
	})
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId,
			audit: createTestOrgAuditWriter(),
			slug: 'acme-bd',
			displayName: 'Acme',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const acme = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'acme-bd'`)
		.first<{ id: string }>()
	const acmeId = ownerIdFromStored(acme!.id)

	await saveSecret({
		env,
		userId: acmeId,
		scope: 'user',
		name: 'OPENAI',
		value: 'org-openai-value',
		audit: null,
	})
	const orgKey = await db
		.prepare(
			`UPDATE secret_entries
			SET kind = 'secret', provider = 'openai', allowed_hosts = ?
			WHERE name = 'OPENAI' AND bucket_id IN (
				SELECT id FROM secret_buckets WHERE user_id = ? AND scope = 'user'
			)
			RETURNING id`,
		)
		.bind(JSON.stringify(['api.openai.com']), acmeId)
		.first<{ id: string }>()

	await db
		.prepare(
			`INSERT INTO mcp_server_settings (id, user_id, name, url, enabled)
			 VALUES (?, ?, 'linear', 'https://mcp.linear.app/sse', 1)`,
		)
		.bind(crypto.randomUUID(), acmeId)
		.run()

	const packages: Array<SavedPackageRecord & { boundKeyName: string }> = []
	for (let index = 0; index < packageCount; index += 1) {
		const packageId = crypto.randomUUID()
		const sourceId = `source-${packageId}`
		const boundKeyName = `pkg-${index}-key`
		await insertSavedPackage(
			db,
			{
				id: packageId,
				user_id: acmeId,
				name: `@acme/pkg-${index}`,
				kody_id: `pkg-${index}`,
				description: 'n1 fixture',
				tags_json: '[]',
				search_text: null,
				source_id: sourceId,
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
		await saveSecret({
			env,
			userId: acmeId,
			scope: 'package',
			name: boundKeyName,
			value: `package-secret-${index}`,
			storageContext: {
				sessionId: null,
				appId: packageId,
				packageId,
				storageId: packageId,
			},
			audit: null,
		})
		packages.push({
			id: packageId,
			userId: acmeId,
			name: `@acme/pkg-${index}`,
			kodyId: `pkg-${index}`,
			description: 'n1 fixture',
			tags: [],
			searchText: null,
			sourceId,
			hasApp: false,
			hasSkills: false,
			hidden: false,
			isPrivate: true,
			isInternetVisible: false,
			lockedAt: null,
			createdAt: now,
			updatedAt: now,
			boundKeyName,
		})
	}

	vi.spyOn(needsClosure, 'loadPublishedCredentialNeeds').mockImplementation(
		async (input) => {
			// Mirror the real closure: resolve the supplier flag when callers
			// omit a precomputed value (the KODY-BV N+1 path).
			const supplierSemanticsEnabled =
				input.supplierSemanticsEnabled ??
				(await isPackageCredentialSuppliersEnabled({
					db: input.env.APP_DB,
					orgId: input.userId,
					request: input.request,
				}))
			void supplierSemanticsEnabled
			return [
				{
					key: 'openai',
					kind: 'secret' as const,
					provider: 'openai',
					description: '',
					multiple: false,
				},
			]
		},
	)

	const request = deriveRequestContext({
		user: { userId: personId, username: 'bea' },
		source: { kind: 'mcp-oauth' },
		orgBinding: {
			org: { id: acmeId as OwnerId, slug: 'acme-bd' },
			role: 'owner',
		},
	}) as RequestContext

	return {
		queries,
		env,
		request,
		acmeId,
		orgKeyId: orgKey!.id,
		packages,
	}
}

test('listUsableCredentialsByPackage keeps mcp/user-scope loads constant across packages (KODY-BD)', async () => {
	const small = await setup(3)
	small.queries.length = 0
	await listUsableCredentialsByPackage({
		env: small.env,
		request: small.request,
		packageIds: small.packages.map((pkg) => pkg.id),
	})
	const smallCounts = {
		mcp: small.queries.filter(isMcpServerSettingsListLookup).length,
		userSecrets: small.queries.filter(isUserScopeSecretListLookup).length,
		packageSecrets: small.queries.filter(isPackageBoundSecretListLookup).length,
	}

	const large = await setup(8)
	large.queries.length = 0
	const largeByPackage = await listUsableCredentialsByPackage({
		env: large.env,
		request: large.request,
		packageIds: large.packages.map((pkg) => pkg.id),
	})
	const largeCounts = {
		mcp: large.queries.filter(isMcpServerSettingsListLookup).length,
		userSecrets: large.queries.filter(isUserScopeSecretListLookup).length,
		packageSecrets: large.queries.filter(isPackageBoundSecretListLookup).length,
	}

	expect(smallCounts.mcp).toBe(1)
	expect(largeCounts.mcp).toBe(1)
	expect(largeCounts.mcp).toBe(smallCounts.mcp)
	expect(largeCounts.userSecrets).toBe(smallCounts.userSecrets)
	expect(largeCounts.userSecrets).toBe(1)
	expect(largeCounts.packageSecrets).toBe(1)
	expect(largeCounts.packageSecrets).toBe(smallCounts.packageSecrets)

	// Each package sees shared org credentials (Key + MCP) plus only its own
	// bound Key — never another package's Keys.
	for (const pkg of large.packages) {
		const usable = largeByPackage.get(pkg.id) ?? []
		expect(usable.map((credential) => credential.name).sort()).toEqual(
			['OPENAI', 'linear', pkg.boundKeyName].sort(),
		)
		expect(
			usable
				.filter((credential) => credential.packageId != null)
				.map((credential) => credential.packageId),
		).toEqual([pkg.id])
	}

	// Matches per-package listUsableCredentials for ADR 0068 semantics.
	const firstPackage = large.packages[0]
	expect(firstPackage).toBeDefined()
	if (!firstPackage) throw new Error('expected at least one package')
	const solo = await listUsableCredentials({
		env: large.env,
		request: large.request,
		packageId: firstPackage.id,
	})
	expect(
		(largeByPackage.get(firstPackage.id) ?? []).map(
			({ id, name, packageId, expired }) => ({
				id,
				name,
				packageId,
				expired,
			}),
		),
	).toEqual(
		solo.map(({ id, name, packageId, expired }) => ({
			id,
			name,
			packageId,
			expired,
		})),
	)
})

test('loadCredentialDetail usage across packages does not scale mcp lookups with package count (KODY-BD)', async () => {
	const t = await setup(6)
	t.queries.length = 0
	const detail = await loadCredentialDetail({
		env: t.env,
		request: t.request,
		orgId: t.acmeId,
		ownedByViewer: true,
		credential: credentialItem({
			id: t.orgKeyId,
			name: 'OPENAI',
			provider: 'openai',
		}),
		packages: t.packages,
	})

	expect(detail.usage).toHaveLength(6)
	expect(detail.usage.every((row) => row.fit === 'auto')).toBe(true)
	expect(t.queries.filter(isMcpServerSettingsListLookup)).toHaveLength(1)
	expect(t.queries.filter(isPackageBoundSecretListLookup)).toHaveLength(1)
})

test('loadCredentialDetail usage issues at most one org-owner lookup (KODY-BV)', async () => {
	const small = await setup(3)
	small.queries.length = 0
	await loadCredentialDetail({
		env: small.env,
		request: small.request,
		orgId: small.acmeId,
		ownedByViewer: true,
		credential: credentialItem({
			id: small.orgKeyId,
			name: 'OPENAI',
			provider: 'openai',
		}),
		packages: small.packages,
	})
	const smallOwners = small.queries.filter(isOrgOwnerLookup).length

	const large = await setup(6)
	large.queries.length = 0
	const detail = await loadCredentialDetail({
		env: large.env,
		request: large.request,
		orgId: large.acmeId,
		ownedByViewer: true,
		credential: credentialItem({
			id: large.orgKeyId,
			name: 'OPENAI',
			provider: 'openai',
		}),
		packages: large.packages,
	})
	const largeOwners = large.queries.filter(isOrgOwnerLookup).length

	expect(detail.usage).toHaveLength(6)
	expect(smallOwners).toBe(1)
	expect(largeOwners).toBe(1)
	expect(largeOwners).toBe(smallOwners)
})

test('package-bound Key batch chunks under maxD1BoundParameters (KODY-BD)', async () => {
	// Seed enough package ids to force more than one secret IN-list without
	// burning entitlement quota on saveSecret. Fixture D1 enforces the
	// maxD1BoundParameters bind cap so a future unchunked IN-list fails hard.
	const t = await setup(2)
	const packageIds = Array.from(
		{ length: maxD1BoundParameters },
		(_, index) => `pkg-bind-${index}`,
	)
	for (const packageId of packageIds) {
		const bucketId = `bucket-${packageId}`
		await t.env.APP_DB.prepare(
			`INSERT INTO secret_buckets (id, user_id, scope, binding_key)
			 VALUES (?, ?, 'package', ?)`,
		)
			.bind(bucketId, t.acmeId, packageId)
			.run()
		await t.env.APP_DB.prepare(
			`INSERT INTO secret_entries (id, bucket_id, name, encrypted_value, kind)
			 VALUES (?, ?, ?, 'ct', 'secret')`,
		)
			.bind(`entry-${packageId}`, bucketId, `${packageId}-key`)
			.run()
	}
	t.queries.length = 0
	const byPackage = await listUsableCredentialsByPackage({
		env: t.env,
		request: t.request,
		packageIds,
	})

	expect(byPackage.size).toBe(packageIds.length)
	expect(t.queries.filter(isMcpServerSettingsListLookup)).toHaveLength(1)
	// ceil(100 / 99) package-key statements; mcp/user-scope stay flat.
	expect(
		t.queries.filter(isPackageBoundSecretListLookup).length,
	).toBeGreaterThan(1)
	expect(t.queries.filter(isPackageBoundSecretListLookup).length).toBeLessThan(
		packageIds.length,
	)
	const firstId = packageIds[0]
	expect(firstId).toBeDefined()
	if (!firstId) throw new Error('expected at least one package id')
	expect(
		(byPackage.get(firstId) ?? [])
			.filter((credential) => credential.packageId != null)
			.map((credential) => credential.packageId),
	).toEqual([firstId])
})
