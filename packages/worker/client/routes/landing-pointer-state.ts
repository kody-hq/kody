import { setup, types } from 'xstate'
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
	schemas: {
		context: types<UiContext<LandingPointerState>>(),
		events: {
			POINTER_DOWN: types<{
				data: UiPayload<LandingPointerState, 'pending'>
				requestId?: unknown
			}>(),
			SAMPLE: types<{
				data: UiPayload<LandingPointerState, 'pending' | 'drag'>
				requestId?: unknown
			}>(),
			DRAG: types<{
				data: UiPayload<LandingPointerState, 'drag'>
				requestId?: unknown
			}>(),
			SCROLL: types<{
				data: UiPayload<LandingPointerState, 'scroll'>
				requestId?: unknown
			}>(),
			MOVE: types<{
				data: UiPayload<LandingPointerState, 'drag'>
				requestId?: unknown
			}>(),
			RELEASE: types<{
				data: UiPayload<LandingPointerState, 'idle'>
				requestId?: unknown
			}>(),
		},
	},
}).createMachine({
	id: 'landing_testimonials.pointer',
	description:
		'One pointer owns a pending gesture until horizontal drag, browser scroll handoff or release; another pointer cannot steal an active gesture.',
	initial: 'idle',
	context: { data: {} as UiData<LandingPointerState>, requestId: undefined },
	states: {
		idle: {
			on: {
				POINTER_DOWN: {
					target: 'pending',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
			},
		},
		pending: {
			on: {
				SAMPLE: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<LandingPointerState>
						event: { type: 'SAMPLE' } & {
							data: UiPayload<LandingPointerState, 'pending' | 'drag'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { context: { data: event.data } }
					},
				},
				DRAG: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<LandingPointerState>
						event: { type: 'DRAG' } & {
							data: UiPayload<LandingPointerState, 'drag'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'drag', context: { data: event.data } }
					},
				},
				SCROLL: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<LandingPointerState>
						event: { type: 'SCROLL' } & {
							data: UiPayload<LandingPointerState, 'scroll'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'scroll', context: { data: event.data } }
					},
				},
				RELEASE: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<LandingPointerState>
						event: { type: 'RELEASE' } & {
							data: UiPayload<LandingPointerState, 'idle'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return {
							target: 'idle',
							context: { data: event.data, requestId: undefined },
						}
					},
				},
			},
		},
		drag: {
			on: {
				SAMPLE: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<LandingPointerState>
						event: { type: 'SAMPLE' } & {
							data: UiPayload<LandingPointerState, 'pending' | 'drag'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { context: { data: event.data } }
					},
				},
				MOVE: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<LandingPointerState>
						event: { type: 'MOVE' } & {
							data: UiPayload<LandingPointerState, 'drag'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { context: { data: event.data } }
					},
				},
				RELEASE: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<LandingPointerState>
						event: { type: 'RELEASE' } & {
							data: UiPayload<LandingPointerState, 'idle'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return {
							target: 'idle',
							context: { data: event.data, requestId: undefined },
						}
					},
				},
			},
		},
		scroll: {
			on: {
				RELEASE: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<LandingPointerState>
						event: { type: 'RELEASE' } & {
							data: UiPayload<LandingPointerState, 'idle'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return {
							target: 'idle',
							context: { data: event.data, requestId: undefined },
						}
					},
				},
			},
		},
	},
})
