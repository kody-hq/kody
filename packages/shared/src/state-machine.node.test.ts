import { expect, expectTypeOf, test } from 'vitest'
import { setup } from 'xstate'
import {
	canHandle,
	defineStateMachine,
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

function example() {
	return defineStateMachine({
		name: 'example.status',
		description: 'An example lifecycle.',
		initial: 'pending',
		transitions: { pending: ['done'], done: [] },
	})
}

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

test('guards validate every explicit source-to-target pair', () => {
	const machine = defineStateMachine({
		name: 'guard.status',
		description: '',
		initial: ['pending', 'needs_retry'],
		transitions: {
			pending: ['approved', 'denied'],
			needs_retry: ['approved', 'denied'],
			approved: [],
			denied: [],
		},
	})
	expect(machine.guard({ from: 'pending', to: ['approved', 'denied'] })).toBe(
		"('pending')",
	)
	expect(
		machine.guard({ from: ['pending', 'needs_retry'], to: 'approved' }),
	).toBe("('pending', 'needs_retry')")
	expect(
		machine.guard({
			from: ['pending', 'needs_retry'],
			to: ['approved', 'denied'],
		}),
	).toBe("('pending', 'needs_retry')")
	expect(() =>
		machine.guard({ from: ['pending', 'approved'], to: 'denied' }),
	).toThrow(IllegalStateTransitionError)
	expect(() =>
		machine.guard({ from: 'pending', to: ['approved', 'needs_retry'] }),
	).toThrow(IllegalStateTransitionError)
	expect(() => machine.guard({ from: [], to: 'approved' })).toThrow('nonempty')
	expect(() => machine.guard({ from: 'pending', to: [] })).toThrow('nonempty')
	expect(() =>
		machine.guard({ from: 'missing' as 'pending', to: 'approved' }),
	).toThrow('guard.status')
	expect(() =>
		machine.guard({ from: 'pending', to: 'missing' as 'approved' }),
	).toThrow('guard.status')
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

test('validates membership, transitions, terminals and SQL without side effects', () => {
	const machine = example()
	expect(machine.is('pending')).toBe(true)
	expect(machine.is(null)).toBe(false)
	expect(machine.is('missing')).toBe(false)
	expect(machine.parse('done')).toBe('done')
	expect(() => machine.parse('missing')).toThrow(
		'example.status: expected one of pending, done',
	)
	expect(machine.can('pending', 'done')).toBe(true)
	expect(machine.can('done', 'pending')).toBe(false)
	expect(() => machine.assert('pending', 'done')).not.toThrow()
	try {
		machine.assert('done', 'pending')
	} catch (error) {
		expect(error).toBeInstanceOf(IllegalStateTransitionError)
		expect(error).toMatchObject({
			name: 'IllegalStateTransitionError',
			machine: 'example.status',
			from: 'done',
			to: 'pending',
		})
	}
	expect(machine.sourcesOf('done')).toEqual(['pending'])
	expect(machine.sourcesOf('pending')).toEqual([])
	expect(machine.isTerminal('done')).toBe(true)
	expect(machine.isTerminal('pending')).toBe(false)
	expect(machine.sql(machine.states)).toBe("('pending', 'done')")
	expect(machine.sql([])).toBe('()')
	expect(() => machine.sql(['injected' as 'done'])).toThrow('example.status')
	expect(renderStateMachineMermaid(machine)).toBe(
		'stateDiagram-v2\n    [*] --> pending\n    pending --> done\n    done --> [*]',
	)
	expect(Object.isFrozen(machine)).toBe(true)
	expect(Object.isFrozen(machine.states)).toBe(true)
	expect(Object.isFrozen(machine.initial)).toBe(true)
	expect(Object.isFrozen(machine.terminal)).toBe(true)
	expect(Object.isFrozen(machine.transitions)).toBe(true)
	expect(Object.isFrozen(machine.transitions.pending)).toBe(true)
})

test('accepts existing hyphenated states without admitting SQL metacharacters', () => {
	const machine = defineStateMachine({
		name: 'email.state',
		description: '',
		initial: 'cleaning',
		transitions: {
			cleaning: ['orphan-cleaned'],
			'orphan-cleaned': ['cleaning'],
		},
	})
	expect(machine.parse('orphan-cleaned')).toBe('orphan-cleaned')
	expect(machine.guard({ from: 'cleaning', to: 'orphan-cleaned' })).toBe(
		"('cleaning')",
	)
	expect(machine.sql(['orphan-cleaned'])).toBe("('orphan-cleaned')")
	for (const state of [
		"bad'value",
		'bad value',
		'bad;value',
		'bad/value',
		'-bad',
	]) {
		expect(() =>
			defineStateMachine<string>({
				name: 'unsafe',
				description: '',
				initial: state,
				transitions: { [state]: [] },
			}),
		).toThrow('invalid state identifier')
	}
})

test('rejects malformed definitions at module initialization', () => {
	expect(() =>
		defineStateMachine({
			name: 'empty',
			description: '',
			initial: [],
			transitions: {},
		}),
	).toThrow('no states')
	expect(() =>
		defineStateMachine({
			name: 'unknown',
			description: '',
			initial: 'pending',
			transitions: { pending: ['missing' as 'pending'] },
		}),
	).toThrow('unknown')
	expect(() =>
		defineStateMachine({
			name: 'initial',
			description: '',
			initial: 'missing' as 'pending',
			transitions: { pending: [] },
		}),
	).toThrow('initial')
	expect(() =>
		defineStateMachine<'pending' | 'done'>({
			name: 'unreachable',
			description: '',
			initial: 'pending',
			transitions: { pending: [], done: [] },
		}),
	).toThrow('unreachable state done')
	expect(() =>
		defineStateMachine({
			name: 'unsafe',
			description: '',
			initial: 'Bad',
			transitions: { Bad: [] },
		}),
	).toThrow('invalid state identifier')
	expect(() =>
		defineStateMachine({
			name: 'no initial',
			description: '',
			initial: [],
			transitions: { pending: [] },
		}),
	).toThrow('unreachable')
})

test('renders hyphenated states with collision-free Mermaid aliases', () => {
	const machine = defineStateMachine({
		name: 'hyphenated',
		description: '',
		initial: ['needs-retry', 'state_0'],
		transitions: {
			'needs-retry': ['state_0', 'orphan-cleaned'],
			state_0: [],
			'orphan-cleaned': [],
		},
	})
	expect(renderStateMachineMermaid(machine)).toBe(
		[
			'stateDiagram-v2',
			'    state "needs-retry" as __state_0',
			'    state "orphan-cleaned" as __state_2',
			'    [*] --> __state_0',
			'    [*] --> state_0',
			'    __state_0 --> state_0',
			'    __state_0 --> __state_2',
			'    state_0 --> [*]',
			'    __state_2 --> [*]',
		].join('\n'),
	)
})

test('copies input arrays and supports multiple initial states and cycles', () => {
	const targets: Array<'a' | 'b'> = ['b']
	const machine = defineStateMachine({
		name: 'cycle',
		description: '',
		initial: ['a', 'b'],
		transitions: { a: targets, b: ['a'] },
	})
	targets.length = 0
	expect(machine.can('a', 'b')).toBe(true)
	expect(machine.terminal).toEqual([])
	expect(machine.initial).toEqual(['a', 'b'])
})
