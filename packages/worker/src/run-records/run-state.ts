import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const runTerminalStatuses = ['success', 'error'] as const
const statuses = ['running', ...runTerminalStatuses] as const
const transitions = { running: statuses, success: statuses, error: statuses }

export const runState = defineStateMachine({
	name: 'runs.status',
	description:
		'Runs normally finish with success or error, including finish without begin; non-scheduled replace upserts accept any status, while scheduled ticks fence terminal rewrites.',
	initial: statuses,
	transitions,
})

export type RunStatus = StateOf<typeof runState>

export type RunTerminalStatus = Extract<
	StateOf<typeof runState>,
	(typeof runTerminalStatuses)[number]
>
