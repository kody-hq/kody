import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { auditDatabaseFromEnv } from '#worker/audit-log.ts'
import {
	recordOrgAuditEvent,
	type OrgAuditOutboxEvent,
	type OrgAuditWriter,
} from '#worker/orgs/org-audit.ts'

/**
 * One org audit row per job or enablement on/off change, so an owner can see
 * who (or what) turned something on or off, when, from where, and why.
 * Jobs live in their own database, so the row is recorded right after the
 * change commits (the org audit outbox in APP_DB keeps delivery durable).
 */
export const toggleAuditActions = {
	job: 'job.toggled',
	enablement: 'enablement.toggled',
} as const

export type ToggleAuditResource = keyof typeof toggleAuditActions

export type ToggleAuditActorKind = 'person' | 'automation' | 'admin'

/** Where the change came from. */
export type ToggleAuditSource =
	| 'web'
	| 'mcp'
	| 'api'
	| 'cli'
	| 'package-app'
	| 'enablement'
	| 'scheduler'
	| 'offboarding'
	| 'automation'

export type ToggleAuditState = 'on' | 'off' | 'paused'

export type ToggleAuditActor = {
	kind: ToggleAuditActorKind
	userId: string | null
	username: string | null
	credentialKind: string | null
	credentialId: string | null
}

export type ToggleAuditDetails = {
	from: ToggleAuditState
	to: ToggleAuditState
	source: ToggleAuditSource
	actorKind: ToggleAuditActorKind
	reason: string | null
	/** Job id for a job row, the cron job id (instance) for an enablement. */
	jobId: string | null
	name: string | null
	triggerKind: string | null
}

const maxReasonLength = 500

export function normalizeToggleReason(reason: string | null | undefined) {
	const trimmed = reason?.trim()
	if (!trimmed) return null
	return trimmed.length > maxReasonLength
		? `${trimmed.slice(0, maxReasonLength - 1)}…`
		: trimmed
}

/** The surface a request came through, from its credential. */
export function toggleSourceFromRequest(
	request: Pick<RequestContext, 'credential'> | null | undefined,
): ToggleAuditSource {
	switch (request?.credential?.kind) {
		case 'session':
			return 'web'
		case 'mcp-oauth':
			return 'mcp'
		case 'api-token':
			return 'api'
		case 'cli':
			return 'cli'
		case 'package-app':
			return 'package-app'
		default:
			return 'automation'
	}
}

/** Who acted: a person, an automation run, or a site admin outside the org. */
export function toggleActorFromRequest(
	request: RequestContext | null | undefined,
	options: { siteAdmin?: boolean } = {},
): ToggleAuditActor {
	if (!request) return automationToggleActor()
	const actor = request.actor ?? null
	const automation = request.attribution?.kind === 'automation' || !actor
	const kind: ToggleAuditActorKind = automation
		? 'automation'
		: options.siteAdmin && !request.membership
			? 'admin'
			: 'person'
	return {
		kind,
		userId: actor?.userId ?? null,
		username: actor?.username ?? null,
		credentialKind: request.credential?.kind ?? null,
		credentialId: request.credential?.id ?? null,
	}
}

/** Kody itself (the scheduler, cleanup) with no person behind the change. */
export function automationToggleActor(): ToggleAuditActor {
	return {
		kind: 'automation',
		userId: null,
		username: null,
		credentialKind: null,
		credentialId: null,
	}
}

function toggleAuditWriter(
	env: Env,
	actor: ToggleAuditActor,
): OrgAuditWriter | null {
	const db = env.AUDIT_DB ?? auditDatabaseFromEnv(env)
	if (!db) return null
	return {
		appDb: env.APP_DB,
		db,
		actorUserId: actor.userId,
		actorUsername: actor.username,
		credentialKind: actor.credentialKind,
		credentialId: actor.credentialId,
	}
}

/**
 * Record one on/off change. Never throws: the change already committed, so a
 * failed audit write is reported (Sentry, logs) instead of failing the call.
 */
export async function recordToggleAudit(input: {
	env: Env
	orgId: string
	resource: ToggleAuditResource
	resourceId: string
	from: ToggleAuditState
	to: ToggleAuditState
	source: ToggleAuditSource
	actor: ToggleAuditActor
	reason?: string | null
	jobId?: string | null
	name?: string | null
	triggerKind?: string | null
}): Promise<boolean> {
	if (input.from === input.to) return false
	const writer = toggleAuditWriter(input.env, input.actor)
	if (!writer) return false
	const details: ToggleAuditDetails = {
		from: input.from,
		to: input.to,
		source: input.source,
		actorKind: input.actor.kind,
		reason: normalizeToggleReason(input.reason),
		jobId: input.jobId ?? (input.resource === 'job' ? input.resourceId : null),
		name: input.name ?? null,
		triggerKind: input.triggerKind ?? null,
	}
	try {
		await recordOrgAuditEvent(writer, {
			orgId: input.orgId,
			action: toggleAuditActions[input.resource],
			resourceType: input.resource,
			resourceId: input.resourceId,
			details,
		})
		return true
	} catch {
		// recordOrgAuditEvent already logged and reported the failure.
		return false
	}
}

/** The trigger an enablement turns on (a cron enablement's instance is its job). */
export type ToggleAuditEnablement = {
	id: string
	orgId: string
	triggerKind: string
	triggerName: string
	instanceId: string
}

