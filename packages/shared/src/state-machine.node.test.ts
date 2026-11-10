import { expect, expectTypeOf, test } from 'vitest'
import { setup } from 'xstate'
import {
	canHandle,
	defineStatusEnum,
	finalStatesOf,
	IllegalStateTransitionError,
	isState,
	nextState,
	parseState,
	renderStateMachineMermaid,
	sourcesOf,
	sqlSourcesOf,
	sqlSourceOf,
	sqlStatesOf,
	statesOf,
	type LifecycleStateOf,
} from './state-machine.ts'

test('SQL source subsets preserve explicit CAS order and reject unsupported sources', () => {
	const machine = setup({
		types: { events: {} as { type: 'COMPLETE' } },
	}).createMachine({
		id: 'subset.lifecycle',
		initial: 'pending',
		states: {
			pending: { on: { COMPLETE: 'done' } },
			retry: { on: { COMPLETE: 'done' } },
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
		types: { events: {} as { type: 'SUBMIT'; allowed: boolean } },
	}).createMachine({
		id: 'payload.lifecycle',
		initial: 'pending',
		states: {
			pending: {
				on: { SUBMIT: { target: 'done', guard: ({ event }) => event.allowed } },
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
		types: {
			events: {} as { type: 'COMPLETE' } | { type: 'HEARTBEAT' },
		},
	}).createMachine({
		id: 'example.lifecycle',
		initial: 'pending',
		states: {
			pending: { on: { COMPLETE: 'done', HEARTBEAT: 'pending' } },
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
		types: {
			context: {} as { allowed: boolean },
			events: {} as { type: 'SUBMIT'; amount: number } | { type: 'CHECK' },
		},
	}).createMachine({
		id: 'guarded.lifecycle',
		context: { allowed: true },
		initial: 'pending',
		states: {
			pending: {
				on: {
					SUBMIT: {
						target: 'done',
						guard: ({ context, event }) => context.allowed && event.amount > 0,
						actions: () => {
							effects++
						},
					},
					CHECK: { target: 'pending', guard: ({ context }) => context.allowed },
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
		types: {
			context: {} as { allowed: boolean },
			events: {} as { type: 'GO' },
		},
	}).createMachine({
		id: 'context.lifecycle',
		context: () => ({ allowed: true }),
		initial: 'pending',
		states: {
			pending: {
				on: { GO: { target: 'done', guard: ({ context }) => context.allowed } },
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
		types: { events: {} as { type: 'CLAIM' } | { type: 'RETRY' } },
	}).createMachine({
		id: 'leases',
		initial: 'pending',
		states: {
			pending: { on: { CLAIM: 'running', RETRY: 'needs-retry' } },
			'needs-retry': { on: { CLAIM: 'running' } },
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
		states: { "bad'value": { on: { GO: "bad'value" } } },
	})
	expect(() => sqlSourcesOf(unsafe, 'GO')).toThrow('invalid state identifier')
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
