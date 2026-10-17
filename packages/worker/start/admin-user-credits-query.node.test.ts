import { type AdminCreditWalletSummary } from '#universal/loader-data.ts'
import { MutationObserver, QueryClient } from '@tanstack/react-query'
import { afterEach, expect, test, vi } from 'vitest'
import {
	adminCreditGrantOptions,
	adminCreditWalletQuery,
} from './admin-user-credits-query.ts'

function wallet(balanceMicroUsd: number): AdminCreditWalletSummary {
	return {
		ok: true,
		stableUserId: 'user-a',
		username: 'alice',
		plan: 'pro',
		eligible: true,
		adminCreditsEligible: false,
		unlocked: true,
		balanceMicroUsd,
		recent: [],
	}
}
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('#start/server/admin-controls', () => ({
	readAdminCreditWallet: vi.fn(),
	grantAdminCredits: rpc,
}))
afterEach(() => rpc.mockReset())

test('a grant finishing after selection and observer changes only reconciles the submitted wallet', async () => {
	const client = new QueryClient()
	const first = adminCreditWalletQuery('operator-a', 'user-a').queryKey
	const other = adminCreditWalletQuery('operator-a', 'user-b').queryKey
	const switched = adminCreditWalletQuery('operator-b', 'user-a').queryKey
	for (const key of [first, other, switched])
		client.setQueryData(key, wallet(1))
	let finish!: (response: AdminCreditWalletSummary) => void
	rpc.mockImplementation(
		() =>
			new Promise<AdminCreditWalletSummary>((resolve) => {
				finish = resolve
			}),
	)
	const reconcile = vi.fn(async () => {})
	const observer = new MutationObserver(
		client,
		adminCreditGrantOptions(client, reconcile),
	)
	const stop = observer.subscribe(() => {})
	const pending = observer.mutate({
		actorKey: 'operator-a',
		stableUserId: 'user-a',
		amountCents: 100,
	})
	await vi.waitFor(() => expect(rpc).toHaveBeenCalledOnce())
	stop()
	finish(wallet(2))
	await pending
	expect(client.getQueryData(first)).toEqual(wallet(2))
	expect(client.getQueryData(other)).toEqual(wallet(1))
	expect(client.getQueryData(switched)).toEqual(wallet(1))
	expect(reconcile).toHaveBeenCalledOnce()
	client.clear()
})

test('a lost grant response invalidates the submitted wallet and usage without publishing uncertain data', async () => {
	const client = new QueryClient()
	const key = adminCreditWalletQuery('operator', 'user').queryKey
	client.setQueryData(key, wallet(1))
	rpc.mockRejectedValue(new Error('Connection lost'))
	const reconcile = vi.fn(async () => {})
	const observer = new MutationObserver(
		client,
		adminCreditGrantOptions(client, reconcile),
	)
	await expect(
		observer.mutate({
			actorKey: 'operator',
			stableUserId: 'user',
			amountCents: 100,
		}),
	).rejects.toThrow('Connection lost')
	expect(client.getQueryState(key)?.isInvalidated).toBe(true)
	expect(reconcile).toHaveBeenCalledOnce()
	client.clear()
})
