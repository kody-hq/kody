import { afterEach, expect, test, vi } from 'vitest'
import { createTouchHold } from './touch-hold.ts'

afterEach(() => vi.useRealTimers())

test('a stationary long press opens once, while a quick tap does not', () => {
	vi.useFakeTimers()
	const hold = createTouchHold()
	const open = vi.fn()
	hold.start(1, 10, 10, open)
	vi.advanceTimersByTime(549)
	expect(open).not.toHaveBeenCalled()
	hold.cancel()
	vi.advanceTimersByTime(1000)
	expect(open).not.toHaveBeenCalled()
	hold.start(1, 10, 10, open)
	vi.advanceTimersByTime(550)
	expect(open).toHaveBeenCalledTimes(1)
	vi.advanceTimersByTime(1000)
	expect(open).toHaveBeenCalledTimes(1)
})

test('scrolling, a second pointer, and cancellation cannot leave a pending menu', () => {
	vi.useFakeTimers()
	const hold = createTouchHold()
	const open = vi.fn()
	hold.start(1, 10, 10, open)
	hold.move(1, 10, 21)
	vi.advanceTimersByTime(1000)
	expect(open).not.toHaveBeenCalled()
	hold.start(1, 10, 10, open)
	hold.move(2, 10, 10)
	vi.advanceTimersByTime(1000)
	expect(open).not.toHaveBeenCalled()
	hold.start(1, 10, 10, open)
	hold.cancel()
	vi.advanceTimersByTime(1000)
	expect(open).not.toHaveBeenCalled()
})
