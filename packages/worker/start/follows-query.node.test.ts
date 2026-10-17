import { MutationObserver, QueryClient } from '@tanstack/react-query'
import { expect, test, vi } from 'vitest'
vi.mock('#start/server/follows', () => ({
	loadOrgFollows: vi.fn(),
	loadPackageFollow: vi.fn(),
}))
import { followsKeys, followMutationOptions } from './follows-query.ts'

test.each([false, true])(
	'settlement reconciles captured workspace and viewer target states, lost response=%s',
	async (lostResponse) => {
		const client = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		})
		const team = followsKeys.org('alice', 'team')
		const other = followsKeys.org('alice', 'other')
		const bob = followsKeys.org('bob', 'team')
		const target = followsKeys.target('alice', {
			username: 'owner',
			kodyId: 'repo',
		})
		for (const key of [team, other, bob, target])
			client.setQueryData(key, { old: true })
		let finish!: () => void
		const operation = new Promise<void>((resolve) => {
			finish = resolve
		})
		const mutation = new MutationObserver(
			client,
			followMutationOptions(
				client,
				'alice',
				async (_input: { orgSlug: string }) => {
					await operation
					if (lostResponse) throw new Error('Response lost')
					return { ok: true }
				},
			),
		)
		const pending = mutation.mutate({ orgSlug: 'team' }).catch((error) => error)
		await Promise.resolve()
		mutation.setOptions(
			followMutationOptions(
				client,
				'bob',
				async (_input: { orgSlug: string }) => ({ ok: true }),
			),
		)
		finish()
		await pending
		expect(client.getQueryState(team)?.isInvalidated).toBe(true)
		expect(client.getQueryState(target)?.isInvalidated).toBe(true)
		expect(client.getQueryState(other)?.isInvalidated).toBe(false)
		expect(client.getQueryState(bob)?.isInvalidated).toBe(false)
		client.clear()
	},
)

test('uncached navigation keeps its first promise then gets a confirming read after settlement', async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	})
	const key = followsKeys.org('alice', 'team')
	let finish!: () => void
	const first = new Promise<string>((resolve) => {
		finish = () => resolve('old')
	})
	const read = vi
		.fn()
		.mockImplementationOnce(() => first)
		.mockResolvedValue('new')
	const navigation = client.fetchQuery({ queryKey: key, queryFn: read })
	const mutation = new MutationObserver(
		client,
		followMutationOptions(
			client,
			'alice',
			async (_input: { orgSlug: string }) => ({ ok: true }),
		),
	)
	const pending = mutation.mutate({ orgSlug: 'team' })
	await Promise.resolve()
	finish()
	await expect(navigation).resolves.toBe('old')
	await pending
	expect(read).toHaveBeenCalledTimes(2)
	expect(client.getQueryData(key)).toBe('new')
	client.clear()
})

test.each([false, true])(
	'confirms an inactive navigation that completed before write settlement, lost=%s',
	async (lost) => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		})
		let finish!: () => void
		const mutation = new MutationObserver(
			client,
			followMutationOptions(
				client,
				'alice',
				async (_input: { orgSlug: string }) => {
					await new Promise<void>((resolve) => {
						finish = resolve
					})
					if (lost) throw new Error('Lost response')
					return { ok: true }
				},
			),
		)
		const write = mutation.mutate({ orgSlug: 'team' }).catch(() => undefined)
		await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
		const key = followsKeys.org('alice', 'team')
		const read = vi.fn().mockResolvedValueOnce('old').mockResolvedValue('new')
		await expect(
			client.fetchQuery({ queryKey: key, queryFn: read }),
		).resolves.toBe('old')
		expect(mutation.getCurrentResult().isPending).toBe(true)
		const otherOrg = followsKeys.org('alice', 'other')
		const otherActor = followsKeys.org('bob', 'team')
		const unrelatedRead = vi.fn().mockResolvedValue('unchanged')
		await client.fetchQuery({ queryKey: otherOrg, queryFn: unrelatedRead })
		await client.fetchQuery({ queryKey: otherActor, queryFn: unrelatedRead })
		finish()
		await write
		expect(read).toHaveBeenCalledTimes(2)
		expect(client.getQueryData(key)).toBe('new')
		expect(unrelatedRead).toHaveBeenCalledTimes(2)
		expect(client.getQueryState(otherOrg)?.isInvalidated).toBe(false)
		expect(client.getQueryState(otherActor)?.isInvalidated).toBe(false)
		client.clear()
	},
)
