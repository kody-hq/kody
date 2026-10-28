import { expect, test } from 'vitest'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import {
	changedJobFields,
	jobRunAuditAction,
	recordJobAudit,
	recordJobRunAudit,
} from './job-audit.ts'

test('changedJobFields names only the fields that differ', () => {
	const base = {
		schedule: { type: 'cron', expression: '0 8 * * *' },
		timezone: 'America/Denver',
		params: { a: 1 },
		expiresAt: null,
		killSwitchEnabled: false,
	}
	expect(changedJobFields(base, { ...base })).toEqual([])
	expect(
		changedJobFields(base, {
			...base,
			schedule: { type: 'cron', expression: '0 9 * * *' },
			params: { a: 2 },
			killSwitchEnabled: true,
		}),
	).toEqual(['schedule', 'params', 'kill_switch'])
})

test('recordJobAudit writes a job row and skips without a writer', async () => {
	expect(
		await recordJobAudit(null, {
			orgId: 'org-1',
			jobId: 'job-1',
			name: 'morning',
			action: 'job.created',
		}),
	).toBe(false)
	const audit = createTestOrgAuditWriter({ actorUserId: 'person-1' })
	await recordJobAudit(audit, {
		orgId: 'org-1',
		jobId: 'job-1',
		name: 'morning',
		action: 'job.updated',
		fields: ['schedule'],
	})
	const row = await audit.db
		.prepare(
			`SELECT action, resource_type, resource_id, details_json FROM org_audit_events`,
		)
		.first<{
			action: string
			resource_type: string
			resource_id: string
			details_json: string
		}>()
	expect(row).toMatchObject({
		action: 'job.updated',
		resource_type: 'job',
		resource_id: 'job-1',
	})
	expect(JSON.parse(row!.details_json)).toEqual({
		name: 'morning',
		fields: ['schedule'],
	})
})

test('recordJobRunAudit writes a job.ran row with the run outcome', async () => {
	expect(
		await recordJobRunAudit(null, {
			orgId: 'org-1',
			jobId: 'job-1',
			name: 'morning',
			ok: true,
		}),
	).toBe(false)
	const audit = createTestOrgAuditWriter({ actorUserId: 'person-1' })
	await recordJobRunAudit(audit, {
		orgId: 'org-1',
		jobId: 'job-1',
		name: 'morning',
		ok: false,
	})
	const row = await audit.db
		.prepare(
			`SELECT action, resource_type, resource_id, actor_user_id, details_json FROM org_audit_events`,
		)
		.first<{
			action: string
			resource_type: string
			resource_id: string
			actor_user_id: string
			details_json: string
		}>()
	expect(row).toMatchObject({
		action: jobRunAuditAction,
		resource_type: 'job',
		resource_id: 'job-1',
		actor_user_id: 'person-1',
	})
	expect(JSON.parse(row!.details_json)).toEqual({
		name: 'morning',
		trigger: 'manual',
		ok: false,
	})
})
