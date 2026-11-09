import { expect, test } from 'vitest'
import { createStateMachineStore } from '#client/state-machine-store.ts'
import {
	landingPointerState,
	type LandingPointerState,
} from './landing-pointer-state.ts'
test('testimonial pointer gesture pins axis locking and browser handoff', () => {
	expect(landingPointerState.transitions).toEqual({
		idle: ['pending'],
		pending: ['pending', 'drag', 'scroll', 'idle'],
		drag: ['drag', 'idle'],
		scroll: ['idle'],
	})
	expect(landingPointerState.initial).toEqual(['idle'])
})
test('released gestures carry no stale coordinates and a locked drag cannot become a scroll', () => {
	const store = createStateMachineStore<LandingPointerState>(
		landingPointerState,
		{ status: 'idle' },
	)
	const data = { pointerId: 1, startX: 0, startY: 0, lastX: 1, samples: [] }
	expect(store.transition({ status: 'pending', ...data })).toBe(true)
	expect(store.transition({ status: 'drag', ...data })).toBe(true)
	expect(store.transition({ status: 'scroll', ...data })).toBe(false)
	expect(store.transition({ status: 'idle' })).toBe(true)
	expect(store.getSnapshot()).toEqual({ status: 'idle' })
	expect(store.transition({ status: 'pending', ...data })).toBe(true)
	expect(store.transition({ status: 'scroll', ...data })).toBe(true)
	expect(store.transition({ status: 'idle' })).toBe(true)
})
