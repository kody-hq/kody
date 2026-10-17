import { QueryClient, MutationObserver } from '@tanstack/react-query'
import { expect, test, vi } from 'vitest'
import { avatarMutationOptions } from './account-avatar-query.ts'
import { type updateAvatar } from '#start/server/account-mutations'

test('avatar completion after unmount updates only submitted actor avatar, preserving newer profile edits', async () => {
	const client = new QueryClient()
	const key = ['page', 'a', 'loadAccountPage', '/account']
	const other = ['page', 'b', 'loadAccountPage', '/account']
	const original = {
		payloads: {
			accountProfile: { displayName: 'Newer name', avatarUrl: 'old.png' },
		},
	}
	client.setQueryData(key, original)
	client.setQueryData(other, original)
	let finish!: (value: Awaited<ReturnType<typeof updateAvatar>>) => void
	let started!: () => void
	const ready = new Promise<void>((resolve) => {
		started = resolve
	})
	const observer = new MutationObserver(
		client,
		avatarMutationOptions(client, () => {
			started()
			return new Promise((resolve) => {
				finish = resolve
			})
		}),
	)
	const unsubscribe = observer.subscribe(() => {})
	const pending = observer.mutate({
		actorKey: 'a',
		href: '/account',
		username: 'alice',
	})
	await ready
	unsubscribe()
	finish({
		ok: true,
		avatarUrl: 'new.png',
	})
	await pending
	expect(client.getQueryData(key)).toEqual({
		payloads: {
			accountProfile: { displayName: 'Newer name', avatarUrl: 'new.png' },
		},
	})
	expect(client.getQueryData(other)).toEqual(original)
	client.clear()
})

test('uncertain avatar response invalidates account, public profile and shell for submitted actor', async () => {
	const client = new QueryClient()
	const keys = [
		['page', 'a', 'loadAccountPage', '/account'],
		['page', 'a', 'loadProfile', { username: 'alice' }],
		['shell', 'a', 'default'],
	]
	for (const key of keys) client.setQueryData(key, {})
	const observer = new MutationObserver(
		client,
		avatarMutationOptions(client, async () => {
			throw new Error('Disconnected')
		}),
	)
	await expect(
		observer.mutate({ actorKey: 'a', href: '/account', username: 'alice' }),
	).rejects.toThrow('Disconnected')
	for (const key of keys)
		expect(client.getQueryState(key)?.isInvalidated).toBe(true)
	client.clear()
})

for (const readBeforeWrite of [true, false]) {
	test.each(['accepted', 'lost reply'] as const)(
		`avatar preserves first navigation, read before write: ${readBeforeWrite}, %s`,
		async (outcome) => {
			const client = new QueryClient({
				defaultOptions: { queries: { retry: false } },
			})
			const key = ['page', 'a', 'loadAccountPage', {}]
			const other = ['page', 'b', 'loadAccountPage', {}]
			const otherProfile = ['page', 'a', 'loadProfile', { username: 'bob' }]
			const old = {
				payloads: {
					accountProfile: { displayName: 'Current name', avatarUrl: 'old.png' },
				},
			}
			const current = {
				payloads: {
					accountProfile: { displayName: 'Current name', avatarUrl: 'new.png' },
				},
			}
			client.setQueryData(other, old)
			client.setQueryData(otherProfile, old)
			let finishRead!: (data: typeof old) => void
			let finishWrite!: (data: Awaited<ReturnType<typeof updateAvatar>>) => void
			let failWrite!: (error: Error) => void
			let reads = 0
			const observer = new MutationObserver(
				client,
				avatarMutationOptions(
					client,
					() =>
						new Promise((resolve, reject) => {
							finishWrite = resolve
							failWrite = reject
						}),
				),
			)
			const write = observer
				.mutate({ actorKey: 'a', href: '/account', username: 'alice' })
				.catch(() => undefined)
			await vi.waitFor(() => expect(finishWrite).toBeDefined())
			const navigation = client.ensureQueryData({
				queryKey: key,
				queryFn: () =>
					++reads === 1
						? new Promise<typeof old>((resolve) => {
								finishRead = resolve
							})
						: Promise.resolve(current),
				staleTime: Infinity,
			})
			await vi.waitFor(() => expect(finishRead).toBeDefined())
			if (readBeforeWrite) {
				finishRead(old)
				await expect(navigation).resolves.toEqual(old)
			}
			if (outcome === 'accepted')
				finishWrite({ ok: true, avatarUrl: 'new.png' })
			else failWrite(new Error('Lost reply after commit'))
			if (!readBeforeWrite) {
				await Promise.resolve()
				expect(observer.getCurrentResult().isPending).toBe(true)
				finishRead(old)
				await expect(navigation).resolves.toEqual(old)
			}
			await write
			expect(reads).toBe(2)
			expect(client.getQueryData(key)).toEqual(current)
			expect(client.getQueryState(other)?.isInvalidated).toBe(false)
			expect(client.getQueryState(otherProfile)?.isInvalidated).toBe(false)
			client.clear()
		},
	)
}
