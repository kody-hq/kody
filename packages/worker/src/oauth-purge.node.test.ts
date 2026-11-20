import { expect, test, vi } from 'vitest'
import {
	isInvalidOAuthPurgeCursorError,
	listOAuthPurgePage,
	OAuthPurgeCoordinator,
	oauthPurgeContinuationStorageKey,
	type PurgeContinuation,
} from './oauth-purge.ts'
import { createMemoryKvNamespace } from './test-support/memory-kv.ts'

test('OAuth purge restarts invalid cursors and preserves unrelated list errors', async () => {
	const recoveredPage = {
		list_complete: true,
		keys: [{ name: 'grant:user:grant' }],
		cacheStatus: null,
	} satisfies KVNamespaceListResult<unknown>
	const invalidCursorError = new Error('KV LIST failed: 400 Invalid cursor')
	const list = vi
		.fn()
		.mockRejectedValueOnce(invalidCursorError)
		.mockResolvedValueOnce(recoveredPage)
	const kv = { list } as unknown as KVNamespace

	await expect(
		listOAuthPurgePage(kv, {
			prefix: 'grant:',
			cursor: 'expired-cursor',
		}),
	).resolves.toBe(recoveredPage)
	expect(list).toHaveBeenNthCalledWith(1, {
		prefix: 'grant:',
		cursor: 'expired-cursor',
		limit: 50,
	})
	expect(list).toHaveBeenNthCalledWith(2, {
		prefix: 'grant:',
		limit: 50,
	})

	const unrelatedError = new Error('KV LIST failed: upstream connection reset')
	list.mockReset()
	list.mockRejectedValueOnce(unrelatedError)
	await expect(
		listOAuthPurgePage(kv, {
			prefix: 'token:',
			cursor: 'still-present',
		}),
	).rejects.toBe(unrelatedError)
	expect(list).toHaveBeenCalledTimes(1)

	expect(
		isInvalidOAuthPurgeCursorError(
			new Error('KV LIST failed', {
				cause: new Error('cursor expired'),
			}),
		),
	).toBe(true)
})

const stallMs = 4_000

function createPurgeCoordinator(initialKv: Record<string, string>) {
	const { kv, store } = createMemoryKvNamespace(initialKv)
	const stored = new Map<string, unknown>()
	const storage = {
		async get(key: string) {
			return structuredClone(stored.get(key))
		},
		async put(key: string, value: unknown) {
			stored.set(key, structuredClone(value))
		},
	}
	const coordinator = new OAuthPurgeCoordinator(
		{ storage } as unknown as DurableObjectState,
		{ OAUTH_KV: kv } as unknown as Env,
	)
	const continuation = () =>
		stored.get(oauthPurgeContinuationStorageKey) as PurgeContinuation
	return { coordinator, kv, store, continuation }
}

function stallKvCalls(
	kv: KVNamespace,
	method: 'get' | 'delete' | 'list',
	ms = stallMs,
) {
	const original = kv[method].bind(kv) as (...args: Array<unknown>) => unknown
	const spy = vi.spyOn(kv, method).mockImplementation(((
		...args: Array<unknown>
	) => {
		vi.setSystemTime(Date.now() + ms)
		return original(...args)
	}) as never)
	return () => spy.mockRestore()
}

const grantJson = (clientId: string) => JSON.stringify({ clientId })

test('a purge run on stalled KV returns early with its progress saved and the next run resumes', async () => {
	vi.useFakeTimers({ toFake: ['Date'] })
	try {
		const grants = Object.fromEntries(
			Array.from({ length: 20 }, (_, index) => [
				`grant:user:${index.toString().padStart(2, '0')}`,
				grantJson(index === 19 ? 'missing-client' : 'client'),
			]),
		)
		const { coordinator, kv, store, continuation } = createPurgeCoordinator({
			'client:client': grantJson('client'),
			...grants,
			'token:user:19:a': JSON.stringify({ userId: 'user', grantId: '19' }),
		})
		const scheduledAt = Date.parse('2026-11-20T18:05:00.000Z')

		const restoreGet = stallKvCalls(kv, 'get')
		const stalled = await coordinator.run({ scheduledAt })
		restoreGet()
		expect(stalled).toMatchObject({
			phase: 'grants',
			checked: 8,
			budgetExhausted: true,
			phaseComplete: false,
		})
		expect(continuation().pendingGrantPage?.unscannedKeys).toEqual(
			Object.keys(grants).slice(8),
		)

		await expect(coordinator.run({ scheduledAt })).resolves.toMatchObject({
			phase: 'tokens',
		})
		await expect(coordinator.run({ scheduledAt })).resolves.toMatchObject({
			phase: 'grants',
			checked: 12,
			grantsPurged: 1,
			tokensPurged: 1,
			budgetExhausted: false,
		})
		expect(store.has('grant:user:19')).toBe(false)
		expect(store.has('token:user:19:a')).toBe(false)
		expect(store.has('grant:user:18')).toBe(true)
		expect(continuation().pendingGrantPage).toBeUndefined()
	} finally {
		vi.useRealTimers()
	}
})

