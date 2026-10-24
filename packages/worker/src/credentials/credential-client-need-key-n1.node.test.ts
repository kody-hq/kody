/**
 * Opening credential() for several package need keys must not re-query
 * credential_mappings, users.personal_org_id, or mcp_server_settings once per
 * need (Sentry KODY-AZ / issue 7809422290).
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { expect, test, vi } from 'vitest'
import { saveSecret } from '#mcp/secrets/service.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import {
	openCredentialClient,
	type CredentialClientContext,
} from './credential-client.ts'
import { buildWriteCredentialMappingStatement } from './credential-mappings.ts'
import * as needsClosure from './credential-needs-closure.ts'

vi.mock(
	'#worker/test-support/apply-all-migrations.ts',
	async (importOriginal) =>
		(await import('./cached-migrations.test-support.ts')).withCachedMigrations(
			await importOriginal(),
		),
)

const now = '2026-10-23T20:07:00.000Z'

function isCredentialMappingLookup(query: string) {
	const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
	return (
		normalized.includes('from credential_mappings') &&
		normalized.startsWith('select ')
	)
}

function isPersonalOrgUserLookup(query: string) {
	const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
	return (
		normalized.includes('from users') &&
		normalized.includes('personal_org_id') &&
		normalized.includes('stable_user_id = ?')
	)
}

/** Org-wide usable-credential list (not the personal id-filtered follow-up). */
function isMcpServerSettingsListLookup(query: string) {
	const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
	return (
		normalized.includes('from mcp_server_settings') &&
		normalized.includes('user_id = ?') &&
		normalized.includes('enabled = 1') &&
		!normalized.includes(' id in (')
	)
}

async function setup(needKeys: ReadonlyArray<string>) {
	const queries: Array<string> = []
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite, { queries })
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
			slug: 'acme-n1',
			displayName: 'Acme',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const acme = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'acme-n1'`)
		.first<{ id: string }>()
	const acmeId = ownerIdFromStored(acme!.id)
	const packageId = crypto.randomUUID()
	await insertSavedPackage(
		db,
		{
			id: packageId,
			user_id: acmeId,
			name: '@acme/n1-creds',
			kody_id: 'n1-creds',
			description: 'n1 fixture',
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
	for (const key of needKeys) {
		await saveSecret({
			env,
			userId: acmeId,
			scope: 'user',
			name: `${key}-prod`,
			value: `secret-value-for-${key}`,
			audit: null,
		})
		const row = await db
			.prepare(
				`UPDATE secret_entries
				SET kind = 'secret', provider = ?, allowed_hosts = ?
				WHERE name = ? AND bucket_id IN (
					SELECT id FROM secret_buckets WHERE user_id = ? AND scope = 'user'
				)
				RETURNING id`,
			)
			.bind(key, JSON.stringify(['api.example.com']), `${key}-prod`, acmeId)
			.first<{ id: string }>()
		await buildWriteCredentialMappingStatement({
			db,
			orgId: acmeId,
			packageId,
			needKey: key,
			target: { target: 'org' },
			credentialIds: [row!.id],
			updatedByUserId: stableUserId,
			now,
		}).run()
	}
	await db
		.prepare(
			`INSERT INTO mcp_server_settings (id, user_id, name, url, enabled)
			 VALUES (?, ?, 'linear', 'https://mcp.linear.app/sse', 1)`,
		)
		.bind(crypto.randomUUID(), acmeId)
		.run()
	// A personal grant forces listUsableCredentials (and author-exemption
	// checks) through loadPersonalOrgIdForPerson — the users span Sentry saw
	// repeating per need. Equal-id fixtures key personal storage at the
	// person id; insert the grant without calling the memoized loader so
	// the assertion window still observes the first read.
	const personalOrgId = ownerIdFromStored(stableUserId)
	await saveSecret({
		env,
		userId: personalOrgId,
		scope: 'user',
		name: 'personal-key',
		value: 'personal-secret-value',
		audit: null,
	})
	const personalRow = await db
		.prepare(
			`SELECT e.id AS id FROM secret_entries e
			 JOIN secret_buckets b ON b.id = e.bucket_id
			 WHERE b.user_id = ? AND e.name = 'personal-key'`,
		)
		.bind(personalOrgId)
		.first<{ id: string }>()
	await db
		.prepare(
			`INSERT INTO credential_org_grants (credential_id, user_id, org_id, created_at)
			 VALUES (?, ?, ?, ?)`,
		)
		.bind(personalRow!.id, personId, acmeId, now)
		.run()
	// Seed a users row so the loader issues the real personal_org_id SELECT
	// (fixtures without a row still resolve via equal-id fallback after one
	// miss, but production always has the row Sentry traced).
	await db
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id, personal_org_id)
			 VALUES (1, 'bea', 'bea@example.com', 'x', ?, ?)`,
		)
		.bind(stableUserId, personalOrgId)
		.run()
	vi.spyOn(needsClosure, 'loadPublishedCredentialNeeds').mockResolvedValue(
		needKeys.map((key) => ({
			key,
			kind: 'secret' as const,
			provider: key,
			description: '',
			multiple: false,
		})),
	)
	const request = deriveRequestContext({
		user: { userId: personId, username: 'bea' },
		source: { kind: 'mcp-oauth' },
		orgBinding: {
			org: { id: acmeId as OwnerId, slug: 'acme-n1' },
			role: 'owner',
		},
	})
	const context: CredentialClientContext = {
		env,
		callerContext: {
			baseUrl: 'https://example.com',
			request,
			user: null,
		} as unknown as McpCallerContext,
		binding: 'run:n1',
		packageId,
	}
	return { queries, context, needKeys }
}

