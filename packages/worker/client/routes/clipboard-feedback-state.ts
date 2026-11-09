import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'
export const clipboardFeedbackState = defineStateMachine({
	name: 'clipboard.ui_feedback',
	description:
		'One clipboard write owns feedback until success or failure; its transient label resets after the feedback interval.',
	initial: 'idle',
	transitions: {
		idle: ['copying'],
		copying: ['copied', 'error'],
		copied: ['copying', 'idle'],
		error: ['copying', 'idle'],
	},
})
export type ClipboardFeedbackState = {
	status: StateOf<typeof clipboardFeedbackState>
}
export type CopyState = Exclude<
	StateOf<typeof clipboardFeedbackState>,
	'copying'
>
