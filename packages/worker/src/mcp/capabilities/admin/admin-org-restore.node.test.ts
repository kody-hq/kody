import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as AuditLog from '#worker/audit-log.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const mocks = vi.hoisted(() => ({
	restoreOrg: vi.fn(),
	logAuditEvent: vi.fn<typeof AuditLog.logAuditEvent>(async () => ({
		persisted: false,
		failedSinks: [],
	})),
}))

vi.mock('#worker/orgs/soft-delete.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#worker/orgs/soft-delete.ts')>()
	return {
		...actual,
		restoreOrg: mocks.restoreOrg,
	}
})

vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		logAuditEvent: mocks.logAuditEvent,
	}
})

const { adminOrgRestoreCapability } = await import('./admin-org-restore.ts')

const orgId = testStableUserIdFromEmail('admin-restore-org@example.com')
const reason = 'Support recovery for a soft-deleted team organization.'

test('adminOrgRestore maps org_restore_race to a caller error', async () => {
	const first = vi
		.fn()
		.mockResolvedValueOnce({
			slug: 'admin-restore-race',
			deleted_at: '2026-10-10T00:00:00.000Z',
		})
		.mockResolvedValueOnce(null)
	const prepare = vi.fn(() => ({
		bind: vi.fn(() => ({ first })),
	}))
	mocks.restoreOrg.mockRejectedValue(new Error('org_restore_race'))
	await expect(
		adminOrgRestoreCapability.handler({ org_id: orgId, reason }, {
			env: { APP_DB: { prepare } } as unknown as Env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://heykody.dev',
				user: {
					userId: personIdFromStored(
						testStableUserIdFromEmail('admin@example.com'),
					),
					email: 'admin@example.com',
					displayName: 'Admin',
					roles: ['admin'],
				},
			}),
		} as never),
	).rejects.toThrow('That organization was already restored. Try again.')
})
