import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	forgetInboundMcpConnectionLastUsed,
	listInboundMcpConnectionLastUsed,
	recordInboundMcpConnectionLastUsed,
	shouldSkipInboundMcpConnectionLastUsedTouch,
} from '#worker/inbound-mcp-connection-last-used.ts'
import type { UserMeterEnv } from '#worker/entitlements/user-meter-client.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'

test('inbound MCP last-used debounce, record, list, and forget stay per user and no-op without USER_METER', async () => {
	const nextLastUsedAt = '2026-03-20T12:00:00.000Z'
	const debounceCases: Array<[string | null, boolean]> = [
		[null, false],
		['2026-03-20T11:55:00.000Z', true],
		['2026-03-20T11:54:59.000Z', false],
	]
	expect(
		debounceCases.filter(
			([previousLastUsedAt, want]) =>
				shouldSkipInboundMcpConnectionLastUsedTouch({
					previousLastUsedAt,
					nextLastUsedAt,
				}) !== want,
		),
	).toEqual([])
	expect(() =>
		shouldSkipInboundMcpConnectionLastUsedTouch({
			previousLastUsedAt: '2026-03-20T11:00:00.000Z',
			nextLastUsedAt: 'not-a-date',
		}),
	).toThrow(/ISO datetime/)

	const noMeter = { env: {}, userId: ownerIdFromStored('user-no-meter') }
	await expect(
		recordInboundMcpConnectionLastUsed({ ...noMeter, clientId: 'client-a' }),
	).resolves.toBeUndefined()
	await expect(listInboundMcpConnectionLastUsed(noMeter)).resolves.toEqual(
		new Map(),
	)

	const meter = createInMemoryUserMeterEnv()
	const userId = `user-${crypto.randomUUID()}`
	const otherUserId = `user-${crypto.randomUUID()}`
	const clientId = `https://cursor.com/oauth/${crypto.randomUUID()}/client.json`
	const firstUsedAt = '2026-03-20T12:00:00.000Z'
	const laterUsedAt = '2026-03-20T12:05:01.000Z'
	const record = (forUserId: string, lastUsedAt: string, nowMs?: number) =>
		recordInboundMcpConnectionLastUsed({
			env: meter.env,
			userId: ownerIdFromStored(forUserId),
			clientId,
			lastUsedAt,
			nowMs: nowMs ?? Date.parse(lastUsedAt),
		})
	const list = (forUserId: string) =>
		listInboundMcpConnectionLastUsed({
			env: meter.env,
			userId: ownerIdFromStored(forUserId),
		})

	await record(userId, firstUsedAt)
	await record(
		userId,
		'2026-03-20T12:01:00.000Z',
		Date.parse(firstUsedAt) + 60_000,
	)
	expect(await list(userId)).toEqual(new Map([[clientId, firstUsedAt]]))

	await record(userId, laterUsedAt)
	expect(await list(userId)).toEqual(new Map([[clientId, laterUsedAt]]))

	await record(otherUserId, firstUsedAt)
	expect(await list(otherUserId)).toEqual(new Map([[clientId, firstUsedAt]]))

	await forgetInboundMcpConnectionLastUsed({
		env: meter.env,
		userId: ownerIdFromStored(userId),
		clientId,
	})
	expect(await list(userId)).toEqual(new Map())
	expect(await list(otherUserId)).toEqual(new Map([[clientId, firstUsedAt]]))

	const reusedAt = '2026-03-20T12:02:00.000Z'
	await record(userId, reusedAt)
	expect(await list(userId)).toEqual(new Map([[clientId, reusedAt]]))
})

test('inbound MCP last-used records again after a failed UserMeter touch', async () => {
	const meter = createInMemoryUserMeterEnv()
	const namespace = meter.env.USER_METER
	const userId = `user-${crypto.randomUUID()}`
	const clientId = `https://cursor.com/oauth/${crypto.randomUUID()}/client.json`
	const usedAt = '2026-03-20T12:00:00.000Z'
	let failNextTouch = true
	const failingEnv: UserMeterEnv = {
		USER_METER: {
			idFromName: (name: string) => namespace.idFromName(name),
			get(id: DurableObjectId) {
				const stub = namespace.get(id)
				return {
					...stub,
					async touchInboundConnectionLastUsed(input: {
						clientId: string
						lastUsedAt: string
					}) {
						if (failNextTouch) {
							failNextTouch = false
							throw new Error('meter down')
						}
						return stub.touchInboundConnectionLastUsed(input)
					},
				}
			},
		} as unknown as DurableObjectNamespace,
	}

	const recordFailing = () =>
		recordInboundMcpConnectionLastUsed({
			env: failingEnv,
			userId: ownerIdFromStored(userId),
			clientId,
			lastUsedAt: usedAt,
			nowMs: Date.parse(usedAt),
		})
	await expect(recordFailing()).rejects.toThrow(/meter down/)
	await recordFailing()
	expect(
		await listInboundMcpConnectionLastUsed({
			env: meter.env,
			userId: ownerIdFromStored(userId),
		}),
	).toEqual(new Map([[clientId, usedAt]]))
})
