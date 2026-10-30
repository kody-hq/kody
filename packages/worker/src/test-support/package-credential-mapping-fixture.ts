import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { vi, type Mock } from 'vitest'
import { saveSecret } from '#mcp/secrets/service.ts'
import * as needsClosure from '#worker/credentials/credential-needs-closure.ts'
import { type CredentialNeed } from '#worker/credentials/credential-needs.ts'
import {
	credentialMappingUpdateAuditAction,
	resolveMappingChanges,
	writeMappingChanges,
} from '#worker/credentials/package-credential-mapping-changes.ts'
import { loadPackageMappingScope } from '#worker/credentials/package-credential-mappings.ts'
import { upsertGrant } from '#worker/orgs/access-writes.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import {
	getSavedPackageById,
	insertSavedPackage,
} from '#worker/package-registry/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { applyAllMigrations } from './apply-all-migrations.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from './create-audit-db.ts'
import { createD1FromSqlite } from './create-d1-from-sqlite.ts'
import { createMemoryKvNamespace } from './memory-kv.ts'
import { testStableUserIdFromEmail } from './stable-user-id.ts'
import { createInMemoryUserMeterEnv } from './user-meter.ts'
import { type CredentialMappingChange } from '#universal/credential-contracts.ts'

export const mappingFixtureNow = '2026-10-13T00:00:00.000Z'
export const mappingFixtureBaseUrl = 'https://kody.test'

export const mappingFixtureNeeds: Array<CredentialNeed> = [
	{
		key: 'mail',
		kind: 'secret',
		provider: 'resend',
		description: 'Send the digest',
		multiple: false,
	},
	{
		key: 'chat',
		kind: 'secret',
		provider: 'slack',
		description: 'Post the digest',
		multiple: false,
	},
]

export const orgDefaultTarget = { type: 'default', layer: 'org' } as const
export const mineTarget = { type: 'default', layer: 'mine' } as const
export const dailyTarget = {
	type: 'trigger',
	trigger: { kind: 'cron', name: 'daily' },
} as const

export type MappingFixturePerson = 'ann' | 'bea' | 'cy'

/**
 * Org `acme-clients` (bea owner, ann member, cy outside) with private package
 * `digest` declaring the `mail` and `chat` needs, a `daily` cron job, a
 * subscription, and an unminted `incoming` webhook. The caller's test file
 * must `vi.mock('#worker/package-registry/source.ts')` and pass that mock's
 * `loadPackageManifestBySourceId`.
 */
