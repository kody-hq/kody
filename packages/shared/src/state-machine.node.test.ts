import { expect, expectTypeOf, test } from 'vitest'
import { setup, types } from 'xstate'
import {
	canHandle,
	defineStatusEnum,
	finalStatesOf,
	IllegalStateTransitionError,
	isState,
	nextState,
	parseState,
	sourcesOf,
	sqlSourcesOf,
	sqlSourceOf,
	sqlStatesOf,
	statesOf,
	type LifecycleStateOf,
	type LifecycleMachine,
} from './state-machine.ts'
import {
	extractMachineGraph,
	renderStateMachineMermaid as renderGraph,
} from '../../../tools/state-machine-graph.ts'

const renderStateMachineMermaid = (machine: LifecycleMachine) =>
	renderGraph(
		extractMachineGraph(
			machine,
			'packages/shared/src/state-machine.node.test.ts',
		),
	)

test('SQL source subsets preserve explicit CAS order and reject unsupported sources', () => {
	const machine = setup({
		schemas: { events: { COMPLETE: types<{}>() } },
	}).createMachine({
		id: 'subset.lifecycle',
		initial: 'pending',
		states: {
			pending: { on: { COMPLETE: { target: 'done' } } },
			retry: { on: { COMPLETE: { target: 'done' } } },
			done: { type: 'final' },
		},
	})
	expect(sqlSourcesOf(machine, 'COMPLETE', ['retry', 'pending'])).toBe(
		"('retry', 'pending')",
	)
	expect(sqlSourcesOf(machine, 'COMPLETE', ['pending'])).toBe("('pending')")
	expect(() => sqlSourcesOf(machine, 'COMPLETE', [])).toThrow('nonempty')
	expect(() => sqlSourcesOf(machine, 'COMPLETE', ['done'])).toThrow(
		IllegalStateTransitionError,
	)
	expect(sqlStatesOf(machine, finalStatesOf(machine))).toBe("('done')")
	expect(sqlStatesOf(machine, [])).toBe('()')
	expect(() => sqlStatesOf(machine, ['unknown' as never])).toThrow(
		'expected one of',
	)
	expect(sqlSourceOf(machine, 'pending', { type: 'COMPLETE' })).toBe(
		"('pending')",
	)
	expect(() => sqlSourceOf(machine, 'done', { type: 'COMPLETE' })).toThrow(
		IllegalStateTransitionError,
	)
})

test('single SQL source validation honors the complete event payload', () => {
	const machine = setup({
		schemas: { events: { SUBMIT: types<{ allowed: boolean }>() } },
		guards: { allowed: (value: boolean) => value },
	}).createMachine({
		id: 'payload.lifecycle',
		initial: 'pending',
		states: {
			pending: {
				on: {
					SUBMIT: ({ event, guards }) => {
						if (!guards.allowed(event.allowed)) return
						return { target: 'done' }
					},
				},
			},
			done: { type: 'final' },
		},
	})
	expect(
		sqlSourceOf(machine, 'pending', { type: 'SUBMIT', allowed: true }),
	).toBe("('pending')")
	expect(() =>
		sqlSourceOf(machine, 'pending', { type: 'SUBMIT', allowed: false }),
	).toThrow(IllegalStateTransitionError)
})

function lifecycle() {
	return setup({
		schemas: { events: { COMPLETE: types<{}>(), HEARTBEAT: types<{}>() } },
	}).createMachine({
		id: 'example.lifecycle',
		initial: 'pending',
		states: {
			pending: {
				on: { COMPLETE: { target: 'done' }, HEARTBEAT: { target: 'pending' } },
			},
			done: { type: 'final' },
		},
	})
}

