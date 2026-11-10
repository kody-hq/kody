import type { AnyActorRef, EventFrom } from 'xstate'
export type FormFlowState<S extends string> = {
	[K in S]: K extends 'error' | 'success' | 'confirming'
		? { status: K; message: string }
		: { status: K }
}[S]

export type UiData<V> = V extends { status: string } ? Omit<V, 'status'> : never
type UiPayload<V, S> = V extends { status: infer Status }
	? S extends Status
		? Omit<V, 'status'>
		: never
	: never
export type UiContext<V> = { data: UiData<V>; requestId: unknown }
export type UiEvent<V, S> = { data: UiPayload<V, S>; requestId?: unknown }

export { resetUi, startUi, updateUi } from '#universal/ui-context.ts'
const views = new WeakMap<object, { status: string }>()

export function uiContext<V extends { status: string }>(view: V): UiContext<V> {
	const { status: _status, ...data } = view
	return { data: data as UiData<V>, requestId: undefined }
}

export function uiState<V extends { status: string }>(snapshot: {
	value: unknown
	context: { data: object }
}): V {
	const cached = views.get(snapshot)
	if (cached) return cached as V
	const view = { status: snapshot.value, ...snapshot.context.data } as V
	views.set(snapshot, view)
	return view
}

export function sendUiEvent<A extends AnyActorRef>(
	actor: A,
	event: EventFrom<A>,
): boolean {
	if (!actor.getSnapshot().can(event)) return false
	actor.send(event)
	return true
}
