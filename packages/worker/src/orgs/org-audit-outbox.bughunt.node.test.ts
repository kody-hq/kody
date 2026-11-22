import { expect, test, vi } from 'vitest'

const dispatchResourceChangeEvent = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('#worker/resource-events/dispatch.ts', () => ({
	dispatchResourceChangeEvent,
}))

test('bughunt: a failed outbox row delete after the AUDIT_DB insert loses the resource change event for good', async () => {
	const { tryDeliverOrgAuditOutboxPlan, planOrgAuditOutbox } =
		await import('./org-audit-outbox.ts')
	const auditRows = new Set<string>()
	const auditDb = {
		prepare: (sql: string) => ({
			bind: (...values: Array<unknown>) => ({
				run: async () => {
					const id = String(values[0])
					if (auditRows.has(id)) return { meta: { changes: 0 } }
					auditRows.add(id)
					return { meta: { changes: 1 } }
				},
				first: async () =>
					sql.includes('SELECT 1') && auditRows.has(String(values[0]))
						? { ok: 1 }
						: null,
			}),
		}),
	} as unknown as D1Database
	let outboxRow: string | null = null
	let deleteAttempts = 0
	const appDb = {
		prepare: (sql: string) => ({
			bind: () => ({
				first: async () =>
					outboxRow === null ? null : { payload_json: outboxRow },
				run: async () => {
					if (sql.startsWith('DELETE FROM org_audit_outbox')) {
						deleteAttempts += 1
						// Transient, non-retryable APP_DB failure on the first delete.
						if (deleteAttempts === 1) throw new Error('APP_DB unavailable')
						outboxRow = null
					}
					return { meta: { changes: 1 } }
				},
			}),
		}),
	} as unknown as D1Database
	const writer = {
		appDb,
		db: auditDb,
		actorUserId: 'user-1',
		actorUsername: 'user',
		credentialKind: null,
		credentialId: null,
		env: {} as Env,
	}
	const plan = planOrgAuditOutbox(writer, {
		orgId: 'org-1',
		action: 'package.published',
		resourceType: 'package',
		resourceId: 'pkg-1',
	})
	outboxRow = JSON.stringify(plan.payload)

	const first = await tryDeliverOrgAuditOutboxPlan(writer, plan)
	const second = await tryDeliverOrgAuditOutboxPlan(writer, plan)
	await new Promise((resolve) => setTimeout(resolve, 50))

	expect({ first, second, outboxRow, auditRows: auditRows.size }).toEqual({
		first: false,
		second: true,
		outboxRow: null,
		auditRows: 1,
	})
	// The audit row landed and the outbox row is gone, so the change happened;
	// its resource change event must have been emitted exactly once.
	expect(dispatchResourceChangeEvent).toHaveBeenCalledTimes(1)
})
