import { createActor, createAsyncLogic, toPromise } from 'xstate'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { isResourceChangeAuditAction } from '#worker/resource-events/projection.ts'
import {
	orgAuditOutboxDeliveryState,
	orgAuditOutboxDrainState,
	type OrgAuditOutboxDrainRow,
} from '#worker/orgs/org-audit-outbox-state.ts'

/**
 * What caused a change: the package whose run made it, and how many resource
 * change events led to that run. Kept in the outbox payload only, so resource
 * change events never reach the package that caused them and chains stop.
 */
export type OrgAuditCause = {
	packageId: string | null
	resourceEventDepth: number
}

export type OrgAuditWriter = {
	appDb: D1Database
	db: D1Database
	actorUserId: string | null
	actorUsername: string | null
	credentialKind: string | null
	credentialId: string | null
	/** The profile the actor ran as (ADR 0092), for its creator grant. */
	actorProfileId?: string | null
	/** That profile's chain when the change was made: ids, root first. */
	actorProfileChain?: ReadonlyArray<string> | null
	/** Set when a package run made the change. */
	cause?: OrgAuditCause | null
	/**
	 * The full worker env, when the writer has it: a newly inserted audit row
	 * then emits its resource change event. Writers without it emit nothing.
	 */
	env?: Env
}

export type OrgAuditOutboxPayload = {
	id: string
	orgId: string
	action: string
	result: 'success' | 'failure' | 'denied'
	actorUserId: string | null
	actorUsername: string | null
	credentialKind: string | null
	credentialId: string | null
	resourceType: string | null
	resourceId: string | null
	targetUserId: string | null
	detailsJson: string | null
	ipHash: string | null
	createdAt: string
	/** Outbox only; never written to AUDIT_DB. */
	cause?: OrgAuditCause | null
}

export type OrgAuditOutboxPlan = {
	outboxId: string
	payload: OrgAuditOutboxPayload
}

export type OrgAuditOutboxEvent = {
	orgId: string
	action: string
	resourceType?: string | null
	resourceId?: string | null
	targetUserId?: string | null
	details?: Record<string, unknown>
}

function serializeDetails(
	event: OrgAuditOutboxEvent,
	writer?: Pick<OrgAuditWriter, 'actorProfileId' | 'actorProfileChain'>,
): string | null {
	const profileId = writer?.actorProfileId?.trim() || null
	if (!profileId) {
		return event.details === undefined ? null : JSON.stringify(event.details)
	}
	const chain = writer?.actorProfileChain?.length
		? [...writer.actorProfileChain]
		: [profileId]
	return JSON.stringify({
		...event.details,
		actingProfile: { id: profileId, chain },
	})
}

export function buildOrgAuditOutboxPayload(
	writer: OrgAuditWriter,
	event: OrgAuditOutboxEvent,
): OrgAuditOutboxPayload {
	const createdAt = new Date().toISOString()
	return {
		id: crypto.randomUUID(),
		orgId: event.orgId,
		action: event.action,
		result: 'success',
		actorUserId: writer.actorUserId,
		actorUsername: writer.actorUsername,
		credentialKind: writer.credentialKind,
		credentialId: writer.credentialId,
		resourceType: event.resourceType ?? null,
		resourceId: event.resourceId ?? null,
		targetUserId: event.targetUserId ?? null,
		detailsJson: serializeDetails(event, writer),
		ipHash: null,
		createdAt,
		...(writer.cause ? { cause: writer.cause } : {}),
	}
}

export function planOrgAuditOutbox(
	writer: OrgAuditWriter,
	event: OrgAuditOutboxEvent,
): OrgAuditOutboxPlan {
	const payload = buildOrgAuditOutboxPayload(writer, event)
	return { outboxId: payload.id, payload }
}

/**
 * With `onlyIfChanged`, the row is written only when the statement run just
 * before it in the same batch changed a row (SQLite `changes()`).
 */
export function orgAuditOutboxInsertStatement(
	appDb: D1Database,
	plan: OrgAuditOutboxPlan,
	options: { onlyIfChanged?: boolean } = {},
) {
	return appDb
		.prepare(
			options.onlyIfChanged
				? `INSERT INTO org_audit_outbox (id, org_id, payload_json, created_at)
			 SELECT ?, ?, ?, ? WHERE changes() > 0`
				: `INSERT INTO org_audit_outbox (id, org_id, payload_json, created_at)
			 VALUES (?, ?, ?, ?)`,
		)
		.bind(
			plan.payload.id,
			plan.payload.orgId,
			JSON.stringify(plan.payload),
			plan.payload.createdAt,
		)
}

