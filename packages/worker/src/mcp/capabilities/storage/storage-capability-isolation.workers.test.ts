import { resetIsolateState } from '@kody-internal/shared/isolate-state-test-support.ts'
import {
	personIdFromStored,
	ownerIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { ensureUserStorageBucketsTestSchema } from '#worker/storage-buckets/test-schema.ts'
import { buildPackageStorageId } from '#worker/storage-ids.ts'
import { ensurePackageSubscriptionTestSchema } from '#worker/test-support/workers-seed.ts'
import { storageRunnerRpc } from '#worker/storage-runner.ts'
import { storageExportCapability } from './storage-export.ts'
import { storageQueryCapability } from './storage-query.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'

function createPackageCallerContext(input: {
	userId: string
	packageId: string
}) {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://kody.dev',
		user: {
			userId: personIdFromStored(input.userId),
			email: 'worker@example.com',
			displayName: 'Worker',
		},
		storageContext: {
			sessionId: null,
			appId: input.packageId,
			packageId: input.packageId,
			storageId: buildPackageStorageId(input.packageId),
		},
	})
}

test('storage capabilities keep a package out of another package bucket', async () => {
	await ensureEntitlementTestSchema(env.APP_DB)
	await ensureUserStorageBucketsTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	await ensurePackageSubscriptionTestSchema(env.APP_DB)
	resetIsolateState()

	const userId = `user-${crypto.randomUUID()}`
	const victimPackageId = crypto.randomUUID()
	const attackerPackageId = crypto.randomUUID()
	const victimBucket = buildPackageStorageId(victimPackageId)
	const victimRunner = storageRunnerRpc({
		env,
		userId: ownerIdFromStored(userId),
		storageId: victimBucket,
	})

	await victimRunner.setValue({ key: 'token', value: 'do-not-leak' })
	await victimRunner.sqlQuery({
		query: 'create table if not exists secrets (name text)',
		writable: true,
	})
	await victimRunner.sqlQuery({
		query: "insert into secrets values ('do-not-leak')",
		writable: true,
	})

	const callerContext = createPackageCallerContext({
		userId,
		packageId: attackerPackageId,
	})
	const ctx = { env, callerContext } as never

	await expect(
		storageExportCapability.handler({ storage_id: victimBucket }, ctx),
	).rejects.toThrow(McpCallerError)
	await expect(
		storageQueryCapability.handler(
			{ storage_id: victimBucket, query: 'select name from secrets' },
			ctx,
		),
	).rejects.toThrow(McpCallerError)
	await expect(
		storageQueryCapability.handler(
			{
				storage_id: victimBucket,
				query: 'delete from secrets',
				writable: true,
			},
			ctx,
		),
	).rejects.toThrow(McpCallerError)

	// The victim bucket is untouched by the denied calls.
	await expect(
		victimRunner.sqlQuery({ query: 'select count(*) as rows from secrets' }),
	).resolves.toMatchObject({ rows: [{ rows: 1 }] })

	// The caller still reaches its own bucket by id when the package row exists.
	const ownBucket = buildPackageStorageId(attackerPackageId)
	const now = new Date().toISOString()
	await env.APP_DB.prepare(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, has_skills, hidden, is_private, created_at, updated_at
		) VALUES (?, ?, ?, ?, '', '[]', null, ?, 0, 0, 0, 1, ?, ?)`,
	)
		.bind(
			attackerPackageId,
			ownerIdFromStored(userId),
			'@worker/attacker',
			'attacker',
			`source-${attackerPackageId}`,
			now,
			now,
		)
		.run()
	await storageRunnerRpc({
		env,
		userId: ownerIdFromStored(userId),
		storageId: ownBucket,
	}).setValue({
		key: 'mine',
		value: 'ok',
	})
	await expect(
		storageExportCapability.handler({ storage_id: ownBucket }, ctx),
	).resolves.toMatchObject({
		storage_id: ownBucket,
		export: { entries: [{ key: 'mine', value: 'ok' }] },
	})
})