function enablementJobId(enablement: ToggleAuditEnablement) {
	return enablement.triggerKind === 'cron' ? enablement.instanceId : null
}

/**
 * The audit event for an enablement turning on or off, for writers that
 * commit it in the same APP_DB batch as the enablement row.
 */
export function enablementToggleEvent(input: {
	enablement: ToggleAuditEnablement
	from: ToggleAuditState
	to: ToggleAuditState
	source: ToggleAuditSource
	actorKind: ToggleAuditActorKind
	reason?: string | null
}): OrgAuditOutboxEvent {
	const details: ToggleAuditDetails = {
		from: input.from,
		to: input.to,
		source: input.source,
		actorKind: input.actorKind,
		reason: normalizeToggleReason(input.reason),
		jobId: enablementJobId(input.enablement),
		name: input.enablement.triggerName,
		triggerKind: input.enablement.triggerKind,
	}
	return {
		orgId: input.enablement.orgId,
		action: toggleAuditActions.enablement,
		resourceType: 'enablement',
		resourceId: input.enablement.id,
		details,
	}
}

/** {@link recordToggleAudit} for an enablement changed by a request. */
export async function recordEnablementToggle(input: {
	env: Env
	request: RequestContext | null
	enablement: ToggleAuditEnablement
	from: ToggleAuditState
	to: ToggleAuditState
	reason?: string | null
}) {
	return await recordToggleAudit({
		env: input.env,
		orgId: input.enablement.orgId,
		resource: 'enablement',
		resourceId: input.enablement.id,
		from: input.from,
		to: input.to,
		source: toggleSourceFromRequest(input.request),
		actor: toggleActorFromRequest(input.request),
		reason: input.reason,
		jobId: enablementJobId(input.enablement),
		name: input.enablement.triggerName,
		triggerKind: input.enablement.triggerKind,
	})
}

export type ToggleAuditEntry = {
	id: string
	resource: ToggleAuditResource
	resourceId: string
	createdAt: string
	actorUserId: string | null
	actorUsername: string | null
	credentialKind: string | null
} & ToggleAuditDetails

type ToggleAuditRow = {
	id: string
	action: string
	resource_id: string | null
	actor_user_id: string | null
	actor_username: string | null
	credential_kind: string | null
	details_json: string | null
	created_at: string
}

const toggleStates = new Set<ToggleAuditState>(['on', 'off', 'paused'])

function readState(value: unknown): ToggleAuditState | null {
	return typeof value === 'string' && toggleStates.has(value as never)
		? (value as ToggleAuditState)
		: null
}

function readString(value: unknown) {
	return typeof value === 'string' && value.length > 0 ? value : null
}

function toEntry(row: ToggleAuditRow): ToggleAuditEntry | null {
	const resource =
		row.action === toggleAuditActions.job
			? 'job'
			: row.action === toggleAuditActions.enablement
				? 'enablement'
				: null
	if (!resource || !row.resource_id) return null
	let parsed: Record<string, unknown> = {}
	try {
		parsed = row.details_json
			? (JSON.parse(row.details_json) as Record<string, unknown>)
			: {}
	} catch {
		parsed = {}
	}
	const from = readState(parsed.from)
	const to = readState(parsed.to)
	if (!from || !to) return null
	const actorKind = readString(parsed.actorKind)
	return {
		id: row.id,
		resource,
		resourceId: row.resource_id,
		createdAt: row.created_at,
		actorUserId: row.actor_user_id,
		actorUsername: row.actor_username,
		credentialKind: row.credential_kind,
		from,
		to,
		source: (readString(parsed.source) ?? 'automation') as ToggleAuditSource,
		actorKind:
			actorKind === 'person' || actorKind === 'admin'
				? actorKind
				: 'automation',
		reason: readString(parsed.reason),
		jobId: readString(parsed.jobId),
		name: readString(parsed.name),
		triggerKind: readString(parsed.triggerKind),
	}
}

/** Recent on/off changes in one org, newest first. */
export async function listToggleAudit(input: {
	env: Env
	orgId: string
	since?: string
	jobId?: string
	limit?: number
}): Promise<Array<ToggleAuditEntry>> {
	const db = input.env.AUDIT_DB ?? auditDatabaseFromEnv(input.env)
	if (!db) return []
	const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 20), 100))
	const where = ['org_id = ?', 'action IN (?, ?)']
	const bindings: Array<string | number> = [
		input.orgId,
		toggleAuditActions.job,
		toggleAuditActions.enablement,
	]
	if (input.since) {
		where.push('created_at >= ?')
		bindings.push(input.since)
	}
	if (input.jobId) {
		where.push(`(resource_id = ? OR json_extract(details_json, '$.jobId') = ?)`)
		bindings.push(input.jobId, input.jobId)
	}
	const result = await db
		.prepare(
			`SELECT id, action, resource_id, actor_user_id, actor_username,
				credential_kind, details_json, created_at
			FROM org_audit_events
			WHERE ${where.join(' AND ')}
			ORDER BY created_at DESC
			LIMIT ?`,
		)
		.bind(...bindings, limit)
		.all<ToggleAuditRow>()
	return (result.results ?? [])
		.map(toEntry)
		.filter((entry): entry is ToggleAuditEntry => entry !== null)
}