test('concurrent openCredentialClient for N need keys does not scale mapping/user/mcp queries with N (KODY-AZ)', async () => {
	const needKeys = ['mail', 'chat', 'docs'] as const
	const t = await setup(needKeys)
	t.queries.length = 0

	const opened = await Promise.all(
		needKeys.map((key) => openCredentialClient(t.context, { key })),
	)

	expect(opened.map((client) => client.key)).toEqual([...needKeys])
	expect(opened.map((client) => client.name)).toEqual([
		'mail-prod',
		'chat-prod',
		'docs-prod',
	])

	const mappingLookups = t.queries.filter(isCredentialMappingLookup)
	const personalOrgLookups = t.queries.filter(isPersonalOrgUserLookup)
	const mcpLookups = t.queries.filter(isMcpServerSettingsListLookup)

	expect(mappingLookups.length).toBeLessThan(needKeys.length)
	expect(mappingLookups).toHaveLength(1)
	// Usable-list + author-exemption may each read once; must not scale with N.
	expect(personalOrgLookups.length).toBeLessThan(needKeys.length)
	expect(personalOrgLookups.length).toBeLessThanOrEqual(2)
	expect(mcpLookups.length).toBeLessThan(needKeys.length)
	expect(mcpLookups).toHaveLength(1)
})

test('openCredentialClient query counts stay flat when need key count grows (KODY-AZ)', async () => {
	const small = await setup(['a', 'b'])
	small.queries.length = 0
	await Promise.all(
		small.needKeys.map((key) => openCredentialClient(small.context, { key })),
	)
	const smallCounts = {
		mapping: small.queries.filter(isCredentialMappingLookup).length,
		mcp: small.queries.filter(isMcpServerSettingsListLookup).length,
		personalOrg: small.queries.filter(isPersonalOrgUserLookup).length,
	}

	const large = await setup(['a', 'b', 'c', 'd', 'e', 'f'])
	large.queries.length = 0
	await Promise.all(
		large.needKeys.map((key) => openCredentialClient(large.context, { key })),
	)
	const largeCounts = {
		mapping: large.queries.filter(isCredentialMappingLookup).length,
		mcp: large.queries.filter(isMcpServerSettingsListLookup).length,
		personalOrg: large.queries.filter(isPersonalOrgUserLookup).length,
	}

	expect(largeCounts.mapping).toBe(smallCounts.mapping)
	expect(largeCounts.mcp).toBe(smallCounts.mcp)
	expect(largeCounts.personalOrg).toBe(smallCounts.personalOrg)
	expect(largeCounts.mapping).toBe(1)
	expect(largeCounts.mcp).toBe(1)
	expect(largeCounts.personalOrg).toBeLessThanOrEqual(2)
})
