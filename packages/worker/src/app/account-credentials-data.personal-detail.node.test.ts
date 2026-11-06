/**
 * Personal-org credential detail soft-fails: list stays up when selected-only
 * work (usage, grants, local reads) rejects. Metadata only; no secret values.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import type { AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { saveSecret } from '#mcp/secrets/service.ts'
import { findCredentialIdsByLegacyName } from '#worker/credentials/credential-ids.ts'

const mocks = vi.hoisted(() => ({
	detailError: null as Error | null,
	localReadsError: null as Error | null,
}))

vi.mock('#worker/credentials/credential-detail.ts', async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import('#worker/credentials/credential-detail.ts')
		>()
	return {
		...actual,
		loadCredentialDetail: async (
			...args: Parameters<typeof actual.loadCredentialDetail>
		) => {
			if (mocks.detailError) throw mocks.detailError
			return actual.loadCredentialDetail(...args)
		},
	}
})

vi.mock('#app/credential-local-reads.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#app/credential-local-reads.ts')>()
	return {
		...actual,
		loadCredentialLocalReadsView: async (
			...args: Parameters<typeof actual.loadCredentialLocalReadsView>
		) => {
			if (mocks.localReadsError) throw mocks.localReadsError
			return actual.loadCredentialLocalReadsView(...args)
		},
	}
})

vi.mock(
	'#worker/test-support/apply-all-migrations.ts',
	async (importOriginal) =>
		(
			await import('#worker/credentials/cached-migrations.test-support.ts')
		).withCachedMigrations(await importOriginal()),
)

const { loadAccountCredentialsData } =
	await import('./account-credentials-data.ts')

const now = '2026-11-06T00:00:00.000Z'
const fixtureValue = 'synthetic-fixture-value-not-a-secret'

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const stableUserId = testStableUserIdFromEmail('ann@example.com')
	const personId = personIdFromStored(stableUserId)
	const personalOrgId = ownerIdFromStored(stableUserId)
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, personal_org_id)
			 VALUES (?, ?, 'x', ?, ?)`,
		)
		.bind('ann', 'ann@example.com', stableUserId, personalOrgId)
		.run()
	await provisionPersonalOrg(db, {
		stableUserId,
		username: 'ann',
		createdAt: now,
	})
	const env = {
		APP_DB: db,
		...createInMemoryUserMeterEnv().env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	await saveSecret({
		env,
		userId: personalOrgId,
		scope: 'user',
		name: 'annToken',
		value: fixtureValue,
		audit: null,
	})
	const credentialId = (
		await findCredentialIdsByLegacyName(db, personalOrgId, {
			type: 'secret',
			name: 'annToken',
		})
	)[0]!
	const request = deriveRequestContext({
		user: {
			userId: personId,
			username: 'ann',
			personalOrgId,
		},
		source: { kind: 'session' },
		orgBinding: { org: { id: personalOrgId, slug: 'ann' }, role: 'owner' },
	})
	const user = {
		request,
		mcpUser: {
			userId: personId,
			username: 'ann',
			email: 'ann@example.com',
			personalOrgId,
		},
		username: 'ann',
	} as unknown as AuthenticatedAppUser
	return { env, user, credentialId, personalOrgId }
}

beforeEach(() => {
	mocks.detailError = null
	mocks.localReadsError = null
})

test('personal org credential detail loads without throwing', async () => {
	const t = await setup()
	const page = await loadAccountCredentialsData({
		env: t.env,
		user: t.user,
		selectedId: t.credentialId,
	})
	expect(page.ok).toBe(true)
	expect(page.teamOrg).toBe(false)
	expect(page.selected?.id).toBe(t.credentialId)
	expect(page.selected?.grants).toEqual([])
	expect(page.selectedLocalReads?.credentialId).toBe(t.credentialId)
})

test('personal org detail soft-fails when selected detail or local reads reject', async () => {
	const t = await setup()
	mocks.detailError = new Error('detail blew up')
	mocks.localReadsError = new Error('local reads blew up')
	const page = await loadAccountCredentialsData({
		env: t.env,
		user: t.user,
		selectedId: t.credentialId,
	})
	expect(page.ok).toBe(true)
	expect(page.teamOrg).toBe(false)
	expect(page.credentials.some((item) => item.id === t.credentialId)).toBe(true)
	expect(page.selected).toBeNull()
	expect(page.selectedLocalReads).toBeNull()
})
