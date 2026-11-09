import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'
export type FlickSample = { t: number; x: number }
export const landingPointerState = defineStateMachine({
	name: 'landing_testimonials.pointer',
	description:
		'One pointer owns a pending gesture until horizontal drag, browser scroll handoff or release; another pointer cannot steal an active gesture.',
	initial: 'idle',
	transitions: {
		idle: ['pending'],
		pending: ['pending', 'drag', 'scroll', 'idle'],
		drag: ['drag', 'idle'],
		scroll: ['idle'],
	},
})
export type PointerIntent = Exclude<StateOf<typeof landingPointerState>, 'idle'>
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
