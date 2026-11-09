import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'
import type { LiveRunItem } from './admin-codemods-shared.ts'
export const adminCodemodRunState = defineStateMachine({
	name: 'admin_codemods.ui_run',
	description:
		'Paged execution owns its progress and terminal feedback; a requested stop is fenced until the current step and history reconciliation finish.',
	initial: 'idle',
	transitions: {
		idle: ['running'],
		running: ['running', 'stopping', 'complete', 'error'],
		stopping: ['stopping', 'complete', 'error'],
		complete: ['running'],
		error: ['running'],
	},
})
export type RunPhase = Exclude<StateOf<typeof adminCodemodRunState>, 'stopping'>
type RunProgress = {
	runId: string | null
	items: Array<LiveRunItem>
	summary: Record<string, number>
}
export type AdminCodemodRunState =
	| { status: 'idle' }
	| (RunProgress &
			(
				| { status: 'running' | 'stopping' }
				| { status: 'complete' | 'error'; message: string }
			))
