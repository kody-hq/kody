import { setup } from 'xstate'
export const submissionGateState = setup({
	types: {
		events: {} as { type: 'SUBMIT' } | { type: 'SETTLED' },
	},
}).createMachine({
	id: 'ui.submission_gate',
	description:
		'A synchronous submission fence covers validation, mutation and reconciliation without duplicating Query feedback.',
	initial: 'idle',
	states: {
		idle: { on: { SUBMIT: 'running' } },
		running: { on: { SETTLED: 'idle' } },
	},
})
