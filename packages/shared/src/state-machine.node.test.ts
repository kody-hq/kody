import { expect, test } from 'vitest'
import {
	defineStateMachine,
	IllegalStateTransitionError,
	renderStateMachineMermaid,
} from './state-machine.ts'

function example() {
	return defineStateMachine({
		name: 'example.status',
		description: 'An example lifecycle.',
		initial: 'pending',
		transitions: { pending: ['done'], done: [] },
	})
}

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
