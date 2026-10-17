import { afterEach, expect, test, vi } from 'vitest'
import {
	consumeAccountCreatedFathomSignal,
	fathomEventNames,
	scheduleConsumeAccountCreatedFathomSignal,
	trackFathomEvent,
} from './fathom-events.ts'

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

function fixture() {
	let href = 'https://kody.codes/onboarding?other=value&accountCreated=1#step'
	const win = {
		get location() {
			return { href }
		},
		fathom: undefined as undefined | { trackEvent: ReturnType<typeof vi.fn> },
		setInterval,
		clearInterval,
	}
	vi.stubGlobal('window', win)
	const replaceHref = vi.fn((next: string) => {
		href = `https://kody.codes${next}`
	})
	return { win, replaceHref }
}

test('accepted analytics delegates cleanup while preserving other query and hash', () => {
	const { win, replaceHref } = fixture()
	expect(trackFathomEvent('account_created')).toBe(false)
	expect(consumeAccountCreatedFathomSignal(replaceHref)).toBe(false)
	expect(replaceHref).not.toHaveBeenCalled()
	const trackEvent = vi.fn()
	win.fathom = { trackEvent }
	expect(trackFathomEvent(fathomEventNames.signupStarted)).toBe(true)
	expect(consumeAccountCreatedFathomSignal(replaceHref)).toBe(true)
	expect(replaceHref).toHaveBeenCalledWith('/onboarding?other=value#step')
	expect(consumeAccountCreatedFathomSignal(replaceHref)).toBe(false)
	expect(trackEvent.mock.calls).toEqual([
		['signup_started'],
		['account_created'],
	])
})

test('failed cleanup and effect remount retry cleanup without sending analytics again', () => {
	const { win, replaceHref } = fixture()
	const trackEvent = vi.fn()
	win.fathom = { trackEvent }
	expect(
		consumeAccountCreatedFathomSignal(() => {
			throw new Error('Navigation failed')
		}),
	).toBe(false)
	const cancel = scheduleConsumeAccountCreatedFathomSignal({ replaceHref })
	cancel()
	expect(trackEvent).toHaveBeenCalledExactlyOnceWith('account_created')
	expect(replaceHref).toHaveBeenCalledWith('/onboarding?other=value#step')
})

test('scheduler retries unavailable analytics and stops after acceptance', () => {
	vi.useFakeTimers()
	const { win, replaceHref } = fixture()
	const cancel = scheduleConsumeAccountCreatedFathomSignal({
		replaceHref,
		intervalMs: 100,
		maxAttempts: 5,
	})
	vi.advanceTimersByTime(100)
	expect(replaceHref).not.toHaveBeenCalled()
	const trackEvent = vi.fn()
	win.fathom = { trackEvent }
	vi.advanceTimersByTime(500)
	expect(trackEvent).toHaveBeenCalledExactlyOnceWith('account_created')
	cancel()
	scheduleConsumeAccountCreatedFathomSignal({ replaceHref })()
	expect(replaceHref).toHaveBeenCalledTimes(1)
})