export function parseOrgAuditOutboxPayload(
	raw: string,
): OrgAuditOutboxPayload | null {
	try {
		const parsed = JSON.parse(raw) as OrgAuditOutboxPayload
		if (
			typeof parsed.id !== 'string' ||
			typeof parsed.orgId !== 'string' ||
			typeof parsed.action !== 'string' ||
			typeof parsed.result !== 'string' ||
			typeof parsed.createdAt !== 'string'
		) {
			return null
		}
		return parsed
	} catch {
		return null
	}
}

export type OrgAuditOutboxDeliveryResult = 'inserted' | 'already_exists'

export async function deliverOrgAuditOutboxPayload(
	auditDb: D1Database,
	payload: OrgAuditOutboxPayload,
): Promise<OrgAuditOutboxDeliveryResult> {
	const insert = await runD1WithRetry(() =>
		auditDb
			.prepare(
				`INSERT OR IGNORE INTO org_audit_events (
					id, org_id, actor_user_id, actor_username, credential_kind,
					credential_id, action, resource_type, resource_id, target_user_id,
					result, details_json, ip_hash, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				payload.id,
				payload.orgId,
				payload.actorUserId,
				payload.actorUsername,
				payload.credentialKind,
				payload.credentialId,
				payload.action,
				payload.resourceType,
				payload.resourceId,
				payload.targetUserId,
				payload.result,
				payload.detailsJson,
				payload.ipHash,
				payload.createdAt,
			)
			.run(),
	)
	if ((insert.meta?.changes ?? 0) > 0) return 'inserted'
	const existing = await auditDb
		.prepare(`SELECT 1 AS ok FROM org_audit_events WHERE id = ?`)
		.bind(payload.id)
		.first<{ ok: number }>()
	if (existing?.ok) return 'already_exists'
	throw new Error(`org_audit_outbox_delivery_failed:${payload.id}`)
}

async function deleteOrgAuditOutboxRow(appDb: D1Database, outboxId: string) {
	await runD1WithRetry(() =>
		appDb
			.prepare(`DELETE FROM org_audit_outbox WHERE id = ?`)
			.bind(outboxId)
			.run(),
	)
}

/**
 * Inserts into AUDIT_DB and removes the outbox row. Returns false when AUDIT_DB
 * is unavailable so a scheduled drain can retry. Re-reads the outbox payload
 * before insert so a concurrent user-purge redaction is not lost.
 */
export async function tryDeliverOrgAuditOutboxPlan(
	writer: OrgAuditWriter,
	plan: OrgAuditOutboxPlan,
): Promise<boolean> {
	const delivery = orgAuditOutboxDeliveryState.provide({
		actors: {
			readLivePayload: createAsyncLogic<OrgAuditOutboxPayload | 'row_gone'>({
				run: async () => {
					const live = await writer.appDb
						.prepare(`SELECT payload_json FROM org_audit_outbox WHERE id = ?`)
						.bind(plan.outboxId)
						.first<{ payload_json: string }>()
					if (!live) return 'row_gone'
					return parseOrgAuditOutboxPayload(live.payload_json) ?? plan.payload
				},
			}),
			insertAuditRow: createAsyncLogic<
				OrgAuditOutboxDeliveryResult,
				OrgAuditOutboxPayload
			>({
				run: ({ input: payload }) =>
					deliverOrgAuditOutboxPayload(writer.db, payload),
			}),
			// Only the delivery that inserted the row emits, so a retried or
			// concurrent drain never emits the same change twice.
			emitResourceChange: createAsyncLogic<void, OrgAuditOutboxPayload>({
				run: ({ input: payload }) =>
					scheduleResourceChangeEvent(writer.env, payload),
			}),
			clearOutboxRow: createAsyncLogic<void>({
				run: () => deleteOrgAuditOutboxRow(writer.appDb, plan.outboxId),
			}),
		},
	})
	return toPromise(createActor(delivery).start())
}

/**
 * Emit the resource change event for a newly inserted, successful audit row
 * after the response. Best-effort: delivery failures are logged in
 * `resource-events/dispatch.ts` and never fail the change.
 */
async function scheduleResourceChangeEvent(
	env: Env | undefined,
	payload: OrgAuditOutboxPayload,
) {
	if (!env || payload.result !== 'success') return
	if (!isResourceChangeAuditAction(payload.action)) return
	const logFailure = (error: unknown) => {
		console.error('resource-change-event-failed', {
			action: payload.action,
			auditId: payload.id,
			error,
		})
	}
	try {
		// Loaded lazily so plain Node tools that import the audit outbox (the
		// CLI OpenAPI generator) do not need the Workers runtime.
		const { waitUntil } = await import('cloudflare:workers')
		waitUntil(
			import('#worker/resource-events/dispatch.ts')
				.then(({ dispatchResourceChangeEvent }) =>
					dispatchResourceChangeEvent({ env, payload }),
				)
				.catch(logFailure),
		)
	} catch (error) {
		logFailure(error)
	}
}

export async function redactOrgAuditOutboxActorIdsForDeletedUser(input: {
	appDb: D1Database
	userId: string
}) {
	await runD1WithRetry(() =>
		input.appDb
			.prepare(
				`UPDATE org_audit_outbox
				 SET payload_json = json_set(payload_json, '$.actorUserId', 'deleted-user')
				 WHERE json_extract(payload_json, '$.actorUserId') = ?`,
			)
			.bind(input.userId)
			.run(),
	)
}

export async function enqueueOrgAuditOutbox(
	writer: OrgAuditWriter,
	event: OrgAuditOutboxEvent,
): Promise<OrgAuditOutboxPlan> {
	const plan = planOrgAuditOutbox(writer, event)
	await runD1WithRetry(() =>
		orgAuditOutboxInsertStatement(writer.appDb, plan).run(),
	)
	return plan
}

export async function commitOrgAuditOutbox(
	writer: OrgAuditWriter,
	plan: OrgAuditOutboxPlan,
) {
	await tryDeliverOrgAuditOutboxPlan(writer, plan)
}

const drainBatchSize = 50
const drainTimeBudgetMs = 10_000

export async function drainOrgAuditOutbox(input: {
	env: Pick<Env, 'APP_DB' | 'AUDIT_DB'> & Partial<Env>
	now?: Date
	clock?: () => number
	limit?: number
}) {
	const auditDb = input.env.AUDIT_DB
	const clock = input.clock ?? Date.now
	const writer: OrgAuditWriter | null = auditDb
		? {
				appDb: input.env.APP_DB,
				db: auditDb,
				actorUserId: null,
				actorUsername: null,
				credentialKind: null,
				credentialId: null,
				// A row the drain delivers still emits its resource change event.
				env: input.env as Env,
			}
		: null
	const drain = orgAuditOutboxDrainState.provide({
		actors: {
			readClock: createAsyncLogic<number>({ run: async () => clock() }),
			listBatch: createAsyncLogic<
				Array<OrgAuditOutboxDrainRow>,
				{ cursor: { createdAt: string; id: string } | null; batchLimit: number }
			>({
				run: async ({ input: { cursor, batchLimit } }) => {
					const rows = cursor
						? await input.env.APP_DB.prepare(
								`SELECT id, payload_json, created_at
					 FROM org_audit_outbox
					 WHERE (created_at > ? OR (created_at = ? AND id > ?))
					 ORDER BY created_at ASC, id ASC
					 LIMIT ?`,
							)
								.bind(cursor.createdAt, cursor.createdAt, cursor.id, batchLimit)
								.all<OrgAuditOutboxDrainRow>()
						: await input.env.APP_DB.prepare(
								`SELECT id, payload_json, created_at
					 FROM org_audit_outbox
					 ORDER BY created_at ASC, id ASC
					 LIMIT ?`,
							)
								.bind(batchLimit)
								.all<OrgAuditOutboxDrainRow>()
					return rows.results
				},
			}),
			deliverRow: createAsyncLogic<
				'delivered' | 'not_delivered' | 'invalid_payload',
				OrgAuditOutboxDrainRow
			>({
				run: async ({ input: row }) => {
					const payload = parseOrgAuditOutboxPayload(row.payload_json)
					if (!payload) return 'invalid_payload'
					const ok = await tryDeliverOrgAuditOutboxPlan(writer!, {
						outboxId: row.id,
						payload,
					})
					return ok ? 'delivered' : 'not_delivered'
				},
			}),
			countRemaining: createAsyncLogic<number>({
				run: async () => {
					const remaining = await input.env.APP_DB.prepare(
						`SELECT COUNT(*) AS count FROM org_audit_outbox`,
					).first<{ count: number }>()
					return remaining?.count ?? 0
				},
			}),
		},
	})
	const output = await toPromise(
		createActor(drain, {
			input: {
				auditConfigured: writer !== null,
				deadline: writer ? clock() + drainTimeBudgetMs : 0,
				batchLimit: input.limit ?? drainBatchSize,
			},
		}).start(),
	)
	if (output.status === 'drain_failed') throw output.error
	if (output.status === 'skipped')
		return {
			status: 'skipped' as const,
			reason: output.reason,
			delivered: 0,
			remaining: 0,
			errors: 0,
		}
	return output
}
