import {
	transition,
	type AnyStateMachine,
	type ContextFrom,
	type EventFrom,
	type StateValueFrom,
} from 'xstate'

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
	readonly to: string | undefined
	readonly event: string | undefined
	constructor(
		machine: string,
		from: string,
		target: string | { type: string },
	) {
		super(
			typeof target === 'string'
				? `Illegal transition in ${machine}: ${from} -> ${target}`
				: `Illegal transition in ${machine}: ${from} on ${target.type}`,
		)
		this.name = 'IllegalStateTransitionError'
		this.machine = machine
		this.from = from
		this.to = typeof target === 'string' ? target : undefined
		this.event = typeof target === 'string' ? undefined : target.type
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
		if (!/^[a-z][a-z0-9_-]*$/.test(state))
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

export function renderStateMachineMermaid(
	machine: StateMachine<string> | AnyStateMachine,
): string {
	if ('getTransitionData' in machine) return renderLifecycleMermaid(machine)
	const id = (state: string) =>
		state.includes('-') ? `__state_${machine.states.indexOf(state)}` : state
	return [
		'stateDiagram-v2',
		...machine.states
			.filter((state) => state.includes('-'))
			.map((state) => `    state "${state}" as ${id(state)}`),
		...machine.initial.map((state) => `    [*] --> ${id(state)}`),
		...machine.states.flatMap((state) =>
			machine.transitions[state]!.map(
				(target) => `    ${id(state)} --> ${id(target)}`,
			),
		),
		...machine.terminal.map((state) => `    ${id(state)} --> [*]`),
	].join('\n')
}

export type LifecycleStateOf<M extends AnyStateMachine> = Extract<
	StateValueFrom<M>,
	string
>

export type LifecycleMachine = AnyStateMachine

export function statesOf<M extends AnyStateMachine>(
	machine: M,
): ReadonlyArray<LifecycleStateOf<M>> {
	return Object.keys(machine.states) as Array<LifecycleStateOf<M>>
}

export function finalStatesOf<M extends AnyStateMachine>(
	machine: M,
): ReadonlyArray<LifecycleStateOf<M>> {
	return statesOf(machine).filter(
		(state) => machine.states[state]!.type === 'final',
	)
}

export function isState<M extends AnyStateMachine>(
	machine: M,
	value: unknown,
): value is LifecycleStateOf<M> {
	return typeof value === 'string' && Object.hasOwn(machine.states, value)
}

export function parseState<M extends AnyStateMachine>(
	machine: M,
	value: unknown,
): LifecycleStateOf<M> {
	if (!isState(machine, value))
		throw new Error(
			`${machine.id}: expected one of ${statesOf(machine).join(', ')}, got ${String(value)}`,
		)
	return value
}

function resolveLifecycleState<M extends AnyStateMachine>(
	machine: M,
	from: LifecycleStateOf<M>,
	context?: ContextFrom<M>,
) {
	parseState(machine, from)
	if (context === undefined && typeof machine.config.context === 'function')
		throw new Error(`${machine.id}: provide context for a context initializer`)
	return machine.resolveState({
		value: from,
		context: context ?? machine.config.context ?? {},
	})
}

export function nextState<M extends AnyStateMachine>(
	machine: M,
	from: LifecycleStateOf<M>,
	event: EventFrom<M>,
	context?: ContextFrom<M>,
): LifecycleStateOf<M> {
	if (!isState(machine, from))
		throw new IllegalStateTransitionError(machine.id, from, event)
	const snapshot = resolveLifecycleState(machine, from, context)
	if (!snapshot.can(event))
		throw new IllegalStateTransitionError(machine.id, from, event)
	const runtime: AnyStateMachine = machine
	const [next] = transition(runtime, snapshot, event)
	return parseState(machine, next.value)
}

export function canHandle<M extends AnyStateMachine>(
	machine: M,
	from: LifecycleStateOf<M>,
	eventType: EventFrom<M>['type'],
	context?: ContextFrom<M>,
): boolean {
	return (
		isState(machine, from) &&
		resolveLifecycleState(machine, from, context).can({ type: eventType })
	)
}

/** Structural sources, including guarded alternatives; SQL must retain its guards. */
export function sourcesOf<M extends AnyStateMachine>(
	machine: M,
	eventType: EventFrom<M>['type'],
): ReadonlyArray<LifecycleStateOf<M>> {
	return statesOf(machine).filter((state) =>
		(machine.states[state]!.transitions.get(eventType) ?? []).some(
			(edge) => edge.target !== undefined || edge.actions.length > 0,
		),
	)
}

export function sqlSourcesOf<M extends AnyStateMachine>(
	machine: M,
	eventType: EventFrom<M>['type'],
	selectedSources?: ReadonlyArray<LifecycleStateOf<M>>,
): string {
	const sources = sourcesOf(machine, eventType)
	if (!sources.length && !selectedSources)
		throw new Error(`${machine.id}: no sources for event ${eventType}`)
	const selected = selectedSources ?? sources
	if (!selected.length)
		throw new Error(`${machine.id}: sources must be nonempty`)
	for (const source of selected)
		if (!sources.includes(source))
			throw new IllegalStateTransitionError(machine.id, source, {
				type: eventType,
			})
	return sqlStatesOf(machine, selected)
}

export function sqlStatesOf<M extends AnyStateMachine>(
	machine: M,
	states: ReadonlyArray<LifecycleStateOf<M>>,
): string {
	return sqlStateValues(
		machine.id,
		states.map((state) => parseState(machine, state)),
	)
}

export function sqlSourceOf<M extends AnyStateMachine>(
	machine: M,
	from: LifecycleStateOf<M>,
	event: EventFrom<M>,
): string {
	nextState(machine, from, event)
	return sqlStatesOf(machine, [from])
}

function sqlStateValues(name: string, values: ReadonlyArray<string>) {
	for (const value of values)
		if (!/^[a-z][a-z0-9_-]*$/.test(value))
			throw new Error(`${name}: invalid state identifier ${value}`)
	return `(${values.map((value) => `'${value}'`).join(', ')})`
}

export type StatusEnum<S extends string> = {
	readonly name: string
	readonly description: string
	readonly values: ReadonlyArray<S>
	is(value: unknown): value is S
	parse(value: unknown): S
	sql(values: ReadonlyArray<S>): string
}

export function defineStatusEnum<const S extends string>(definition: {
	name: string
	description: string
	values: ReadonlyArray<S>
}): StatusEnum<S> {
	const { name, description } = definition
	const values = Object.freeze([...definition.values])
	if (!values.length) throw new Error(`${name}: no values`)
	if (new Set(values).size !== values.length)
		throw new Error(`${name}: duplicate values`)
	sqlStateValues(name, values)
	function is(value: unknown): value is S {
		return typeof value === 'string' && values.includes(value as S)
	}
	function parse(value: unknown): S {
		if (!is(value))
			throw new Error(
				`${name}: expected one of ${values.join(', ')}, got ${String(value)}`,
			)
		return value
	}
	return Object.freeze({
		name,
		description,
		values,
		is,
		parse,
		sql: (selected: ReadonlyArray<S>) =>
			sqlStateValues(name, selected.map(parse)),
	})
}

function renderLifecycleMermaid(machine: AnyStateMachine): string {
	const states = statesOf(machine)
	const id = (state: string) =>
		state.includes('-') ? `__state_${states.indexOf(state)}` : state
	const initial = machine.root.initial.target?.[0]?.key
	return [
		'stateDiagram-v2',
		...states
			.filter((state) => state.includes('-'))
			.map((state) => `    state "${state}" as ${id(state)}`),
		...(initial ? [`    [*] --> ${id(initial)}`] : []),
		...states.flatMap((state) =>
			[...machine.states[state]!.transitions].flatMap(([event, edges]) =>
				edges
					.filter(
						(edge) => edge.target !== undefined || edge.actions.length > 0,
					)
					.flatMap((edge) =>
						(edge.target ?? [machine.states[state]!]).map(
							(target) => `    ${id(state)} --> ${id(target.key)}: ${event}`,
						),
					),
			),
		),
		...finalStatesOf(machine).map((state) => `    ${id(state)} --> [*]`),
	].join('\n')
}