test('a stalled grant revocation keeps its token cursor and finishes on a later run', async () => {
	vi.useFakeTimers({ toFake: ['Date'] })
	try {
		const tokenKeys = Array.from(
			{ length: 20 },
			(_, index) => `token:user:orphan:${index.toString().padStart(2, '0')}`,
		)
		const { coordinator, kv, store, continuation } = createPurgeCoordinator({
			'grant:user:orphan': grantJson('missing-client'),
			...Object.fromEntries(
				tokenKeys.map((key) => [
					key,
					JSON.stringify({ userId: 'user', grantId: 'orphan' }),
				]),
			),
		})
		const scheduledAt = Date.parse('2026-11-20T18:05:00.000Z')

		const restoreDelete = stallKvCalls(kv, 'delete')
		await expect(coordinator.run({ scheduledAt })).resolves.toMatchObject({
			phase: 'grants',
			grantsPurged: 0,
			tokensPurged: 8,
			budgetExhausted: true,
		})
		restoreDelete()
		expect(tokenKeys.filter((key) => store.has(key))).toHaveLength(12)
		expect(continuation().pendingGrantPage?.revocations).toEqual([
			{
				grantKey: 'grant:user:orphan',
				tokenPrefix: 'token:user:orphan:',
				tokenPage: { complete: true, unscannedKeys: tokenKeys.slice(8) },
			},
		])

		await coordinator.run({ scheduledAt })
		await expect(coordinator.run({ scheduledAt })).resolves.toMatchObject({
			phase: 'grants',
			grantsPurged: 1,
			tokensPurged: 12,
		})
		expect(tokenKeys.some((key) => store.has(key))).toBe(false)
		expect(store.has('grant:user:orphan')).toBe(false)
	} finally {
		vi.useRealTimers()
	}
})

test('a slow token listing saves the listed tokens so a later run deletes them without listing again', async () => {
	vi.useFakeTimers({ toFake: ['Date'] })
	try {
		const tokenKeys = ['a', 'b', 'c'].map(
			(suffix) => `token:user:orphan:${suffix}`,
		)
		const { coordinator, kv, store, continuation } = createPurgeCoordinator({
			'grant:user:orphan': grantJson('missing-client'),
			...Object.fromEntries(
				tokenKeys.map((key) => [
					key,
					JSON.stringify({ userId: 'user', grantId: 'orphan' }),
				]),
			),
		})
		const scheduledAt = Date.parse('2026-11-20T18:05:00.000Z')

		const restoreList = stallKvCalls(kv, 'list', 6_000)
		await expect(coordinator.run({ scheduledAt })).resolves.toMatchObject({
			phase: 'grants',
			grantsPurged: 0,
			tokensPurged: 0,
			budgetExhausted: true,
		})
		restoreList()
		expect(continuation().pendingGrantPage?.revocations[0]?.tokenPage).toEqual({
			complete: true,
			unscannedKeys: tokenKeys,
		})

		await coordinator.run({ scheduledAt })
		const listSpy = vi.spyOn(kv, 'list')
		await expect(coordinator.run({ scheduledAt })).resolves.toMatchObject({
			phase: 'grants',
			grantsPurged: 1,
			tokensPurged: 3,
		})
		expect(listSpy).not.toHaveBeenCalled()
		expect(tokenKeys.some((key) => store.has(key))).toBe(false)
		expect(store.has('grant:user:orphan')).toBe(false)
	} finally {
		vi.useRealTimers()
	}
})

test('overlapping purge runs wait for the previous run, even after it fails', async () => {
	const { coordinator, kv } = createPurgeCoordinator({
		'client:client': grantJson('client'),
		'grant:user:a': grantJson('client'),
	})
	let releaseFirstList!: () => void
	const firstListGate = new Promise<void>((resolve) => {
		releaseFirstList = resolve
	})
	const list = kv.list.bind(kv)
	const listSpy = vi
		.spyOn(kv, 'list')
		.mockImplementationOnce(async () => {
			await firstListGate
			throw new Error('KV LIST failed: upstream connection reset')
		})
		.mockImplementation(list as never)
	const scheduledAt = Date.parse('2026-11-20T18:05:00.000Z')

	const first = coordinator.run({ scheduledAt })
	const second = coordinator.run({ scheduledAt })
	await new Promise((resolve) => setTimeout(resolve, 10))
	expect(listSpy).toHaveBeenCalledTimes(1)

	releaseFirstList()
	await expect(first).rejects.toThrow('upstream connection reset')
	await expect(second).resolves.toMatchObject({ phase: 'grants', checked: 1 })
	expect(listSpy).toHaveBeenCalledTimes(2)
})
