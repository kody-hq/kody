import { setup, types } from 'xstate'
import {
	resetUi,
	startUi,
	type UiContext,
	type UiEvent,
} from '#client/ui-actor.ts'
export type FlickSample = { t: number; x: number }
export type PointerIntent = Exclude<
	'idle' | 'pending' | 'drag' | 'scroll',
	'idle'
>
export type LandingPointerState =
	| { status: 'idle' }
	| {
			status: PointerIntent
			pointerId: number
			startX: number
			startY: number
			lastX: number
			samples: Array<FlickSample>
	  }

export const landingPointerState = setup({
	schemas: {
		context: types<UiContext<LandingPointerState>>(),
		events: {
			POINTER_DOWN: types<UiEvent<LandingPointerState, 'pending'>>(),
			SAMPLE: types<UiEvent<LandingPointerState, 'pending' | 'drag'>>(),
			DRAG: types<UiEvent<LandingPointerState, 'drag'>>(),
			SCROLL: types<UiEvent<LandingPointerState, 'scroll'>>(),
			MOVE: types<UiEvent<LandingPointerState, 'drag'>>(),
			RELEASE: types<UiEvent<LandingPointerState, 'idle'>>(),
		},
	},
	guards: { currentRequest: (a: unknown, b: unknown) => a === b },
}).createMachine({
	id: 'landing_testimonials.pointer',
	description:
		'One pointer owns a pending gesture until horizontal drag, browser scroll handoff or release; another pointer cannot steal an active gesture.',
	initial: 'idle',
	context: { data: {}, requestId: undefined },
	states: {
		idle: {
			on: {
				POINTER_DOWN: { target: 'pending', context: startUi },
			},
		},
		pending: {
			on: {
				SAMPLE: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { context: { data: event.data } }
				},
				DRAG: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'drag', context: { data: event.data } }
				},
				SCROLL: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'scroll', context: { data: event.data } }
				},
				RELEASE: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'idle', context: resetUi({ event }) }
				},
			},
		},
		drag: {
			on: {
				SAMPLE: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { context: { data: event.data } }
				},
				MOVE: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { context: { data: event.data } }
				},
				RELEASE: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'idle', context: resetUi({ event }) }
				},
			},
		},
		scroll: {
			on: {
				RELEASE: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'idle', context: resetUi({ event }) }
				},
			},
		},
	},
})
