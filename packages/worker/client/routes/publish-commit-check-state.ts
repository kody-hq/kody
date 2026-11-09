import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'
export const publishCommitCheckState = defineStateMachine({
	name: 'package_publish.ui_checks',
	description:
		'Checks are scoped to the selected commit; changing or clearing that commit releases the old result before starting a new attempt.',
	initial: ['idle', 'running'],
	transitions: {
		idle: ['idle', 'running'],
		running: ['idle', 'running', 'passed', 'failed', 'unavailable'],
		passed: ['idle', 'running'],
		failed: ['idle', 'running'],
		unavailable: ['idle', 'running'],
	},
})
type Payloads = {
	idle: {}
	running: {}
	passed: {}
	failed: { failedChecks: Array<{ kind: string; message: string }> }
	unavailable: { error: string }
}
type Status = StateOf<typeof publishCommitCheckState>
export type PublishCommitChecksState = {
	[S in Status]: { status: S } & Payloads[S]
}[Status]
export type PublishCheckAttempt =
	| { status: 'idle' }
	| (Exclude<PublishCommitChecksState, { status: 'idle' }> & { key: string })
