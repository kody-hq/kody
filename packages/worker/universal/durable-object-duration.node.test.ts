import { expect, test } from 'vitest'
import {
	durationMsToDurableObjectGbSeconds,
	toAdminDurableObjectDuration,
} from './durable-object-duration.ts'

test('durationMsToDurableObjectGbSeconds uses default 128 MB memory', () => {
	expect(durationMsToDurableObjectGbSeconds(1000)).toBe(0.128)
	expect(durationMsToDurableObjectGbSeconds(10_000)).toBe(1.28)
	expect(durationMsToDurableObjectGbSeconds(0)).toBe(0)
	expect(durationMsToDurableObjectGbSeconds(-12)).toBe(0)
	expect(durationMsToDurableObjectGbSeconds(Number.NaN)).toBe(0)
})

test('toAdminDurableObjectDuration converts duration and truncates RPC counts', () => {
	expect(
		toAdminDurableObjectDuration({ durationMs: 10_000, rpcCount: 4.8 }),
	).toEqual({
		gbSeconds: 1.28,
		durationMs: 10_000,
		rpcCount: 4,
		memoryGb: 0.128,
	})
})
