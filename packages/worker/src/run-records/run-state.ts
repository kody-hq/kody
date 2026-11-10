import { defineStatusEnum } from '@kody-internal/shared/state-machine.ts'

export const runTerminalStatuses = ['success', 'error'] as const

export const runState = defineStatusEnum({
	name: 'runs.status',
	description:
		'Runs normally finish with success or error, including finish without begin; non-scheduled replace upserts accept any status, while scheduled ticks fence terminal rewrites.',
	values: ['running', 'success', 'error'],
})

export type RunStatus = (typeof runState.values)[number]

export type RunTerminalStatus = Extract<
	(typeof runState.values)[number],
	(typeof runTerminalStatuses)[number]
>
