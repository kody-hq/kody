import { setup, types } from 'xstate'
export const submissionGateState = setup({
	schemas: { events: { SUBMIT: types<{}>(), SETTLED: types<{}>() } },
}).createMachine({
	id: 'ui.submission_gate',
	description:
		'A synchronous submission fence covers validation, mutation and reconciliation without duplicating Query feedback.',
	initial: 'idle',
	states: {
		idle: { on: { SUBMIT: { target: 'running' } } },
		running: { on: { SETTLED: { target: 'idle' } } },
	},
})
