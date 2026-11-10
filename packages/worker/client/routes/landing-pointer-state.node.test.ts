import { uiState, uiContext, sendUiEvent } from '#client/ui-actor.ts'
import { createActor } from 'xstate'
import { expect, test } from 'vitest'
import {
	landingPointerState,
	type LandingPointerState,
} from './landing-pointer-state.ts'
test('testimonial pointer gesture pins axis locking and browser handoff', () => {
	expect([...landingPointerState.events].sort()).toEqual([
		'DRAG',
		'MOVE',
		'POINTER_DOWN',
		'RELEASE',
		'SAMPLE',
		'SCROLL',
	])
	expect(
		landingPointerState.root.initial.target?.map((state) => state.key),
	).toEqual(['idle'])
})
test('released gestures carry no stale coordinates and a locked drag cannot become a scroll', () => {
	const store = createActor(landingPointerState, {
		snapshot: (() => {
			const initialView = { status: 'idle' }
			return landingPointerState.resolveState({
				value: initialView.status,
				context: uiContext(initialView),
			})
		})(),
	}).start()
	const data = { pointerId: 1, startX: 0, startY: 0, lastX: 1, samples: [] }
	expect(
		sendUiEvent(store, {
			...({
				type: 'POINTER_DOWN',
				data: uiContext({ status: 'pending', ...data }).data,
			} as Parameters<typeof store.send>[0]),
			requestId: 1,
		}),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			...({
				type: 'DRAG',
				data: uiContext({ status: 'drag', ...data }).data,
			} as Parameters<typeof store.send>[0]),
			requestId: 1,
		}),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			...({
				type: 'SCROLL',
				data: uiContext({ status: 'scroll', ...data }).data,
			} as Parameters<typeof store.send>[0]),
			requestId: 1,
		}),
	).toBe(false)
	expect(
		sendUiEvent(store, {
			...({
				type: 'RELEASE',
				data: uiContext({ status: 'idle' }).data,
			} as Parameters<typeof store.send>[0]),
			requestId: 1,
		}),
	).toBe(true)
	expect(uiState<LandingPointerState>(store.getSnapshot())).toEqual({
		status: 'idle',
	})
	expect(
		sendUiEvent(store, {
			...({
				type: 'POINTER_DOWN',
				data: uiContext({ status: 'pending', ...data }).data,
			} as Parameters<typeof store.send>[0]),
			requestId: 1,
		}),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			...({
				type: 'SCROLL',
				data: uiContext({ status: 'scroll', ...data }).data,
			} as Parameters<typeof store.send>[0]),
			requestId: 1,
		}),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			...({
				type: 'RELEASE',
				data: uiContext({ status: 'idle' }).data,
			} as Parameters<typeof store.send>[0]),
			requestId: 1,
		}),
	).toBe(true)
})
