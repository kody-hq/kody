import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { expect, test, vi } from 'vitest'
import { applyMigrations } from '#worker/test-support/account-export.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { jobRunAuditAction } from './job-audit.ts'
import { runJobNowViaManager } from './manager-client.ts'

const orgId = ownerIdFromStored('org-run-now')
const annId = personIdFromStored('person-ann')

function sessionRequest(): RequestContext {
	return {
		org: { id: orgId, slug: 'acme' },
		actor: { userId: annId, username: 'ann' },
		attribution: { kind: 'user', userId: annId },
		credential: {
			kind: 'session',
			id: 'session-1',
			orgId,
			scopes: null,
		},
		membership: { role: 'owner' },
	}
}

function createEnv(execution: { ok: true } | { ok: false; error: string }) {
	const sqlite = new DatabaseSync(':memory:')
	applyMigrations(sqlite)
	const auditDb = createAuditTestDb()
	const runJobNow = vi.fn(async (input: { jobId: string }) => ({
		job: { id: input.jobId, name: 'morning' },
		execution: { ...execution, logs: [] },
	}))
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		AUDIT_DB: auditDb,
		SENTRY_ENVIRONMENT: 'test',
		JOBS: { runJobNow },
	} as unknown as Env
	return { env, auditDb, runJobNow }
}

async function auditRows(db: D1Database) {
	const { results } = await db
		.prepare(
			`SELECT action, resource_id, actor_user_id, credential_kind, details_json FROM org_audit_events`,
		)
		.all<{
			action: string
			resource_id: string
			actor_user_id: string | null
			credential_kind: string | null
			details_json: string
		}>()
	return results.map((row) => ({
		...row,
		details: JSON.parse(row.details_json) as unknown,
	}))
}

test('a manual run records who ran it and whether it succeeded', async () => {
	const { env, auditDb, runJobNow } = createEnv({ ok: true })
	const callerContext = {
		request: sessionRequest(),
	} as unknown as McpCallerContext
	const result = await runJobNowViaManager({
		env,
		userId: orgId,
		jobId: 'pkg:morning',
		callerContext,
	})
	expect(result.execution.ok).toBe(true)
	expect(runJobNow).toHaveBeenCalledWith(
		expect.objectContaining({ userId: orgId, jobId: 'pkg:morning' }),
	)
	expect(await auditRows(auditDb)).toEqual([
		expect.objectContaining({
			action: jobRunAuditAction,
			resource_id: 'pkg:morning',
			actor_user_id: annId,
			credential_kind: 'session',
			details: { name: 'morning', trigger: 'manual', ok: true },
		}),
	])
})

test('a failed manual run is still audited, with ok false', async () => {
	const { env, auditDb } = createEnv({ ok: false, error: 'boom' })
	await runJobNowViaManager({
		env,
		userId: orgId,
		jobId: 'pkg:morning',
		callerContext: { request: sessionRequest() } as unknown as McpCallerContext,
	})
	expect(await auditRows(auditDb)).toEqual([
		expect.objectContaining({
			action: jobRunAuditAction,
			details: { name: 'morning', trigger: 'manual', ok: false },
		}),
	])
})

test('a run that never starts records nothing', async () => {
	const { env, auditDb, runJobNow } = createEnv({ ok: true })
	runJobNow.mockRejectedValueOnce(new Error('Job "pkg:gone" was not found.'))
	await expect(
		runJobNowViaManager({
			env,
			userId: orgId,
			jobId: 'pkg:gone',
			callerContext: {
				request: sessionRequest(),
			} as unknown as McpCallerContext,
		}),
	).rejects.toThrow('was not found')
	expect(await auditRows(auditDb)).toEqual([])
})
