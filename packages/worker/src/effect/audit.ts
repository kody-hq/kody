import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import {
	logOrgAuditEvent,
	type LogOrgAuditEventInput,
} from '#worker/orgs/org-audit.ts'
import { Context, Effect, Layer } from 'effect'
import { outbound, type OutboundCallError } from '#worker/effect/outbound.ts'
import { WorkerEnv } from '#worker/effect/worker-env.ts'

export type AuditEvent = Omit<Parameters<typeof logAuditEvent>[0], 'db'>

export type OrgAuditEvent = Omit<LogOrgAuditEventInput, 'env' | 'db'>

/**
 * The account audit log (`logAuditEvent`) and the org audit log
 * (`org_audit_events`). Both fail with `OutboundCallError`; each lane decides
 * whether a failed write is fatal, logged, or ignored.
 */
export class AuditLog extends Context.Service<
	AuditLog,
	{
		record(event: AuditEvent): Effect.Effect<void, OutboundCallError>
		recordOrg(event: OrgAuditEvent): Effect.Effect<void, OutboundCallError>
	}
>()('kody/effect/AuditLog') {
	static readonly layer = Layer.effect(
		AuditLog,
		Effect.gen(function* () {
			const env = yield* WorkerEnv
			return AuditLog.of({
				record: Effect.fn('AuditLog.record')(function* (event) {
					yield* Effect.annotateCurrentSpan({
						'audit.action': event.action,
						'audit.result': event.result,
					})
					yield* outbound('audit.logAuditEvent', () =>
						logAuditEvent({ db: auditDatabaseFromEnv(env), ...event }),
					)
				}),
				recordOrg: Effect.fn('AuditLog.recordOrg')(function* (event) {
					yield* Effect.annotateCurrentSpan({
						'audit.action': event.action,
						'audit.result': event.result,
					})
					yield* outbound('audit.logOrgAuditEvent', () =>
						logOrgAuditEvent({ env, ...event }),
					)
				}),
			})
		}),
	)
}
