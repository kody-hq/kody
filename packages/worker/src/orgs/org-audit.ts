import * as Sentry from '@sentry/cloudflare'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { auditDatabaseFromEnv } from '#worker/audit-log.ts'
import {
	commitOrgAuditOutbox,
	enqueueOrgAuditOutbox,
	orgAuditOutboxInsertStatement,
	planOrgAuditOutbox,
	redactOrgAuditOutboxActorIdsForDeletedUser,
	type OrgAuditCause,
	type OrgAuditOutboxEvent,
	type OrgAuditWriter,
} from './org-audit-outbox.ts'

export const orgAuditEventResults = ['success', 'failure', 'denied'] as const

export type OrgAuditEventResult = (typeof orgAuditEventResults)[number]

export type LogOrgAuditEventInput = {
	env?: Env
	db?: D1Database | null | undefined
	id?: string
	orgId: string
	action: string
	result: OrgAuditEventResult
	actorUserId?: string | null
	actorUsername?: string | null
	credentialKind?: string | null
	credentialId?: string | null
	resourceType?: string | null
	resourceId?: string | null
	targetUserId?: string | null
	details?: Record<string, unknown>
	detailsJson?: string | null
	ipHash?: string | null
	createdAt?: string
}

function resolveAuditDb(input: LogOrgAuditEventInput): D1Database {
	if (input.db) return input.db
	if (input.env?.AUDIT_DB) return input.env.AUDIT_DB
	if (input.env) {
		const fromEnv = auditDatabaseFromEnv(input.env)
		if (fromEnv) return fromEnv
	}
	throw new Error('AUDIT_DB binding is not configured.')
}

function serializeDetails(input: LogOrgAuditEventInput): string | null {
	if (input.detailsJson !== undefined) return input.detailsJson
	if (input.details !== undefined) return JSON.stringify(input.details)
	return null
}

export function auditDatabaseFromEnvOrThrow(env: Env): D1Database {
	return resolveAuditDb({ env, orgId: '', action: '', result: 'success' })
}

