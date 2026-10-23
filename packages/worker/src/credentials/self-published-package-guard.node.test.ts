import { DatabaseSync } from 'node:sqlite'
import type * as CloudflareWorkers from 'cloudflare:workers'
import {
	personalOrgId,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { afterEach, expect, test, vi } from 'vitest'
import { expandSecretPlaceholders } from '#mcp/fetch-gateway.ts'
import { saveSecret } from '#mcp/secrets/service.ts'
import { resolveCredential } from '#worker/credentials/resolve-credential.ts'
import * as featureFlags from '#worker/feature-flags/service.ts'
import { resolvePackageApprovalRequest } from '#worker/package-capabilities/approval-requests-repo.ts'
import {
	enqueueWentPublicApproval,
	getPendingWentPublicApproval,
	isSelfPublishRequest,
	setSelfPublishMark,
} from '#worker/package-capabilities/went-public-approval.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import {
	getSavedPackageById,
	insertSavedPackage,
} from '#worker/package-registry/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'

vi.mock(
	'#worker/test-support/apply-all-migrations.ts',
	async (importOriginal) =>
		(await import('./cached-migrations.test-support.ts')).withCachedMigrations(
			await importOriginal(),
		),
)

vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof CloudflareWorkers>()),
	waitUntil: () => {},
}))

const now = '2026-10-15T00:00:00.000Z'
const keyValue = 're_live_secret_value_123'

afterEach(() => {
	vi.restoreAllMocks()
})

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
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
	const orgId: OwnerId = personalOrgId(personId)
	await saveSecret({
		env,
		userId: orgId,
		scope: 'user',
		name: 'RESEND',
		value: keyValue,
	})
	await db
		.prepare(
			`UPDATE secret_entries SET allowed_hosts = ?
			WHERE name = 'RESEND' AND bucket_id IN (
				SELECT id FROM secret_buckets WHERE user_id = ? AND scope = 'user'
			)`,
		)
		.bind(JSON.stringify(['api.resend.com']), orgId)
		.run()
	const packageId = crypto.randomUUID()
	await insertSavedPackage(
		db,
		{
			id: packageId,
			user_id: orgId,
			name: '@bea/landing',
			kody_id: 'landing',
			description: 'test package',
			tags_json: '[]',
			search_text: null,
			source_id: `source-${packageId}`,
			has_app: 1,
			has_skills: 0,
			hidden: 0,
			is_private: 1,
			is_internet_visible: 1,
			created_at: now,
			updated_at: now,
		},
		null,
		{ stamp: false },
	)
	const savedPackage = (await getSavedPackageById(db, {
		userId: orgId,
		packageId,
	}))!
	let approvals = 0
	const approveWentPublic = async (selfPublish: boolean) => {
		approvals += 1
		const at = `2026-10-15T00:00:0${approvals}.000Z`
		const request = await enqueueWentPublicApproval({
			env,
			ownerUserId: orgId,
			savedPackage,
			publishedCommit: `commit-${crypto.randomUUID()}`,
			fingerprint: 'fp',
			requestedByUserId: stableUserId,
			selfPublish,
		})
		await resolvePackageApprovalRequest(db, {
			id: request.id,
			status: 'approved',
			resolvedByUserId: stableUserId,
			now: at,
		})
	}
	const request = deriveRequestContext({
		user: { userId: personId, username: 'bea' },
		source: { kind: 'mcp-oauth' },
		orgBinding: { org: { id: orgId, slug: 'bea' }, role: 'owner' },
	})
	const resolveUnstamped = () =>
		resolveCredential({
			env,
			orgId,
			actor: request,
			packageStamp: null,
			runPackageId: packageId,
			baseUrl: 'https://example.com',
			credential: {
				use: 'secret',
				name: 'RESEND',
				storageContext: { sessionId: null, appId: null, packageId: null },
			},
		})
	const fill = () =>
		expandSecretPlaceholders({
			request: new Request('https://api.resend.com/emails', {
				headers: { Authorization: 'Bearer {{secret:RESEND}}' },
			}),
			props: {
				baseUrl: 'https://example.com',
				userId: orgId,
				email: null,
				request,
				storageContext: {
					sessionId: null,
					appId: packageId,
					packageId,
					storageId: packageId,
				},
				grantedSecretAuthorityPackageIds: [packageId],
			},
			env,
		}).then((expanded) => expanded.request.headers.get('Authorization'))
	const enqueueOwnerRequest = () =>
		enqueueWentPublicApproval({
			env,
			ownerUserId: orgId,
			savedPackage,
			publishedCommit: 'commit-owner',
			fingerprint: 'fp',
			requestedByUserId: stableUserId,
		})
	const pending = () =>
		getPendingWentPublicApproval({ env, ownerUserId: orgId, packageId })
	return {
		env,
		packageId,
		approveWentPublic,
		fill,
		resolveUnstamped,
		enqueueOwnerRequest,
		pending,
		resolve: (id: string) =>
			resolvePackageApprovalRequest(db, {
				id,
				status: 'approved',
				resolvedByUserId: stableUserId,
			}),
	}
}

test('a self-published package resolves no credential, even with enforcement off', async () => {
	vi.spyOn(featureFlags, 'isFeatureGloballyEnabled').mockResolvedValue(false)
	const t = await setup()
	await t.approveWentPublic(true)
	const error = await t.fill().catch((caught: unknown) => caught as Error)
	expect(error).toMatchObject({
		code: 'credential_need_undeclared',
		key: 'RESEND',
	})
	expect((error as Error).message).not.toContain(t.packageId)
	expect((error as Error).message).not.toContain(keyValue)
})

test('the owner approving going public again lifts the self-publish limit', async () => {
	vi.spyOn(featureFlags, 'isFeatureGloballyEnabled').mockResolvedValue(false)
	const t = await setup()
	await t.approveWentPublic(true)
	await t.approveWentPublic(false)
	await expect(t.fill()).resolves.toBe(`Bearer ${keyValue}`)
})

test('the unstamped credential-client door still refuses a self-published run package', async () => {
	vi.spyOn(featureFlags, 'isFeatureGloballyEnabled').mockResolvedValue(false)
	const t = await setup()
	await t.approveWentPublic(true)
	await expect(t.resolveUnstamped()).rejects.toMatchObject({
		code: 'credential_need_undeclared',
		key: 'RESEND',
	})
})

test('the self-publish mark is set and cleared in place on a pending request only', async () => {
	const t = await setup()
	const request = await t.enqueueOwnerRequest()
	await expect(setSelfPublishMark(t.env, request.id, true)).resolves.toBe(true)
	const marked = await t.pending()
	expect(marked?.id).toBe(request.id)
	expect(isSelfPublishRequest(marked)).toBe(true)
	expect(marked?.details['fingerprint']).toBe('fp')

	await expect(setSelfPublishMark(t.env, request.id, false)).resolves.toBe(true)
	const unmarked = await t.pending()
	expect(unmarked?.id).toBe(request.id)
	expect(isSelfPublishRequest(unmarked)).toBe(false)
	expect(unmarked?.details).toEqual({
		fingerprint: 'fp',
		summary: 'Serve this package on the public internet.',
	})

	await t.resolve(request.id)
	await expect(setSelfPublishMark(t.env, request.id, true)).resolves.toBe(false)
})
