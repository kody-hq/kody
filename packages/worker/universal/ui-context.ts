type EventArgs<D> = { event: { data: D; requestId?: unknown } }

export const updateUi = <D>({ event }: EventArgs<D>) => ({ data: event.data })
export const startUi = <D>({ event }: EventArgs<D>) => ({
	data: event.data,
	requestId: event.requestId,
})
export const resetUi = <D>({ event }: EventArgs<D>) => ({
	data: event.data,
	requestId: undefined,
})