export async function logOrgAuditEvent(input: LogOrgAuditEventInput) {
	const db = resolveAuditDb(input)
	const createdAt = input.createdAt ?? new Date().toISOString()
	await runD1WithRetry(() =>
		db
			.prepare(
				`INSERT INTO org_audit_events (
					id, org_id, actor_user_id, actor_username, credential_kind,
					credential_id, action, resource_type, resource_id, target_user_id,
					result, details_json, ip_hash, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				input.id ?? crypto.randomUUID(),
				input.orgId,
				input.actorUserId ?? null,
				input.actorUsername ?? null,
				input.credentialKind ?? null,
				input.credentialId ?? null,
				input.action,
				input.resourceType ?? null,
				input.resourceId ?? null,
				input.targetUserId ?? null,
				input.result,
				serializeDetails(input),
				input.ipHash ?? null,
				createdAt,
			)
			.run(),
	)
}

async function redactOrgAuditEventsActorIds(
	auditDb: D1Database,
	userId: string,
) {
	await runD1WithRetry(() =>
		auditDb
			.prepare(
				`UPDATE org_audit_events
				SET actor_user_id = 'deleted-user'
				WHERE actor_user_id = ?`,
			)
			.bind(userId)
			.run(),
	)
}

export async function redactOrgAuditActorIdsForDeletedUser(input: {
	env: Env
	userId: string
}) {
	const db = auditDatabaseFromEnvOrThrow(input.env)
	// Outbox first so a concurrent drain re-read picks up deleted-user.
	await redactOrgAuditOutboxActorIdsForDeletedUser({
		appDb: input.env.APP_DB,
		userId: input.userId,
	})
	await redactOrgAuditEventsActorIds(db, input.userId)
	// Catch a drain that delivered a pre-redaction payload mid-purge.
	await redactOrgAuditEventsActorIds(db, input.userId)
}

export type { OrgAuditCause, OrgAuditWriter } from './org-audit-outbox.ts'

export function orgAuditWriterFromRequest(
	env: Env,
	request: RequestContext,
): OrgAuditWriter {
	return {
		appDb: env.APP_DB,
		db: auditDatabaseFromEnvOrThrow(env),
		actorUserId: request.actor?.userId ?? null,
		actorUsername: request.actor?.username ?? null,
		credentialKind: request.credential.kind,
		credentialId: request.credential.id,
		env,
	}
}

/**
 * What caused a capability call's change: the package whose run made the
 * call (its storage context) and the resource event depth that started that
 * run. Null for a call outside a package run.
 */
export function orgAuditCauseFromCaller(
	callerContext: Partial<
		Pick<McpCallerContext, 'storageContext' | 'resourceEventDepth'>
	>,
): OrgAuditCause | null {
	const packageId = callerContext.storageContext?.packageId?.trim() || null
	const resourceEventDepth = callerContext.resourceEventDepth ?? 0
	if (!packageId && resourceEventDepth === 0) return null
	return { packageId, resourceEventDepth }
}

/**
 * The audit writer for a capability call: the caller's request context.
 * Throws when the call has no signed-in request (it could not write).
 */
export function orgAuditWriterFromCaller(
	env: Env,
	callerContext: Pick<McpCallerContext, 'request'> &
		Partial<Pick<McpCallerContext, 'storageContext' | 'resourceEventDepth'>>,
): OrgAuditWriter {
	if (!callerContext.request) {
		throw new Error('Credential writes require a signed-in request.')
	}
	return {
		...orgAuditWriterFromRequest(env, callerContext.request),
		cause: orgAuditCauseFromCaller(callerContext),
	}
}

/**
 * The writer for a change that already committed and must not fail on its
 * audit row (packages, jobs, memories). Null when no audit database is
 * configured.
 */
export function optionalOrgAuditWriter(
	env: Pick<Env, 'APP_DB' | 'AUDIT_DB' | 'SENTRY_ENVIRONMENT'>,
	actor:
		| RequestContext
		| { userId: string | null; username?: string | null }
		| null,
	cause: OrgAuditCause | null = null,
): OrgAuditWriter | null {
	const db = env.AUDIT_DB ?? auditDatabaseFromEnv(env)
	if (!db) return null
	// Callers pass the full worker env; the narrow type only names what the
	// audit row itself needs.
	const fullEnv = env as Env
	if (actor && 'credential' in actor) {
		return {
			appDb: env.APP_DB,
			db,
			actorUserId: actor.actor?.userId ?? null,
			actorUsername: actor.actor?.username ?? null,
			actorProfileId: actor.credential.profileId ?? null,
			credentialKind: actor.credential.kind,
			credentialId: actor.credential.id,
			cause,
			env: fullEnv,
		}
	}
	return {
		appDb: env.APP_DB,
		db,
		actorUserId: actor?.userId ?? null,
		actorUsername: actor?.username ?? null,
		credentialKind: null,
		credentialId: null,
		cause,
		env: fullEnv,
	}
}

/**
 * {@link recordOrgAuditEvent} for a change that already committed: a failed
 * audit write is logged and reported, never thrown. No writer records nothing.
 */
export async function recordCommittedOrgAuditEvent(
	writer: OrgAuditWriter | null,
	event: OrgAuditOutboxEvent,
): Promise<boolean> {
	if (!writer) return false
	try {
		await recordOrgAuditEvent(writer, event)
		return true
	} catch {
		// recordOrgAuditEvent already logged and reported the failure.
		return false
	}
}

export function orgAuditWriterForPerson(
	env: Env,
	actor: { userId: string | null; username?: string | null },
): OrgAuditWriter {
	return {
		appDb: env.APP_DB,
		db: auditDatabaseFromEnvOrThrow(env),
		actorUserId: actor.userId,
		actorUsername: actor.username ?? null,
		credentialKind: null,
		credentialId: null,
		env,
	}
}

/**
 * Commits an APP_DB mutation and its org audit outbox row in one batch, then
 * delivers to AUDIT_DB inline (scheduled drain is backup).
 *
 * With `onlyIfChanged`, the audit row is written only when the last statement
 * changed a row, decided inside the batch so concurrent no-op writes never
 * audit. Returns whether the last statement changed a row.
 */
export async function runAppDbBatchWithOrgAudit(input: {
	appDb: D1Database
	audit: OrgAuditWriter
	statements: Array<{ run(): Promise<unknown> }>
	event: OrgAuditOutboxEvent
	onlyIfChanged?: boolean
}): Promise<{ changed: boolean }> {
	const plan = planOrgAuditOutbox(input.audit, input.event)
	const outbox = orgAuditOutboxInsertStatement(input.appDb, plan, {
		onlyIfChanged: input.onlyIfChanged,
	})
	let results: Array<unknown>
	if (typeof input.appDb.batch === 'function') {
		results = await input.appDb.batch([
			...input.statements,
			outbox,
		] as Array<D1PreparedStatement>)
	} else {
		results = []
		for (const statement of [...input.statements, outbox]) {
			results.push(await statement.run())
		}
	}
	const last = results[input.statements.length - 1] as
		| { meta?: { changes?: number } }
		| undefined
	const changed = (last?.meta?.changes ?? 0) > 0
	if (input.onlyIfChanged && !changed) return { changed }
	// Deliver against the same APP_DB the outbox row was written to.
	await commitOrgAuditOutbox({ ...input.audit, appDb: input.appDb }, plan)
	return { changed }
}

/**
 * Transitional: records audit after APP_DB already committed (member
 * offboarding, invite acceptance, MCP server OAuth). Prefer
 * `runAppDbBatchWithOrgAudit` for new access writes. Enqueue failures fail the
 * request so audit is not silently lost.
 */
export type {
	OrgAuditOutboxEvent,
	OrgAuditOutboxPlan,
} from './org-audit-outbox.ts'
export {
	orgAuditOutboxInsertStatement,
	planOrgAuditOutbox,
	commitOrgAuditOutbox,
} from './org-audit-outbox.ts'

export async function recordOrgAuditEvent(
	writer: OrgAuditWriter,
	event: OrgAuditOutboxEvent,
) {
	try {
		const plan = await enqueueOrgAuditOutbox(writer, event)
		await commitOrgAuditOutbox(writer, plan)
	} catch (error) {
		console.error('Failed to enqueue org audit outbox row:', {
			orgId: event.orgId,
			action: event.action,
			resourceType: event.resourceType ?? null,
			resourceId: event.resourceId ?? null,
			error,
		})
		Sentry.withScope((scope) => {
			scope.setTag('org_audit.action', event.action)
			scope.setContext('org_audit', {
				orgId: event.orgId,
				action: event.action,
				resourceType: event.resourceType ?? null,
				resourceId: event.resourceId ?? null,
			})
			Sentry.captureException(error)
		})
		throw error
	}
}
