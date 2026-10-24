import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	deliverOrgAuditOutboxPayload,
	drainOrgAuditOutbox,
	enqueueOrgAuditOutbox,
	tryDeliverOrgAuditOutboxPlan,
} from './org-audit-outbox.ts'
import { redactOrgAuditActorIdsForDeletedUser } from './org-audit.ts'

const resourceEvents = vi.hoisted(() => ({
	dispatch: vi.fn(async (_input: unknown) => ({ delivered: 0, dropped: [] })),
	pending: [] as Array<Promise<unknown>>,
}))
vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<object>()),
	waitUntil: (promise: Promise<unknown>) => {
		resourceEvents.pending.push(promise)
	},
}))
vi.mock('#worker/resource-events/dispatch.ts', () => ({
	dispatchResourceChangeEvent: resourceEvents.dispatch,
}))

function createAppDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return createD1FromSqlite(sqlite)
}

test('drain delivers outbox rows to AUDIT_DB and clears the queue', async () => {
	const appDb = createAppDb()
	const auditDb = createAuditTestDb()
	const writer = {
		appDb,
		db: auditDb,
		actorUserId: 'actor-1',
		actorUsername: null,
		credentialKind: null,
		credentialId: null,
	}
	const plan = await enqueueOrgAuditOutbox(writer, {
		orgId: 'org-1',
		action: 'member.added',
		targetUserId: 'user-2',
		details: { role: 'member' },
	})
	const pending = await appDb
		.prepare(`SELECT COUNT(*) AS count FROM org_audit_outbox`)
		.first<{ count: number }>()
	expect(pending?.count).toBe(1)

	const result = await drainOrgAuditOutbox({
		env: { APP_DB: appDb, AUDIT_DB: auditDb } as Env,
	})
	expect(result).toMatchObject({ status: 'ok', delivered: 1, remaining: 0 })

	const auditRow = await auditDb
		.prepare(`SELECT id, action FROM org_audit_events WHERE id = ?`)
		.bind(plan.outboxId)
		.first<{ id: string; action: string }>()
	expect(auditRow).toEqual({ id: plan.outboxId, action: 'member.added' })
})

test('delivery clears outbox when AUDIT_DB row already exists', async () => {
	const appDb = createAppDb()
	const auditDb = createAuditTestDb()
	const writer = {
		appDb,
		db: auditDb,
		actorUserId: 'actor-1',
		actorUsername: null,
		credentialKind: null,
		credentialId: null,
	}
	const plan = await enqueueOrgAuditOutbox(writer, {
		orgId: 'org-1',
		action: 'team.created',
		resourceType: 'team',
		resourceId: 'team-1',
	})
	await deliverOrgAuditOutboxPayload(auditDb, plan.payload)
	const redeliver = await tryDeliverOrgAuditOutboxPlan(writer, plan)
	expect(redeliver).toBe(true)
	const pending = await appDb
		.prepare(`SELECT COUNT(*) AS count FROM org_audit_outbox`)
		.first<{ count: number }>()
	expect(pending?.count).toBe(0)
})

test('drain advances past invalid rows to deliver later events', async () => {
	consoleError.mockImplementation(() => {})
	const appDb = createAppDb()
	const auditDb = createAuditTestDb()
	const writer = {
		appDb,
		db: auditDb,
		actorUserId: 'actor-1',
		actorUsername: null,
		credentialKind: null,
		credentialId: null,
	}
	await appDb
		.prepare(
			`INSERT INTO org_audit_outbox (id, org_id, payload_json, created_at)
			 VALUES (?, ?, ?, ?)`,
		)
		.bind('bad-1', 'org-1', '{not-json', '2026-01-01T00:00:00.000Z')
		.run()
	const plan = await enqueueOrgAuditOutbox(writer, {
		orgId: 'org-1',
		action: 'member.added',
		targetUserId: 'user-2',
	})
	await appDb
		.prepare(`UPDATE org_audit_outbox SET created_at = ? WHERE id = ?`)
		.bind('2026-01-01T00:00:01.000Z', plan.outboxId)
		.run()

	const result = await drainOrgAuditOutbox({
		env: { APP_DB: appDb, AUDIT_DB: auditDb } as Env,
		limit: 1,
	})
	expect(result).toMatchObject({ status: 'ok', delivered: 1, errors: 1 })
	const auditRow = await auditDb
		.prepare(`SELECT id FROM org_audit_events WHERE id = ?`)
		.bind(plan.outboxId)
		.first<{ id: string }>()
	expect(auditRow?.id).toBe(plan.outboxId)
	const remainingBad = await appDb
		.prepare(`SELECT id FROM org_audit_outbox WHERE id = ?`)
		.bind('bad-1')
		.first<{ id: string }>()
	expect(remainingBad?.id).toBe('bad-1')
})

test('user purge redacts pending outbox actor ids', async () => {
	const appDb = createAppDb()
	const auditDb = createAuditTestDb()
	const userId = 'user-to-purge'
	const writer = {
		appDb,
		db: auditDb,
		actorUserId: userId,
		actorUsername: 'purge-me',
		credentialKind: null,
		credentialId: null,
	}
	await enqueueOrgAuditOutbox(writer, {
		orgId: 'org-1',
		action: 'member.added',
		targetUserId: 'other',
	})
	await redactOrgAuditActorIdsForDeletedUser({
		env: { APP_DB: appDb, AUDIT_DB: auditDb } as Env,
		userId,
	})
	const row = await appDb
		.prepare(`SELECT payload_json FROM org_audit_outbox LIMIT 1`)
		.first<{ payload_json: string }>()
	expect(JSON.parse(row?.payload_json ?? '{}')).toMatchObject({
		actorUserId: 'deleted-user',
		actorUsername: 'purge-me',
	})
})

test('only the delivery that inserts a successful row emits its event', async () => {
	const appDb = createAppDb()
	const auditDb = createAuditTestDb()
	const writer = {
		appDb,
		db: auditDb,
		actorUserId: 'actor-1',
		actorUsername: null,
		credentialKind: null,
		credentialId: null,
		cause: { packageId: 'package-1', resourceEventDepth: 1 },
		env: { APP_DB: appDb, AUDIT_DB: auditDb } as Env,
	}
	resourceEvents.dispatch.mockClear()
	const plan = await enqueueOrgAuditOutbox(writer, {
		orgId: 'org-1',
		action: 'job.created',
		resourceType: 'job',
		resourceId: 'job-1',
	})
	expect(await tryDeliverOrgAuditOutboxPlan(writer, plan)).toBe(true)
	await Promise.all(resourceEvents.pending)
	expect(resourceEvents.dispatch).toHaveBeenCalledTimes(1)
	expect(resourceEvents.dispatch.mock.calls[0]![0]).toMatchObject({
		payload: {
			action: 'job.created',
			cause: { packageId: 'package-1', resourceEventDepth: 1 },
		},
	})

	// A redelivery finds the row already there and stays quiet.
	await tryDeliverOrgAuditOutboxPlan(writer, plan)
	await Promise.all(resourceEvents.pending)
	expect(resourceEvents.dispatch).toHaveBeenCalledTimes(1)
})
