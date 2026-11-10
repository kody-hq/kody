import { setup, assign } from 'xstate'
import type { UiContext, UiData, UiPayload } from '#client/ui-actor.ts'
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
	types: {
		context: {} as UiContext<LandingPointerState>,
		events: {} as
			| {
					type: 'POINTER_DOWN'
					data: UiPayload<LandingPointerState, 'pending'>
					requestId?: unknown
			  }
			| {
					type: 'SAMPLE'
					data: UiPayload<LandingPointerState, 'pending' | 'drag'>
					requestId?: unknown
			  }
			| {
					type: 'DRAG'
					data: UiPayload<LandingPointerState, 'drag'>
					requestId?: unknown
			  }
			| {
					type: 'SCROLL'
					data: UiPayload<LandingPointerState, 'scroll'>
					requestId?: unknown
			  }
			| {
					type: 'MOVE'
					data: UiPayload<LandingPointerState, 'drag'>
					requestId?: unknown
			  }
			| {
					type: 'RELEASE'
					data: UiPayload<LandingPointerState, 'idle'>
					requestId?: unknown
			  },
	},
	guards: {
		currentRequest: ({ context, event }) =>
			context.requestId === event.requestId,
	},
	actions: {
		update: assign({ data: ({ event }) => event.data }),
		start: assign({
			data: ({ event }) => event.data,
			requestId: ({ event }) => event.requestId,
		}),
		reset: assign({ data: ({ event }) => event.data, requestId: undefined }),
	},
}).createMachine({
	id: 'landing_testimonials.pointer',
	description:
		'One pointer owns a pending gesture until horizontal drag, browser scroll handoff or release; another pointer cannot steal an active gesture.',
	initial: 'idle',
	context: { data: {} as UiData<LandingPointerState>, requestId: undefined },
	states: {
		idle: { on: { POINTER_DOWN: { target: 'pending', actions: 'start' } } },
		pending: {
			on: {
				SAMPLE: { guard: 'currentRequest', actions: 'update' },
				DRAG: { guard: 'currentRequest', target: 'drag', actions: 'update' },
				SCROLL: {
					guard: 'currentRequest',
					target: 'scroll',
					actions: 'update',
				},
				RELEASE: { guard: 'currentRequest', target: 'idle', actions: 'reset' },
			},
		},
		drag: {
			on: {
				SAMPLE: { guard: 'currentRequest', actions: 'update' },
				MOVE: { guard: 'currentRequest', actions: 'update' },
				RELEASE: { guard: 'currentRequest', target: 'idle', actions: 'reset' },
			},
		},
		scroll: {
			on: {
				RELEASE: { guard: 'currentRequest', target: 'idle', actions: 'reset' },
			},
		},
	},
})
