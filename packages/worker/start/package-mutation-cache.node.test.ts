import { expect, test, vi } from 'vitest'
import {
	MutationObserver,
	QueryObserver,
	QueryClient,
} from '@tanstack/react-query'
import { packageMutationOptions } from './package-mutation-cache.ts'

test.each(['accepted', 'lost response'])(
	'package writes reconcile original actor after unmount: %s',
	async (outcome) => {
		const client = new QueryClient()
		const key = [
			'page',
			'actor-a',
			'loadPackage',
			{ username: 'team', kodyId: 'repo' },
		]
		const other = [
			'page',
			'actor-b',
			'loadPackage',
			{ username: 'team', kodyId: 'repo' },
		]
		const before = {
			kind: 'page',
			data: { ownerPackage: { id: 'pkg', lockedAt: null } },
		}
		client.setQueryData(key, before)
		client.setQueryData(other, before)
		let finish!: (result: { ok: boolean }) => void
		let reject!: (error: Error) => void
		const send = vi.fn(
			(_input: { data: { packageId: string } }) =>
				new Promise<{ ok: boolean }>((yes, no) => {
					finish = yes
					reject = no
				}),
		)
		const observer = new MutationObserver(
			client,
			packageMutationOptions(client, 'actor-a', send, 'package'),
		)
		const unsubscribe = observer.subscribe(() => {})
		const pending = observer.mutate({ packageId: 'pkg' })
		await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
		observer.setOptions(
			packageMutationOptions(client, 'actor-b', send, 'package'),
		)
		unsubscribe()
		if (outcome === 'accepted') {
			finish({ ok: true })
			await pending
		} else {
			reject(new Error('Response lost'))
			await expect(pending).rejects.toThrow('Response lost')
		}
		expect(client.getQueryData(key)).toEqual(before)
		expect(client.getQueryData(other)).toEqual(before)
		expect(client.getQueryState(key)?.isInvalidated).toBe(true)
		expect(client.getQueryState(other)?.isInvalidated).toBe(false)
		client.clear()
	},
)

test('lock stays pending until its active confirming read finishes', async () => {
	const client = new QueryClient()
	const key = [
		'page',
		'actor',
		'loadPackage',
		{ username: 'team', kodyId: 'repo' },
	]
	const before = {
		kind: 'page',
		data: { ownerPackage: { id: 'pkg', lockedAt: null as string | null } },
	}
	client.setQueryData(key, before)
	let finish!: (page: typeof before) => void
	const read = vi.fn(
		() =>
			new Promise<typeof before>((resolve) => {
				finish = resolve
			}),
	)
	const query = new QueryObserver(client, {
		queryKey: key,
		queryFn: read,
		staleTime: Infinity,
	})
	const unsubscribe = query.subscribe(() => {})
	const send = vi.fn(async (_input: { data: { packageId: string } }) => ({
		ok: true,
	}))
	const mutation = new MutationObserver(
		client,
		packageMutationOptions(client, 'actor', send, 'package'),
	)
	const pending = mutation.mutate({ packageId: 'pkg' })
	await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
	expect(mutation.getCurrentResult().isPending).toBe(true)
	finish({
		kind: 'page',
		data: { ownerPackage: { id: 'pkg', lockedAt: '2026-10-15T00:00:00Z' } },
	})
	await pending
	expect(client.getQueryData(key)).toMatchObject({
		data: { ownerPackage: { lockedAt: '2026-10-15T00:00:00Z' } },
	})
	unsubscribe()
	client.clear()
})

test('review-required errors retain the approval URL', async () => {
	const client = new QueryClient()
	const send = vi.fn(async (_input: { data: { packageId: string } }) => ({
		ok: false,
		error: 'Review required',
		approvalUrl: '/@team/repo/approve-capabilities',
	}))
	const mutation = new MutationObserver(
		client,
		packageMutationOptions(client, 'actor', send),
	)
	await expect(mutation.mutate({ packageId: 'pkg' })).rejects.toMatchObject({
		message: 'Review required',
		approvalUrl: '/@team/repo/approve-capabilities',
	})
	client.clear()
})

test('uncertain permission write invalidates related reads without changing permissions optimistically', async () => {
	const client = new QueryClient()
	const keys = [
		'loadPackage',
		'loadPackageFiles',
		'loadProfile',
		'loadCommunity',
	].map((resource) => [
		'page',
		'actor',
		resource,
		{ username: 'team', kodyId: 'repo' },
	])
	const other = ['page', 'other', 'loadCommunity', {}]
	const before = { permission: 'previous' }
	for (const key of [...keys, other]) client.setQueryData(key, before)
	const send = vi.fn(
		async (_input: {
			data: { packageId: string; fingerprint: string }
		}): Promise<{ ok: boolean }> => {
			throw new Error('Response lost')
		},
	)
	const mutation = new MutationObserver(
		client,
		packageMutationOptions(client, 'actor', send),
	)
	await expect(
		mutation.mutate({ packageId: 'pkg', fingerprint: 'reviewed' }),
	).rejects.toThrow('Response lost')
	for (const key of keys) {
		expect(client.getQueryState(key)?.isInvalidated).toBe(true)
		expect(client.getQueryData(key)).toEqual(before)
	}
	expect(client.getQueryState(other)?.isInvalidated).toBe(false)
	expect(send).toHaveBeenCalledWith({
		data: { packageId: 'pkg', fingerprint: 'reviewed' },
	})
	client.clear()
})
