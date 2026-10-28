import {
	recordCommittedOrgAuditEvent,
	type OrgAuditWriter,
} from '#worker/orgs/org-audit.ts'

/**
 * Org audit rows for a job's lifecycle: created, changed (schedule,
 * timezone, params, expiry, kill switch), and deleted. On and off changes are
 * `job.toggled` (`toggle-audit.ts`). A manual run (Run now on the website or
 * `jobRunNow`) is `job.ran`; it changes nothing, so it never emits a resource
 * event. Jobs live in their own database, so rows are recorded right after the
 * change commits and never fail it.
 */
export const jobAuditActions = {
	created: 'job.created',
	updated: 'job.updated',
	deleted: 'job.deleted',
} as const

export const jobRunAuditAction = 'job.ran'

export type JobAuditAction =
	(typeof jobAuditActions)[keyof typeof jobAuditActions]

export type JobAuditField =
	| 'schedule'
	| 'timezone'
	| 'params'
	| 'expires_at'
	| 'kill_switch'

export async function recordJobAudit(
	writer: OrgAuditWriter | null,
	input: {
		orgId: string
		jobId: string
		name: string
		action: JobAuditAction
		fields?: Array<JobAuditField>
		enabled?: boolean
	},
) {
	return await recordCommittedOrgAuditEvent(writer, {
		orgId: input.orgId,
		action: input.action,
		resourceType: 'job',
		resourceId: input.jobId,
		details: {
			name: input.name,
			fields: input.fields ?? [],
			...(input.enabled === undefined ? {} : { enabled: input.enabled }),
		},
	})
}

/** Who ran a job by hand and whether its run succeeded. */
export async function recordJobRunAudit(
	writer: OrgAuditWriter | null,
	input: { orgId: string; jobId: string; name: string; ok: boolean },
) {
	return await recordCommittedOrgAuditEvent(writer, {
		orgId: input.orgId,
		action: jobRunAuditAction,
		resourceType: 'job',
		resourceId: input.jobId,
		details: { name: input.name, trigger: 'manual', ok: input.ok },
	})
}

/** The job fields that differ between two job records. */
export function changedJobFields(
	before: {
		schedule: unknown
		timezone?: string | null
		params?: unknown
		expiresAt?: string | null
		killSwitchEnabled?: boolean
	},
	after: typeof before,
): Array<JobAuditField> {
	const fields: Array<JobAuditField> = []
	if (JSON.stringify(before.schedule) !== JSON.stringify(after.schedule)) {
		fields.push('schedule')
	}
	if ((before.timezone ?? null) !== (after.timezone ?? null)) {
		fields.push('timezone')
	}
	if (
		JSON.stringify(before.params ?? null) !==
		JSON.stringify(after.params ?? null)
	) {
		fields.push('params')
	}
	if ((before.expiresAt ?? null) !== (after.expiresAt ?? null)) {
		fields.push('expires_at')
	}
	if (Boolean(before.killSwitchEnabled) !== Boolean(after.killSwitchEnabled)) {
		fields.push('kill_switch')
	}
	return fields
}
