/**
 * Placeholders and credential() share one resolution rule: org credentials
 * plus the actor's own personal credentials granted into the org.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personalOrgId,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { saveSecret } from '#mcp/secrets/service.ts'
import { grantPersonalCredentialToOrg } from './personal-credentials.ts'
import { resolveCredential } from './resolve-credential.ts'

const scheduledAudits = vi.hoisted(() => [] as Array<Promise<unknown>>)

vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof import('cloudflare:workers')>()),
	waitUntil: (promise: Promise<unknown>) => {
		scheduledAudits.push(promise)
	},
}))

const now = '2026-10-14T00:00:00.000Z'
const secretValue = 'personal-placeholder-secret'

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
	const people = Object.fromEntries(
		(['ann', 'bea'] as const).map((username) => {
			const stableUserId = testStableUserIdFromEmail(`${username}@example.com`)
			return [
				username,
				{ stableUserId, personId: personIdFromStored(stableUserId) },
			]
		}),
	) as Record<
		'ann' | 'bea',
		{ stableUserId: string; personId: ReturnType<typeof personIdFromStored> }
	>
	for (const [username, person] of Object.entries(people)) {
		await provisionPersonalOrg(db, {
			stableUserId: person.stableUserId,
			username,
			createdAt: now,
		})
	}
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: people.bea.personId,
			audit: createTestOrgAuditWriter(),
			slug: 'acme-secrets',
			displayName: 'Acme',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const acme = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'acme-secrets'`)
		.first<{ id: string }>()
	const acmeId = ownerIdFromStored(acme!.id)
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(acmeId, people.ann.stableUserId, now)
		.run()

	const annOrgId = personalOrgId(people.ann.personId)
	await saveSecret({
		env,
		userId: annOrgId,
		scope: 'user',
		name: 'MY_TOKEN',
		value: secretValue,
		audit: null,
	})
	const secretId = (await db
		.prepare(
			`SELECT id FROM secret_entries
				 WHERE name = 'MY_TOKEN' AND bucket_id IN (
					SELECT id FROM secret_buckets WHERE user_id = ? AND scope = 'user'
				 )`,
		)
		.bind(annOrgId)
		.first<{ id: string }>())!.id

	const requestAs = (person: 'ann' | 'bea', role: 'owner' | 'member') =>
		deriveRequestContext({
			user: { userId: people[person].personId, username: person },
			source: { kind: 'mcp-oauth' },
			orgBinding: { org: { id: acmeId, slug: 'acme-secrets' }, role },
		})

	const resolveSecret = (actor: ReturnType<typeof requestAs>) =>
		resolveCredential({
			env,
			orgId: acmeId,
			actor,
			baseUrl: 'https://example.com',
			credential: {
				use: 'secret',
				name: 'MY_TOKEN',
				storageContext: {
					sessionId: null,
					appId: null,
					packageId: null,
				},
			},
		})

	scheduledAudits.length = 0
	return { db, env, people, acmeId, secretId, requestAs, resolveSecret }
}

test('a secret placeholder resolves a personal credential granted into the org', async () => {
	const t = await setup()

	await expect(
		t.resolveSecret(t.requestAs('ann', 'member')),
	).rejects.toBeInstanceOf(AuthorizationError)

	await grantPersonalCredentialToOrg({
		db: t.db,
		ownerPersonId: t.people.ann.personId,
		credentialId: t.secretId,
		orgId: t.acmeId,
	})

	await expect(
		t.resolveSecret(t.requestAs('ann', 'member')),
	).resolves.toMatchObject({
		found: true,
		value: secretValue,
	})

	// Another person never sees Ann's personal secret, even with a live grant:
	// lookup misses in the org and in Bea's personal store.
	await expect(
		t.resolveSecret(t.requestAs('bea', 'owner')),
	).resolves.toMatchObject({ found: false, value: null })
})
