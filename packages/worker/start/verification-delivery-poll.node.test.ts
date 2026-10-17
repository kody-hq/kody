import { afterEach, expect, test, vi } from 'vitest'
import { createVerificationDeliveryPoll } from './verification-delivery-poll.ts'

afterEach(() => vi.useRealTimers())

test('resend or leaving the page prevents a stale delivery response from applying', async () => {
	const poll = createVerificationDeliveryPoll()
	let resolve!: (value: string) => void
	let signal!: AbortSignal
	const old = poll.read((input) => {
		signal = input
		return new Promise<string>((done) => {
			resolve = done
		})
	})
	poll.invalidate()
	expect(signal.aborted).toBe(true)
	resolve('previous delivery failed')
	expect(await old).toEqual({ current: false })
	expect(await poll.read(async () => 'new delivery accepted')).toEqual({
		current: true,
		value: 'new delivery accepted',
	})
})

test('a poll times out at ten seconds and a later poll can still read verification', async () => {
	vi.useFakeTimers()
	const poll = createVerificationDeliveryPoll()
	const timed = poll.read(
		(signal) =>
			new Promise<string>((resolve) =>
				signal.addEventListener('abort', () => resolve('late response')),
			),
	)
	await vi.advanceTimersByTimeAsync(10_000)
	expect(await timed).toEqual({ current: false })
	expect(await poll.read(async () => 'verified')).toEqual({
		current: true,
		value: 'verified',
	})
	expect(vi.getTimerCount()).toBe(0)
})