test('XState helpers preserve typed states, real events and finality', () => {
	const machine = lifecycle()
	expectTypeOf<LifecycleStateOf<typeof machine>>().toEqualTypeOf<
		'pending' | 'done'
	>()
	expectTypeOf(
		nextState(machine, 'pending', { type: 'COMPLETE' }),
	).toEqualTypeOf<'pending' | 'done'>()
	expect(statesOf(machine)).toEqual(['pending', 'done'])
	expect(finalStatesOf(machine)).toEqual(['done'])
	expect(isState(machine, 'pending')).toBe(true)
	for (const value of [null, undefined, '', 'missing', '__proto__']) {
		expect(isState(machine, value)).toBe(false)
		expect(() => parseState(machine, value)).toThrow('example.lifecycle')
	}
	expect(parseState(machine, 'done')).toBe('done')
	expect(nextState(machine, 'pending', { type: 'COMPLETE' })).toBe('done')
	expect(nextState(machine, 'pending', { type: 'HEARTBEAT' })).toBe('pending')
	expect(canHandle(machine, 'pending', 'COMPLETE')).toBe(true)
	expect(canHandle(machine, 'done', 'COMPLETE')).toBe(false)
	expect(() => nextState(machine, 'done', { type: 'COMPLETE' })).toThrow(
		IllegalStateTransitionError,
	)
	try {
		nextState(machine, 'done', { type: 'COMPLETE' })
	} catch (error) {
		expect(error).toMatchObject({
			machine: 'example.lifecycle',
			from: 'done',
			event: 'COMPLETE',
		})
	}
	expect(() =>
		nextState(machine, 'missing' as 'pending', { type: 'COMPLETE' }),
	).toThrow(IllegalStateTransitionError)
	expect(canHandle(machine, 'missing' as 'pending', 'COMPLETE')).toBe(false)
	expect(sourcesOf(machine, 'COMPLETE')).toEqual(['pending'])
	expect(sqlSourcesOf(machine, 'COMPLETE')).toBe("('pending')")
	expect(sourcesOf(machine, 'UNKNOWN' as 'COMPLETE')).toEqual([])
	expect(() => sqlSourcesOf(machine, 'UNKNOWN' as 'COMPLETE')).toThrow(
		'no sources',
	)
	expect(renderStateMachineMermaid(machine)).toBe(
		[
			'stateDiagram-v2',
			'    [*] --> pending',
			'    pending --> done: COMPLETE',
			'    pending --> pending: HEARTBEAT',
			'    done --> [*]',
		].join('\n'),
	)
})

test('transitions honor payload and context guards without executing actions', () => {
	let effects = 0
	const machine = setup({
		schemas: {
			context: types<{ allowed: boolean }>(),
			events: { SUBMIT: types<{ amount: number }>(), CHECK: types<{}>() },
		},
		guards: {
			canSubmit: (allowed: boolean, amount: number) => allowed && amount > 0,
			allowed: (value: boolean) => value,
		},
	}).createMachine({
		id: 'guarded.lifecycle',
		context: { allowed: true },
		initial: 'pending',
		states: {
			pending: {
				on: {
					SUBMIT: ({ context, event, guards }, enq) => {
						if (!guards.canSubmit(context.allowed, event.amount)) return
						enq(() => {
							effects++
						})
						return { target: 'done' }
					},
					CHECK: ({ context, guards }) => {
						if (!guards.allowed(context.allowed)) return
						return { target: 'pending' }
					},
				},
			},
			done: { type: 'final' },
		},
	})
	expect(nextState(machine, 'pending', { type: 'SUBMIT', amount: 1 })).toBe(
		'done',
	)
	expect(effects).toBe(0)
	expect(() =>
		nextState(machine, 'pending', { type: 'SUBMIT', amount: 0 }),
	).toThrow(IllegalStateTransitionError)
	expect(() =>
		nextState(
			machine,
			'pending',
			{ type: 'SUBMIT', amount: 1 },
			{ allowed: false },
		),
	).toThrow(IllegalStateTransitionError)
	expect(canHandle(machine, 'pending', 'CHECK')).toBe(true)
	expect(canHandle(machine, 'pending', 'CHECK', { allowed: false })).toBe(false)
	expect(canHandle(machine, 'pending', 'SUBMIT')).toBe(false)
	expect(sourcesOf(machine, 'SUBMIT')).toEqual(['pending'])
})