export async function setupPackageCredentialMappingFixture(input: {
	loadPackageManifestBySourceId: Mock
}) {
	const now = mappingFixtureNow
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	// Turning a cron enablement on reads its job row (jobs-worker schema).
	applyAllMigrations(
		sqlite,
		new URL('../../../jobs-worker/migrations/', import.meta.url),
	)
	const db = createD1FromSqlite(sqlite)
	const env = {
		APP_DB: db,
		AUDIT_DB: createAuditTestDb(),
		BUNDLE_ARTIFACTS_KV: createMemoryKvNamespace().kv,
		...createInMemoryUserMeterEnv().env,
		COOKIE_SECRET: 'test-cookie-secret',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	const people = Object.fromEntries(
		(['ann', 'bea', 'cy'] as const).map((username) => {
			const stableUserId = testStableUserIdFromEmail(`${username}@example.com`)
			return [
				username,
				{ stableUserId, personId: personIdFromStored(stableUserId) },
			]
		}),
	) as Record<
		MappingFixturePerson,
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
			slug: 'acme-clients',
			displayName: 'Acme',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const acme = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'acme-clients'`)
		.first<{ id: string }>()
	const acmeId = ownerIdFromStored(acme!.id)
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(acmeId, people.ann.stableUserId, now)
		.run()
	const bumpAccessEpoch = async () => {
		await db
			.prepare(`UPDATE orgs SET access_epoch = access_epoch + 1 WHERE id = ?`)
			.bind(acmeId)
			.run()
	}
	const storeKey = async (
		name: string,
		provider: string | null,
		options: { expiresAt?: string } = {},
	) => {
		await saveSecret({
			env,
			userId: acmeId,
			scope: 'user',
			name,
			value: 'v',
			...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
			audit: null,
		})
		const row = await db
			.prepare(
				`UPDATE secret_entries SET provider = ?, allowed_hosts = '["api.example.com"]'
				WHERE name = ? AND bucket_id IN (
					SELECT id FROM secret_buckets WHERE user_id = ? AND scope = 'user'
				) RETURNING id`,
			)
			.bind(provider, name, acmeId)
			.first<{ id: string }>()
		return row!.id
	}
	const grantUse = async (
		credentialId: string,
		person: MappingFixturePerson,
	) => {
		await upsertGrant({
			db,
			orgId: acmeId,
			resourceType: 'credential',
			resourceId: credentialId,
			family: 'secret',
			subject: { type: 'user', id: people[person].stableUserId },
			preset: 'use',
			permissions: null,
			createdByUserId: people.bea.stableUserId,
			audit: createTestOrgAuditWriter(),
		})
		await bumpAccessEpoch()
	}
	const packageId = crypto.randomUUID()
	await insertSavedPackage(
		db,
		{
			id: packageId,
			user_id: acmeId,
			name: '@acme/digest',
			kody_id: 'digest',
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
	const savedPackage = (await getSavedPackageById(db, {
		userId: acmeId,
		packageId,
	}))!
	const grantPackageUse = async (person: MappingFixturePerson) => {
		await upsertGrant({
			db,
			orgId: acmeId,
			resourceType: 'package',
			resourceId: packageId,
			family: 'package',
			subject: { type: 'user', id: people[person].stableUserId },
			preset: 'use',
			permissions: null,
			createdByUserId: people.bea.stableUserId,
			audit: createTestOrgAuditWriter(),
		})
		await bumpAccessEpoch()
	}
	input.loadPackageManifestBySourceId.mockResolvedValue({
		manifest: {
			name: '@acme/digest',
			kody: {
				id: 'digest',
				description: 'digest',
				jobs: {
					daily: {
						entry: './src/job.ts',
						schedule: { type: 'interval', every: '1d' },
					},
				},
				subscriptions: { 'acme.thing.happened': { handler: './src/h.ts' } },
				webhooks: [
					{ name: 'incoming', export: './webhook', responseMode: 'ack' },
				],
			},
		},
	})
	vi.spyOn(needsClosure, 'loadPublishedCredentialNeeds').mockResolvedValue(
		mappingFixtureNeeds,
	)
	const requestAs = (person: MappingFixturePerson, role: OrgRole | null) =>
		deriveRequestContext({
			user: { userId: people[person].personId, username: person },
			source: { kind: 'session' },
			orgBinding: { org: { id: acmeId, slug: 'acme-clients' }, role },
		})
	const scopeFor = (person: MappingFixturePerson, role: OrgRole) =>
		loadPackageMappingScope({
			env,
			baseUrl: mappingFixtureBaseUrl,
			request: requestAs(person, role),
			savedPackage,
			canManage: role === 'owner',
		})
	const apply = async (
		person: MappingFixturePerson,
		role: OrgRole,
		changes: Array<CredentialMappingChange>,
	) => {
		const scope = await scopeFor(person, role)
		const resolved = await resolveMappingChanges(scope, changes)
		if (!resolved.some((change) => change.error)) {
			await writeMappingChanges(scope, resolved, { now })
		}
		return resolved
	}
	const enablementCount = async () =>
		(await db
			.prepare(`SELECT COUNT(*) AS n FROM enablements WHERE package_id = ?`)
			.bind(packageId)
			.first<{ n: number }>())!.n
	const mappingAudits = async () => {
		const rows = await env.AUDIT_DB.prepare(
			`SELECT actor_user_id, actor_username, credential_kind, credential_id,
				resource_type, resource_id, details_json
			 FROM org_audit_events
			 WHERE action = ? AND org_id = ?
			 ORDER BY rowid`,
		)
			.bind(credentialMappingUpdateAuditAction, acmeId)
			.all<{
				actor_user_id: string | null
				actor_username: string | null
				credential_kind: string | null
				credential_id: string | null
				resource_type: string | null
				resource_id: string | null
				details_json: string | null
			}>()
		return (rows.results ?? []).map((row) => ({
			actorUserId: row.actor_user_id,
			actorUsername: row.actor_username,
			credentialKind: row.credential_kind,
			credentialId: row.credential_id,
			resourceType: row.resource_type,
			resourceId: row.resource_id,
			details: row.details_json ? JSON.parse(row.details_json) : null,
		}))
	}
	return {
		db,
		env,
		people,
		acmeId,
		savedPackage,
		storeKey,
		grantUse,
		grantPackageUse,
		requestAs,
		scopeFor,
		apply,
		enablementCount,
		mappingAudits,
	}
}
