/**
 * Credential detail usage walks N packages in parallel. Each closure used to
 * evaluate package-credential-suppliers (and thus experiments_opt_in) once per
 * package when `request` was omitted (Sentry KODY-BW / issue 7813756991).
 */
import { DatabaseSync } from 'node:sqlite'
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
import { loadCredentialDetail } from './credential-detail.ts'

vi.mock(
	'#worker/test-support/apply-all-migrations.ts',
	async (importOriginal) =>
		(await import('./cached-migrations.test-support.ts')).withCachedMigrations(
			await importOriginal(),
		),
)

const publishedNeeds = new Map<string, unknown>()

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', () => ({
	readPublishedCredentialNeeds: async (input: {
		sourceId: string
		publishedCommit: string
	}) =>
		publishedNeeds.get(`${input.sourceId}:${input.publishedCommit}`) ?? null,
	writePublishedCredentialNeeds: async () => undefined,
	readPublishedSourceSnapshot: async () => null,
}))

const now = '2026-10-26T21:43:00.000Z'

function isExperimentsOptInLookup(query: string) {
	const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
	return (
		normalized.includes('select experiments_opt_in from users') &&
		normalized.includes('where id = ?')
	)
}

function isSupplierFlagOwnerLookup(query: string) {
	const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
	return (
		normalized.includes('from org_memberships') &&
		normalized.includes("m.role = 'owner'") &&
		normalized.includes('m.org_id = ?')
	)
}

function isPackageCredentialSuppliersFlagLookup(query: string) {
	const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
	return (
		(normalized.includes('from feature_flags') &&
			normalized.includes('where key = ?')) ||
		(normalized.includes('from feature_flag_user_overrides') &&
			normalized.includes('where flag_key = ?'))
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
	publishedNeeds.clear()
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
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, created_at, updated_at)
			 VALUES ('bea', 'bea@example.com', 'x', ?, ?, ?)`,
		)
		.bind(stableUserId, now, now)
		.run()
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId,
			audit: createTestOrgAuditWriter(),
			slug: 'acme-bw',
			displayName: 'Acme',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const acme = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'acme-bw'`)
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

	const packages: Array<SavedPackageRecord> = []
	for (let index = 0; index < packageCount; index += 1) {
		const packageId = crypto.randomUUID()
		const sourceId = `source-${packageId}`
		const publishedCommit = `commit-${index}`
		await insertSavedPackage(
			db,
			{
				id: packageId,
				user_id: acmeId,
				name: `@acme/pkg-${index}`,
				kody_id: `pkg-${index}`,
				description: 'flag n1 fixture',
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
		await db
			.prepare(
				`INSERT INTO entity_sources (
					id, user_id, entity_kind, entity_id, repo_id, published_commit,
					indexed_commit, manifest_path, source_root, created_at, updated_at
				) VALUES (?, ?, 'package', ?, ?, ?, NULL, 'package.json', '/', ?, ?)`,
			)
			.bind(
				sourceId,
				acmeId,
				packageId,
				`repo-${packageId}`,
				publishedCommit,
				now,
				now,
			)
			.run()
		publishedNeeds.set(`${sourceId}:${publishedCommit}`, [
			{
				key: 'openai',
				kind: 'secret',
				provider: 'openai',
				description: '',
				multiple: false,
			},
		])
		packages.push({
			id: packageId,
			userId: acmeId,
			name: `@acme/pkg-${index}`,
			kodyId: `pkg-${index}`,
			description: 'flag n1 fixture',
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
		})
	}

	const request = deriveRequestContext({
		user: { userId: personId, username: 'bea' },
		source: { kind: 'mcp-oauth' },
		orgBinding: {
			org: { id: acmeId as OwnerId, slug: 'acme-bw' },
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

test('loadCredentialDetail evaluates suppliers flag once across packages (KODY-BW)', async () => {
	const t = await setup(5)
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

	expect(detail.usage).toHaveLength(5)
	expect(detail.usage.every((row) => row.fit === 'auto')).toBe(true)
	expect(t.queries.filter(isSupplierFlagOwnerLookup)).toHaveLength(1)
	expect(t.queries.filter(isExperimentsOptInLookup)).toHaveLength(1)
	// Override + global row for the one flag evaluation (not once per package).
	expect(t.queries.filter(isPackageCredentialSuppliersFlagLookup)).toHaveLength(
		2,
	)
})
