import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const mocks = vi.hoisted(() => ({
	getInboundDueWorkHint: vi.fn(async (): Promise<{ dueAt: string | null }> => {
		throw new Error('Mailbox RPC reset')
	}),
	deferInboundDueOwner: vi.fn(async () => undefined),
}))

vi.mock('./inbound-due-owners.ts', () => ({
	listDueInboundOwners: async () => [
		{ userId: 'user-1', dueAt: '2026-08-03T10:00:00.000Z' },
	],
	deferInboundDueOwner: mocks.deferInboundDueOwner,
	replaceInboundDueOwnerHint: async () => undefined,
}))
vi.mock('./inbound-delivery-reconciliation-authority.ts', () => ({
	reconcileUserStaleInboundDeliveries: async () => ({
		recovered: 1,
		cleaned: 0,
		budgetExhausted: false,
	}),
	pruneUserExpiredInboundDedupePointers: async () => 0,
}))
vi.mock('./inbound-effects.ts', () => ({
	reconcileInboundDeliveryEffectsForUser: async () => ({
		processed: 0,
		errors: 0,
	}),
}))
vi.mock('#worker/account/deletion-state.ts', () => ({
	withAccountWriteLease: (input: { write: () => Promise<unknown> }) =>
		input.write(),
}))
vi.mock('./mailbox-client.ts', () => ({
	mailboxRpc: () => ({ getInboundDueWorkHint: mocks.getInboundDueWorkHint }),
}))

const { sweepStaleInboundDeliveries } =
	await import('./reconcile-inbound-deliveries.ts')

/** APP_DB that reports no system-owner due work. */
const appDb = {
	prepare: () => ({ bind: () => ({ first: async () => null }) }),
} as unknown as D1Database

test('a failed Mailbox hint refresh after a reconciled owner counts that owner once', async () => {
	consoleWarn.mockImplementation(() => {})
	const result = await sweepStaleInboundDeliveries({
		env: { APP_DB: appDb } as Env,
		now: new Date('2026-08-03T12:00:00.000Z'),
	})
	expect(result).toMatchObject({ usersProcessed: 1, recovered: 1, errors: 1 })
	expect(mocks.deferInboundDueOwner).toHaveBeenCalledWith(
		expect.objectContaining({ userId: ownerIdFromStored('user-1') }),
	)
})
