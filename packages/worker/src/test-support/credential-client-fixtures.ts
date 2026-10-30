import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { vi } from 'vitest'
import { saveSecret } from '#mcp/secrets/service.ts'
import { upsertGrant } from '#worker/orgs/access-writes.ts'
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
	normalizeCredentialCallMap,
	type CredentialCallMapInput,
} from '#worker/credentials/credential-call-map.ts'
import {
	applyCredentialClient,
	loadRunCredentialNeeds,
	type CredentialClientContext,
} from '#worker/credentials/credential-client.ts'
import * as needsClosure from '#worker/credentials/credential-needs-closure.ts'
import { type CredentialNeed } from '#worker/credentials/credential-needs.ts'
import { insertPackageCapabilityApproval } from '#worker/package-capabilities/capability-approvals-repo.ts'

export const now = '2026-10-12T00:00:00.000Z'
export const resendKey = 're_live_secret_value_123'

/** Shared fixtures; `scheduledAudits` is the caller's hoisted waitUntil sink. */
export function createCredentialClientFixtures(
	scheduledAudits: Array<Promise<unknown>>,
) {
	async function setup() {
		const sqlite = new DatabaseSync(':memory:')
		applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
		const db = createD1FromSqlite(sqlite)
		const auditDb = createAuditTestDb()
		const env = {
			APP_DB: db,
			AUDIT_DB: auditDb,
			...createInMemoryUserMeterEnv().env,
			COOKIE_SECRET: 'test-cookie-secret',
			SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		} as unknown as Env
		const people = Object.fromEntries(
			(['ann', 'bea'] as const).map((username) => {
				const stableUserId = testStableUserIdFromEmail(
					`${username}@example.com`,
				)
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
		// Bea owns Acme; Ann is a member.
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
		const storeKey = async (input: {
			ownerId?: OwnerId
			name: string
			value?: string
			provider?: string | null
			hosts?: Array<string>
			inject?: unknown
			placement?: unknown
		}) => {
			const ownerId = input.ownerId ?? acmeId
			await saveSecret({
				env,
				userId: ownerId,
				scope: 'user',
				name: input.name,
				value: input.value ?? resendKey,
				audit: null,
			})
			const row = await db
				.prepare(
					`UPDATE secret_entries
				SET kind = 'secret', provider = ?, allowed_hosts = ?, inject_json = ?
				WHERE name = ? AND bucket_id IN (
					SELECT id FROM secret_buckets WHERE user_id = ? AND scope = 'user'
				)
				RETURNING id`,
				)
				.bind(
					input.provider === undefined ? 'resend' : input.provider,
					JSON.stringify(input.hosts ?? ['api.resend.com']),
					JSON.stringify(
						input.inject ?? {
							kind: 'header',
							name: 'Authorization',
							format: 'Bearer {value}',
						},
					),
					input.name,
					ownerId,
				)
				.first<{ id: string }>()
			if (input.placement !== undefined) {
				await db
					.prepare(`UPDATE secret_entries SET placement_json = ? WHERE id = ?`)
					.bind(JSON.stringify(input.placement), row!.id)
					.run()
			}
			return row!.id
		}
		const savePackage = async (input: { ownerId: OwnerId; name: string }) => {
			const packageId = crypto.randomUUID()
			await insertSavedPackage(
				db,
				{
					id: packageId,
					user_id: input.ownerId,
					name: input.name,
					kody_id: input.name.split('/')[1]!,
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
			return packageId
		}
		const requestAs = (
			person: keyof typeof people,
			role: OrgRole | null,
			orgId: OwnerId = acmeId,
		) =>
			deriveRequestContext({
				user: { userId: people[person].personId, username: person },
				source: { kind: 'mcp-oauth' },
				orgBinding: { org: { id: orgId, slug: 'acme-clients' }, role },
			})
		const contextFor = (input: {
			request: ReturnType<typeof requestAs>
			packageId?: string | null
			binding?: string
			credentials?: CredentialCallMapInput
		}): CredentialClientContext => ({
			env,
			callerContext: {
				baseUrl: 'https://example.com',
				request: input.request,
				user: null,
			} as unknown as McpCallerContext,
			binding: input.binding ?? 'run:test',
			packageId: input.packageId ?? null,
			callMap: normalizeCredentialCallMap(input.credentials),
		})
		const grantUse = (credentialId: string, person: keyof typeof people) =>
			upsertGrant({
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
		const audits = async () => {
			await Promise.all(scheduledAudits.splice(0))
			const { results } = await auditDb
				.prepare(
					`SELECT result, details_json FROM org_audit_events
				 WHERE action = 'credential.resolve' ORDER BY rowid`,
				)
				.all<{ result: string; details_json: string }>()
			return results
		}
		scheduledAudits.length = 0
		return {
			db,
			auditDb,
			env,
			people,
			acmeId,
			storeKey,
			savePackage,
			requestAs,
			contextFor,
			grantUse,
			audits,
		}
	}

	async function setupVisitorApp(input?: {
		internetVisible?: boolean
		approvedCommit?: string
		approvedBy?: string
		approvedCredentialIds?: (ids: { database: string }) => Array<string>
	}) {
		const t = await setup()
		let userRowId = 1
		for (const [username, person] of Object.entries(t.people)) {
			await t.db
				.prepare(
					`INSERT INTO users (id, username, email, password_hash, stable_user_id)
				 VALUES (?, ?, ?, 'x', ?)`,
				)
				.bind(
					userRowId++,
					username,
					`${username}@example.com`,
					person.stableUserId,
				)
				.run()
		}
		const databaseId = await t.storeKey({
			name: 'rooms-db',
			provider: 'database',
			hosts: ['db.example.com'],
		})
		await t.storeKey({ name: 'resend-prod' })
		const packageId = await t.savePackage({
			ownerId: t.acmeId,
			name: '@acme-clients/rooms',
		})
		await t.db
			.prepare(
				`UPDATE saved_packages SET has_app = 1, is_internet_visible = ? WHERE id = ?`,
			)
			.bind(input?.internetVisible === false ? 0 : 1, packageId)
			.run()
		mockNeeds([
			{
				key: 'database',
				provider: 'database',
				ownerCredentialForVisitors: true,
			},
			{ key: 'resend' },
		])
		const approvedIds = input?.approvedCredentialIds?.({
			database: databaseId,
		}) ?? [databaseId]
		await insertPackageCapabilityApproval(t.db, {
			id: crypto.randomUUID(),
			package_id: packageId,
			owner_user_id: t.acmeId,
			published_commit: input?.approvedCommit ?? 'commit-1',
			fingerprint: 'fingerprint-1',
			capability_set_json: JSON.stringify(
				approvedIds.map((credentialId) => ({
					kind: 'credential',
					credentialId,
					source: 'need',
					needKey: 'database',
					ownerCredentialForVisitors: true,
					hosts: ['db.example.com'],
					via: ['rooms'],
				})),
			),
			dependency_snapshot_json: '{}',
			approved_by_user_id: input?.approvedBy ?? t.people.bea.stableUserId,
			approved_at: now,
		})
		const scope = { orgId: t.acmeId, packageId, publishedCommit: 'commit-1' }
		const runNeeds = loadRunCredentialNeeds({
			env: t.env,
			orgId: t.acmeId,
			packageIds: [packageId],
		})
		const appContext = (
			request: ReturnType<typeof t.requestAs> | null,
		): CredentialClientContext => ({
			env: t.env,
			callerContext: {
				baseUrl: 'https://example.com',
				request,
				user: null,
			} as unknown as McpCallerContext,
			binding: 'run:app',
			packageId,
			runNeeds: () => runNeeds,
			ownerCredentialScope: scope,
		})
		const fetchAs = (
			request: ReturnType<typeof t.requestAs> | null,
			token: string,
			ownerCredentialScope: typeof scope | null = scope,
		) =>
			applyCredentialClient({
				env: t.env,
				request,
				baseUrl: 'https://example.com',
				packageId,
				binding: 'run:app',
				ownerCredentialScope,
				token,
				requestUrl: new URL('https://db.example.com/v1/rooms'),
			})
		const auditRows = async () => {
			await Promise.all(scheduledAudits.splice(0))
			const { results } = await t.auditDb
				.prepare(
					`SELECT result, actor_user_id, details_json FROM org_audit_events
				 WHERE action = 'credential.resolve' ORDER BY rowid`,
				)
				.all<{
					result: string
					actor_user_id: string | null
					details_json: string
				}>()
			return results.map((row) => ({
				result: row.result,
				actorUserId: row.actor_user_id,
				details: JSON.parse(row.details_json) as Record<string, unknown>,
			}))
		}
		return {
			...t,
			databaseId,
			packageId,
			scope,
			appContext,
			fetchAs,
			auditRows,
		}
	}

	return { setup, setupVisitorApp }
}

export function mockNeeds(
	needs: Array<Partial<CredentialNeed> & { key: string }>,
) {
	return vi
		.spyOn(needsClosure, 'loadPublishedCredentialNeeds')
		.mockResolvedValue(
			needs.map((need) => ({
				kind: 'secret',
				provider: need.key,
				description: '',
				multiple: false,
				...need,
			})),
		)
}

export async function rejection(promise: Promise<unknown>) {
	return await promise.then(
		() => {
			throw new Error('Expected a rejection.')
		},
		(error: unknown) => error as Error & { body?: unknown },
	)
}
