import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { signLocalExecutePackageBinding } from '#worker/package-runtime/local-execute-package-binding.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import type * as EntitlementsService from '#worker/entitlements/service.ts'
import type * as StorageBucketsService from '#worker/storage-buckets/service.ts'
import { createCapabilityProxyPackageHostTools } from './capability-proxy-package-grants.ts'

// 22.9 MB already stored: over the Free 16 MiB limit, far under Pro.
const usedBytes = 22_900_000

vi.mock('#worker/entitlements/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof EntitlementsService>()
	return { ...actual, readStorageBytesFromUserMeter: async () => usedBytes }
})

vi.mock('#worker/storage-buckets/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof StorageBucketsService>()
	return {
		...actual,
		listUserStorageBucketEstimates: async () => [],
		registerStorageBucket: async () => undefined,
		recordStorageBucketEstimate: async () => undefined,
		maybeRefreshStorageBucketEstimate: async () => undefined,
	}
})

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const memberId = 'a'.repeat(64)
const memberEmail = 'member@example.com'
const teamOrgId = 'b'.repeat(64)
const packageId = 'lineage'

function createDb(teamPlan: 'free' | 'pro') {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
			 VALUES (?, 'member', 'free', 'now', 'now'), (?, 'kody', ?, 'now', 'now')`,
		)
		.run(memberId, teamOrgId, teamPlan)
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, personal_org_id)
			 VALUES ('member', ?, 'hash', ?, ?)`,
		)
		.run(memberEmail, memberId, memberId)
	sqlite
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
			 VALUES (?, ?, ?, ?, 'Org package', 'source-lineage')`,
		)
		.run(packageId, teamOrgId, packageId, packageId)
	sqlite
		.prepare(
			`INSERT INTO grants (id, org_id, resource_type, resource_id, subject_type,
			   subject_id, preset, created_by_user_id, created_at, updated_at)
			 VALUES ('grant-lineage', ?, 'package', ?, 'user', ?, 'use', ?, 'now', 'now')`,
		)
		.run(teamOrgId, packageId, memberId, memberId)
	sqlite
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission)
			 VALUES ('grant-lineage', 'package:read'), ('grant-lineage', 'package:execute')`,
		)
		.run()
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', 'now')`,
		)
		.run(teamOrgId, memberId)
	return createD1FromSqlite(sqlite)
}

function createEnv(db: D1Database) {
	const writeLimits: Array<number> = []
	const runner = {
		getEstimatedBytes: async () => ({ estimatedBytes: 0 }),
		setValueWithinLimit: async (payload: { maxDatabaseBytes: number }) => {
			writeLimits.push(payload.maxDatabaseBytes)
			return payload.maxDatabaseBytes >= 64
				? { withinLimit: true, result: { ok: true }, databaseBytes: 64 }
				: { withinLimit: false, databaseBytes: 64, previousDatabaseBytes: 0 }
		},
	}
	const env = {
		APP_DB: db,
		SECRET_STORE_KEY: 'test-secret-store-key',
		STORAGE_RUNNER: {
			idFromName: (name: string) => name,
			get: () => runner,
		},
	} as unknown as Env
	return { env, writeLimits }
}

function memberInTeamOrg() {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://kody.codes',
		executionOrigin: 'interactive',
		user: {
			userId: personIdFromStored(memberId),
			email: memberEmail,
			displayName: 'Member',
		},
		orgBinding: { org: { id: teamOrgId, slug: 'kody' }, role: 'member' },
	})
}

async function setFromLocalRun(teamPlan: 'free' | 'pro') {
	const db = createDb(teamPlan)
	const { env, writeLimits } = createEnv(db)
	const callerContext = memberInTeamOrg()
	expect(ownerIdFromCaller(callerContext)).toBe(teamOrgId)
	const binding = await signLocalExecutePackageBinding({
		env,
		packageId,
		subject: {
			org: ownerIdFromCaller(callerContext),
			actor: callerContext.request?.actor?.userId ?? null,
		},
	})
	const tools = await createCapabilityProxyPackageHostTools({
		env,
		callerContext,
	})
	const result = tools.packageStorageSet?.({
		packageId: binding,
		key: 'cursor',
		value: 'next',
	})
	return { result, writeLimits }
}

test('a member running a Pro org package locally gets the org storage limit', async () => {
	const { result, writeLimits } = await setFromLocalRun('pro')
	await expect(result).resolves.toEqual({ ok: true })
	expect(writeLimits).toHaveLength(1)
	expect(writeLimits[0]).toBeGreaterThan(usedBytes)
})

test('a member running a Free org package locally stays on the Free limit', async () => {
	const { result } = await setFromLocalRun('free')
	await expect(result).rejects.toThrow(
		/"free" plan allows at most 16777216 storage bytes/,
	)
})
