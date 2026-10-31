/**
 * KODY-CS: one execution's gateway fetches read each feature flag (and the
 * org-owner lookup behind it) from D1 once; the next execution reads again.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { credentialNeedEnforcementFlagKey } from '#universal/feature-flags/registry.ts'
import * as needsClosure from '#worker/credentials/credential-needs-closure.ts'
import { isPackageCredentialSuppliersEnabled } from '#worker/credentials/credential-suppliers-flag.ts'
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
import { saveSecret } from './secrets/service.ts'
import { executeGatewayFetch } from './fetch-gateway.ts'

vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof import('cloudflare:workers')>()),
	waitUntil: () => {},
}))

const now = '2026-10-29T00:00:00.000Z'

async function setup() {
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
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, created_at, updated_at)
			 VALUES ('bea', 'bea@example.com', 'hash', ?, ?, ?)`,
		)
		.run(stableUserId, now, now)
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
			slug: 'acme-tools',
			displayName: 'Acme',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const acme = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'acme-tools'`)
		.first<{ id: string }>()
	const orgId = ownerIdFromStored(acme!.id)
	await saveSecret({
		env,
		userId: orgId,
		scope: 'user',
		name: 'GITHUB_TOKEN',
		value: 'github-token-value',
		audit: null,
	})
	await db
		.prepare(
			`UPDATE secret_entries SET kind = 'secret', provider = 'github', allowed_hosts = ?
			WHERE name = 'GITHUB_TOKEN'`,
		)
		.bind(JSON.stringify(['api.github.com']))
		.run()
	const packageId = crypto.randomUUID()
	await insertSavedPackage(
		db,
		{
			id: packageId,
			user_id: orgId,
			name: '@acme/github',
			kody_id: 'github',
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
	await db
		.prepare(
			`INSERT INTO feature_flags (key, enabled, rollout_percent, audience, note, updated_at)
			 VALUES (?, 1, NULL, 'everyone', '', CURRENT_TIMESTAMP)`,
		)
		.bind(credentialNeedEnforcementFlagKey)
		.run()
	// Declares the token; the supplier flag read is the real one.
	vi.spyOn(needsClosure, 'loadPublishedCredentialNeeds').mockImplementation(
		async (input) => {
			await isPackageCredentialSuppliersEnabled({
				db: input.env.APP_DB,
				orgId: input.userId,
				request: input.request,
			})
			return [
				{
					key: 'GITHUB_TOKEN',
					provider: 'github',
					description: 'GitHub token.',
					multiple: false,
				},
			]
		},
	)
	const fetchInExecution = async (executionId: string) => {
		const response = await executeGatewayFetch({
			env,
			props: {
				baseUrl: 'https://example.com',
				userId: orgId,
				email: null,
				// Gateway props are deserialized per call, so each fetch gets a
				// fresh request context.
				request: deriveRequestContext({
					user: { userId: personId, username: 'bea' },
					source: { kind: 'mcp-oauth' },
					orgBinding: { org: { id: orgId, slug: 'acme-tools' }, role: 'owner' },
				}),
				storageContext: {
					sessionId: null,
					appId: packageId,
					packageId,
					storageId: packageId,
				},
				grantedSecretAuthorityPackageIds: [packageId],
				executionId,
			},
			request: new Request('https://api.github.com/repos/o/r/compare/a...b', {
				headers: { Authorization: 'Bearer {{secret:GITHUB_TOKEN}}' },
			}),
			globalFetch: (async (request: Request) =>
				new Response(request.headers.get('Authorization'))) as typeof fetch,
		})
		expect(await response.text()).toBe('Bearer [REDACTED SECRET]')
	}
	const takeFlagReads = () => {
		const reads = queries.filter((query) =>
			/FROM feature_flag|FROM org_memberships m INNER JOIN users u/.test(query),
		)
		queries.length = 0
		return reads
	}
	return { fetchInExecution, takeFlagReads }
}

test('fetches in one execution read each flag and org owner once; a new execution rereads execution-scoped flags', async () => {
	const t = await setup()
	t.takeFlagReads()

	await t.fetchInExecution('execution-1')
	const firstFetch = t.takeFlagReads()
	expect(firstFetch.map((query) => query.match(/FROM (\w+)/)?.[1])).toEqual([
		'feature_flags',
		'org_memberships',
		'feature_flag_user_overrides',
		'feature_flag_org_overrides',
		'feature_flags',
	])
	await t.fetchInExecution('execution-1')
	await t.fetchInExecution('execution-1')
	expect(t.takeFlagReads()).toEqual([])

	// The supplier flag is reused across executions for its 15 s org TTL, so
	// only the execution-scoped global flag read repeats.
	await t.fetchInExecution('execution-2')
	expect(t.takeFlagReads()).toEqual(firstFetch.slice(0, 1))
})
