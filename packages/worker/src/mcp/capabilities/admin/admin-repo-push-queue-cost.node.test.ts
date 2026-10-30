import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { auditEventSummaries } from '#worker/test-support/audit-log-spy.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { adminRepoPushQueueCostCapability } from './admin-repo-push-queue-cost.ts'

function createContext(roles: Array<string>) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	sqlite.exec(`
		INSERT INTO usage_rollups (user_id, metric, month, event_count, error_count, total_duration_ms)
		VALUES ('owner-a', 'git_push', strftime('%Y-%m', 'now'), 2, 1, 600);
	`)
	return {
		env: {
			APP_DB: createD1FromSqlite(sqlite),
			WRANGLER_IS_LOCAL_DEV: 'true',
		} as unknown as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			user: {
				userId: personIdFromStored(
					testStableUserIdFromEmail('admin@example.com'),
				),
				email: 'admin@example.com',
				displayName: 'admin',
				roles,
			},
		}),
	}
}

test('adminRepoPushQueueCost is admin-only and returns aggregates without owner ids', async () => {
	await expect(
		adminRepoPushQueueCostCapability.handler({}, createContext(['user'])),
	).rejects.toThrow('lacks required role "admin"')

	const result = await adminRepoPushQueueCostCapability.handler(
		{},
		createContext(['admin']),
	)
	expect(result.days).toBe(7)
	expect(result.available).toBe(false)
	expect(result.paths.map((row) => row.path)).toEqual(['queued', 'direct'])
	expect(result.monthRollup).toMatchObject({
		pushes: 2,
		errors: 1,
		failureRate: 0.5,
		avgWallMs: 300,
	})
	expect(JSON.stringify(result)).not.toContain('owner-a')
	expect(auditEventSummaries()).toContain('adminRepoPushQueueCost:success')
})
