import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const packageCodemodRunState = defineStateMachine({
	name: 'package_codemod_runs.status',
	description:
		'Codemod runs heartbeat, finish, fail or abandon; failed and abandoned runs resume, while a repeated completed continuation may complete again or fail.',
	initial: 'running',
	transitions: {
		running: ['running', 'completed', 'failed', 'abandoned'],
		completed: ['completed', 'failed'],
		failed: ['running'],
		abandoned: ['running'],
	},
})

export type PackageCodemodRunStatus = StateOf<typeof packageCodemodRunState>
