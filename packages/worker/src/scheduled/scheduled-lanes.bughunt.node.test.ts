import { expect, test, vi } from 'vitest'

const pruneUnverifiedAccounts = vi.hoisted(() =>
	vi.fn(async () => {
		throw new Error('D1_ERROR: unverified listing failed')
	}),
)
const pruneExpiredGuestAccounts = vi.hoisted(() =>
	vi.fn(async () => ({ scanned: 1, purged: 1, failed: 0 })),
)
vi.mock('#worker/account/unverified-account-purge.ts', () => ({
	pruneUnverifiedAccounts,
}))
vi.mock('#worker/guest/guest-account-purge.ts', () => ({
	pruneExpiredGuestAccounts,
}))

test('bughunt: an unverified-account purge failure skips the guest account purge in the same lane', async () => {
	const { runScheduledLane } = await import('./scheduled-lanes.ts')
	await runScheduledLane({
		env: {} as Env,
		lane: 'unverified_account_purge',
		scheduledAt: new Date('2026-11-22T10:00:00.000Z'),
	}).catch(() => undefined)
	expect(pruneUnverifiedAccounts).toHaveBeenCalledTimes(1)
	// Guest purge is independent work; it must still run.
	expect(pruneExpiredGuestAccounts).toHaveBeenCalledTimes(1)
})