test('context initializers require explicit context rather than silently ignoring it', () => {
	const machine = setup({
		schemas: {
			context: types<{ allowed: boolean }>(),
			events: { GO: types<{}>() },
		},
		guards: { allowed: (value: boolean) => value },
	}).createMachine({
		id: 'context.lifecycle',
		context: () => ({ allowed: true }),
		initial: 'pending',
		states: {
			pending: {
				on: {
					GO: ({ context, guards }) => {
						if (!guards.allowed(context.allowed)) return
						return { target: 'done' }
					},
				},
			},
			done: { type: 'final' },
		},
	})
	expect(() => nextState(machine, 'pending', { type: 'GO' })).toThrow(
		'provide context',
	)
	expect(nextState(machine, 'pending', { type: 'GO' }, { allowed: true })).toBe(
		'done',
	)
})

test('SQL sources retain declaration order and validate SQL-safe identifiers', () => {
	const machine = setup({
		schemas: { events: { CLAIM: types<{}>(), RETRY: types<{}>() } },
	}).createMachine({
		id: 'leases',
		initial: 'pending',
		states: {
			pending: {
				on: { CLAIM: { target: 'running' }, RETRY: { target: 'needs-retry' } },
			},
			'needs-retry': { on: { CLAIM: { target: 'running' } } },
			running: { type: 'final' },
		},
	})
	expect(sqlSourcesOf(machine, 'CLAIM')).toBe("('pending', 'needs-retry')")
	expect(renderStateMachineMermaid(machine)).toContain(
		'state "needs-retry" as __state_1',
	)
	expect(renderStateMachineMermaid(machine)).toContain(
		'__state_1 --> running: CLAIM',
	)
	const unsafe = setup({}).createMachine({
		id: 'unsafe',
		initial: "bad'value",
		states: { "bad'value": { on: { GO: { target: "bad'value" } } } },
	})
	expect(() => sqlSourcesOf(unsafe, 'GO')).toThrow('invalid state identifier')
})

test('structural SQL sources never run function guards and exclude empty or forbidden handlers', () => {
	let evaluations = 0
	const machine = setup({
		schemas: { events: { GO: types<{}>() } },
	}).createMachine({
		id: 'structural',
		initial: 'pending',
		states: {
			pending: {
				on: {
					GO: () => {
						evaluations++
						return undefined
					},
				},
			},
			empty: { on: { GO: {} } },
			forbidden: { on: { GO: undefined } },
			context: { on: { GO: { context: {} } } },
			done: { type: 'final' },
		},
	})
	expect(sourcesOf(machine, 'GO')).toEqual(['pending', 'context'])
	expect(sqlSourcesOf(machine, 'GO')).toBe("('pending', 'context')")
	expect(evaluations).toBe(0)
	expect(() => sqlSourcesOf(machine, 'GO', ['empty'])).toThrow(
		IllegalStateTransitionError,
	)
})

test('status enums validate values and SQL without pretending to have edges', () => {
	const input: Array<'active' | 'archived'> = ['active', 'archived']
	const status = defineStatusEnum({
		name: 'status',
		description: 'Replacement field.',
		values: input,
	})
	input.length = 0
	expect(status.values).toEqual(['active', 'archived'])
	expect(status.is('active')).toBe(true)
	expect(status.is(null)).toBe(false)
	expect(status.parse('archived')).toBe('archived')
	expect(() => status.parse('other')).toThrow('status')
	expect(status.sql(status.values)).toBe("('active', 'archived')")
	expect(status.sql([])).toBe('()')
	expect(() => status.sql(['missing' as 'active'])).toThrow('status')
	expect(Object.isFrozen(status)).toBe(true)
	expect(Object.isFrozen(status.values)).toBe(true)
	expect(status).not.toHaveProperty('transitions')
	for (const values of [[], ['active', 'active'], ["bad'value"]])
		expect(() =>
			defineStatusEnum({ name: 'invalid', description: '', values }),
		).toThrow('invalid')
})
