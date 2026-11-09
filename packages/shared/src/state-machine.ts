export type StateMachine<S extends string> = {
	readonly name: string
	readonly description: string
	readonly states: ReadonlyArray<S>
	readonly initial: ReadonlyArray<S>
	readonly terminal: ReadonlyArray<S>
	readonly transitions: { readonly [K in S]: ReadonlyArray<S> }
	is(value: unknown): value is S
	parse(value: unknown): S
	can(from: S, to: S): boolean
	assert(from: S, to: S): void
	sourcesOf(to: S): ReadonlyArray<S>
	isTerminal(state: S): boolean
	sql(states: ReadonlyArray<S>): string
	guard(input: { from: S | ReadonlyArray<S>; to: S | ReadonlyArray<S> }): string
}

export type StateOf<M extends { readonly states: ReadonlyArray<string> }> =
	M['states'][number]

export class IllegalStateTransitionError extends Error {
	readonly machine: string
	readonly from: string
	readonly to: string
	constructor(machine: string, from: string, to: string) {
		super(`Illegal transition in ${machine}: ${from} -> ${to}`)
		this.name = 'IllegalStateTransitionError'
		this.machine = machine
		this.from = from
		this.to = to
	}
}

export function defineStateMachine<const S extends string>(definition: {
	name: string
	description: string
	initial: S | ReadonlyArray<S>
	transitions: { readonly [K in S]: ReadonlyArray<S> }
}): StateMachine<S> {
	const { name } = definition
	const states = Object.freeze(Object.keys(definition.transitions) as Array<S>)
	const known = new Set<string>(states)
	function is(value: unknown): value is S {
		return typeof value === 'string' && known.has(value)
	}
	function parse(value: unknown): S {
		if (!is(value))
			throw new Error(
				`${name}: expected one of ${states.join(', ')}, got ${String(value)}`,
			)
		return value
	}
	if (!states.length) throw new Error(`${definition.name}: no states`)
	for (const state of states) {
		if (!/^[a-z][a-z0-9_]*$/.test(state))
			throw new Error(`${definition.name}: invalid state identifier ${state}`)
	}
	const initial = Object.freeze(
		(typeof definition.initial === 'string'
			? [definition.initial]
			: [...definition.initial]
		).map(parse),
	)
	const transitions = Object.freeze(
		Object.fromEntries(
			states.map((state) => [
				state,
				Object.freeze(definition.transitions[state].map(parse)),
			]),
		),
	) as StateMachine<S>['transitions']
	const reachable = new Set<S>(initial)
	for (const state of reachable)
		for (const target of transitions[state]) reachable.add(target)
	for (const state of states)
		if (!reachable.has(state))
			throw new Error(`${definition.name}: unreachable state ${state}`)
	const terminal = Object.freeze(
		states.filter((state) => transitions[state].length === 0),
	)
	return Object.freeze({
		name: definition.name,
		description: definition.description,
		states,
		initial,
		terminal,
		transitions,
		is,
		parse,
		can(from: S, to: S) {
			return is(from) && is(to) && transitions[from].includes(to)
		},
		assert(from: S, to: S) {
			if (!is(from) || !is(to) || !transitions[from].includes(to))
				throw new IllegalStateTransitionError(name, from, to)
		},
		sourcesOf(to: S) {
			parse(to)
			return Object.freeze(
				states.filter((state) => transitions[state].includes(to)),
			)
		},
		isTerminal(state: S) {
			return terminal.includes(parse(state))
		},
		sql(values: ReadonlyArray<S>) {
			return `(${values.map((state) => `'${parse(state)}'`).join(', ')})`
		},
		guard(input: { from: S | ReadonlyArray<S>; to: S | ReadonlyArray<S> }) {
			const from = typeof input.from === 'string' ? [input.from] : input.from
			const to = typeof input.to === 'string' ? [input.to] : input.to
			if (!from.length || !to.length)
				throw new Error(`${name}: guard requires nonempty from and to states`)
			for (const source of from) {
				parse(source)
				for (const target of to) {
					parse(target)
					if (!transitions[source].includes(target))
						throw new IllegalStateTransitionError(name, source, target)
				}
			}
			return `(${from.map((state) => `'${state}'`).join(', ')})`
		},
	})
}

export function renderStateMachineMermaid<S extends string>(
	machine: StateMachine<S>,
): string {
	return [
		'stateDiagram-v2',
		...machine.initial.map((state) => `    [*] --> ${state}`),
		...machine.states.flatMap((state) =>
			machine.transitions[state].map((target) => `    ${state} --> ${target}`),
		),
		...machine.terminal.map((state) => `    ${state} --> [*]`),
	].join('\n')
}
