import { expect, test, vi } from 'vitest'
import {
	createDeepLinkFocus,
	recordHighlightMs,
	revealDeepLinkedRecord,
} from './record-deep-link.ts'

test('a document deep link claims its record once, after the record renders', () => {
	const claim = createDeepLinkFocus()
	expect(claim({ spaNavigated: false, hasTarget: false })).toBe(false)
	expect(claim({ spaNavigated: false, hasTarget: true })).toBe(true)
	expect(claim({ spaNavigated: false, hasTarget: true })).toBe(false)
})

test('client navigation, such as a row click, ends the chance to scroll', () => {
	const claim = createDeepLinkFocus()
	expect(claim({ spaNavigated: true, hasTarget: true })).toBe(false)
	expect(claim({ spaNavigated: false, hasTarget: true })).toBe(false)
})

function fakeWindow(reduceMotion: boolean) {
	const timers: Array<() => void> = []
	return {
		timers,
		win: {
			matchMedia: (query: string) =>
				({
					matches: reduceMotion && query.includes('reduce'),
				}) as MediaQueryList,
			requestAnimationFrame: (callback: FrameRequestCallback) => {
				callback(0)
				return 0
			},
			setTimeout: ((callback: () => void, ms: number) => {
				expect(ms).toBe(recordHighlightMs)
				timers.push(callback)
				return 0
			}) as unknown as typeof setTimeout,
		},
	}
}

function fakeTarget() {
	const attributes = new Map<string, string>()
	return {
		attributes,
		scrollIntoView: vi.fn(),
		setAttribute: (name: string, value: string) => attributes.set(name, value),
		removeAttribute: (name: string) => attributes.delete(name),
	}
}

test('the record scrolls smoothly into view and flashes briefly', () => {
	const { win, timers } = fakeWindow(false)
	const target = fakeTarget()
	revealDeepLinkedRecord(target as unknown as HTMLElement, win)
	expect(target.scrollIntoView).toHaveBeenCalledWith({
		block: 'start',
		behavior: 'smooth',
	})
	expect(target.attributes.get('data-record-highlight')).toBe('true')
	for (const timer of timers) timer()
	expect(target.attributes.has('data-record-highlight')).toBe(false)
})

test('reduced motion jumps to the record instead of animating the scroll', () => {
	const { win } = fakeWindow(true)
	const target = fakeTarget()
	revealDeepLinkedRecord(target as unknown as HTMLElement, win)
	expect(target.scrollIntoView).toHaveBeenCalledWith({
		block: 'start',
		behavior: 'auto',
	})
})
