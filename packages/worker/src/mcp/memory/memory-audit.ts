import {
	recordCommittedOrgAuditEvent,
	type OrgAuditWriter,
} from '#worker/orgs/org-audit.ts'

/**
 * Org audit rows for memories. Memory is personal-only, so the org is always
 * the owner's personal org. Rows name the changed fields, never the memory
 * text; the display name is the subject, cut short.
 */
export const memoryAuditActions = {
	created: 'memory.created',
	updated: 'memory.updated',
	deleted: 'memory.deleted',
} as const

export type MemoryAuditAction =
	(typeof memoryAuditActions)[keyof typeof memoryAuditActions]

export type MemoryAuditField =
	| 'title'
	| 'content'
	| 'category'
	| 'tags'
	| 'sources'
	| 'status'

const maxNameLength = 80

export function memoryAuditName(subject: string) {
	const trimmed = subject.trim()
	return trimmed.length > maxNameLength
		? `${trimmed.slice(0, maxNameLength - 1)}…`
		: trimmed
}

type MemoryAuditRow = {
	subject: string
	summary: string
	details: string | null
	category: string | null
	tags_json: string
	source_uris_json: string
	status: string
}

export function changedMemoryFields(
	before: MemoryAuditRow,
	after: MemoryAuditRow,
): Array<MemoryAuditField> {
	const fields: Array<MemoryAuditField> = []
	if (before.subject !== after.subject) fields.push('title')
	if (
		before.summary !== after.summary ||
		(before.details ?? '') !== (after.details ?? '')
	) {
		fields.push('content')
	}
	if ((before.category ?? null) !== (after.category ?? null)) {
		fields.push('category')
	}
	if (before.tags_json !== after.tags_json) fields.push('tags')
	if (before.source_uris_json !== after.source_uris_json) fields.push('sources')
	if (before.status !== after.status) fields.push('status')
	return fields
}

export async function recordMemoryAudit(
	writer: OrgAuditWriter | null,
	input: {
		orgId: string
		memoryId: string
		subject: string
		action: MemoryAuditAction
		fields?: Array<MemoryAuditField>
	},
) {
	return await recordCommittedOrgAuditEvent(writer, {
		orgId: input.orgId,
		action: input.action,
		resourceType: 'memory',
		resourceId: input.memoryId,
		details: {
			name: memoryAuditName(input.subject),
			fields: input.fields ?? [],
		},
	})
}
