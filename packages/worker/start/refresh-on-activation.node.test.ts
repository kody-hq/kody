import { expect, test, vi } from 'vitest'
import { refreshOnActivation } from './refresh-on-activation.ts'

test('activation bursts coalesce, reconnects during reads refresh afterward, and disposal stops work', async () => {
	vi.useFakeTimers()
	const window = new EventTarget()
	const document = Object.assign(new EventTarget(), {
		visibilityState: 'visible',
	})
	let finish: (() => void) | undefined
	const refresh = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve
			}),
	)
	const onError = vi.fn()
	const dispose = refreshOnActivation({ window, document, refresh, onError })
	try {
		window.dispatchEvent(new Event('focus'))
		await vi.advanceTimersByTimeAsync(10)
		document.dispatchEvent(new Event('visibilitychange'))
		await vi.advanceTimersByTimeAsync(100)
		expect(refresh).toHaveBeenCalledTimes(1)
		window.dispatchEvent(new Event('online'))
		window.dispatchEvent(new Event('focus'))
		await vi.advanceTimersByTimeAsync(100)
		expect(refresh).toHaveBeenCalledTimes(1)
		finish?.()
		await vi.advanceTimersByTimeAsync(100)
		expect(refresh).toHaveBeenCalledTimes(2)
		finish?.()
		await vi.advanceTimersByTimeAsync(100)
		document.visibilityState = 'hidden'
		window.dispatchEvent(new Event('online'))
		document.dispatchEvent(new Event('visibilitychange'))
		await vi.advanceTimersByTimeAsync(100)
		expect(refresh).toHaveBeenCalledTimes(2)
		document.visibilityState = 'visible'
		document.dispatchEvent(new Event('visibilitychange'))
		await vi.advanceTimersByTimeAsync(100)
		expect(refresh).toHaveBeenCalledTimes(3)
		window.dispatchEvent(new Event('online'))
		dispose()
		finish?.()
		window.dispatchEvent(new Event('focus'))
		await vi.advanceTimersByTimeAsync(100)
		expect(refresh).toHaveBeenCalledTimes(3)
		expect(onError).not.toHaveBeenCalled()
	} finally {
		dispose()
		vi.useRealTimers()
	}
})

test('a failed refresh is reported and a later reconnect can retry', async () => {
	vi.useFakeTimers()
	const window = new EventTarget()
	const document = Object.assign(new EventTarget(), {
		visibilityState: 'visible',
	})
	const failure = new Error('Disconnected')
	const refresh = vi
		.fn<() => Promise<void>>()
		.mockRejectedValueOnce(failure)
		.mockResolvedValue(undefined)
	const onError = vi.fn()
	const dispose = refreshOnActivation({ window, document, refresh, onError })
	try {
		window.dispatchEvent(new Event('focus'))
		await vi.advanceTimersByTimeAsync(100)
		expect(onError).toHaveBeenCalledExactlyOnceWith(failure)
		window.dispatchEvent(new Event('online'))
		await vi.advanceTimersByTimeAsync(100)
		expect(refresh).toHaveBeenCalledTimes(2)
		expect(onError).toHaveBeenCalledTimes(1)
	} finally {
		dispose()
		vi.useRealTimers()
	}
})
