import {
	transition,
	type AnyStateMachine,
	type ContextFrom,
	type EventFrom,
	type SnapshotFrom,
} from 'xstate'

/** Illegal `event` from `from` on `machine` (no matching XState transition). */
export class IllegalStateTransitionError extends Error {
	readonly machine: string
	readonly from: string
	readonly event: string
	constructor(machine: string, from: string, target: { type: string }) {
		super(`Illegal transition in ${machine}: ${from} on ${target.type}`)
		this.name = 'IllegalStateTransitionError'
		this.machine = machine
		this.from = from
		this.event = target.type
	}
}

/** Flat string state of a lifecycle machine (nested values are excluded). */
export type LifecycleStateOf<M extends AnyStateMachine> = Extract<
	SnapshotFrom<M>['value'],
	string
>

/** An XState v6 machine used as a Kody lifecycle. */
export type LifecycleMachine = AnyStateMachine

/** All state ids declared on the machine. */
export function statesOf<M extends AnyStateMachine>(
	machine: M,
): ReadonlyArray<LifecycleStateOf<M>> {
	return Object.keys(machine.states) as Array<LifecycleStateOf<M>>
}

/** States marked `type: 'final'` (no further operation leaves them). */
export function finalStatesOf<M extends AnyStateMachine>(
	machine: M,
): ReadonlyArray<LifecycleStateOf<M>> {
	return statesOf(machine).filter(
		(state) => machine.states[state]!.type === 'final',
	)
}

/** Whether `value` is a declared state id. */
export function isState<M extends AnyStateMachine>(
	machine: M,
	value: unknown,
): value is LifecycleStateOf<M> {
	return typeof value === 'string' && Object.hasOwn(machine.states, value)
}

/** Parse `value` as a declared state id or throw. */
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

/**
 * Next state after `event` from `from`, or throw. Pass `context` when the
 * machine has a context initializer or the guard needs it. Payload-dependent
 * guards need the full event, not a type-only `canHandle` probe.
 */
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

/**
 * Whether `from` has a transition for this event type. Probes with `{ type }`
 * only; payload-dependent guards need `nextState`.
 */
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
			(edge) =>
				edge.target !== undefined ||
				edge.context !== undefined ||
				typeof edge.to === 'function',
		),
	)
}

/**
 * SQL `IN (...)` list of states that handle `eventType`. Pass `selectedSources`
 * to keep a predicate-order subset; every selected source must actually handle
 * the event.
 */
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

/** SQL `IN (...)` list of declared states. */
export function sqlStatesOf<M extends AnyStateMachine>(
	machine: M,
	states: ReadonlyArray<LifecycleStateOf<M>>,
): string {
	return sqlStateValues(
		machine.id,
		states.map((state) => parseState(machine, state)),
	)
}

/** SQL `IN (...)` list of one source after proving `event` is legal from it. */
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

/** Unconstrained status values: membership, parse, and SQL, with no edges. */
export type StatusEnum<S extends string> = {
	readonly name: string
	readonly description: string
	readonly values: ReadonlyArray<S>
	is(value: unknown): value is S
	parse(value: unknown): S
	sql(values: ReadonlyArray<S>): string
}

/** Declare an unconstrained status column. No transition graph. */
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
