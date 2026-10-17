/** Coalesce browser lifecycle events, without overlapping refresh generations. */
export function refreshOnActivation({
	window,
	document,
	refresh,
	onError,
}: {
	window: EventTarget
	document: EventTarget & { readonly visibilityState: string }
	refresh: () => Promise<unknown>
	onError: (error: unknown) => void
}) {
	let timer: ReturnType<typeof setTimeout> | undefined
	let running = false
	let queued = false
	let disposed = false
	function schedule() {
		if (disposed || document.visibilityState !== 'visible') return
		queued = true
		if (running || timer !== undefined) return
		// Focus and visibility events can arrive in separate browser tasks.
		timer = setTimeout(() => {
			timer = undefined
			if (disposed || document.visibilityState !== 'visible') return
			queued = false
			running = true
			void Promise.resolve()
				.then(refresh)
				.catch(onError)
				.finally(() => {
					running = false
					// A reconnect or later activation during the read needs fresh work.
					if (queued) schedule()
				})
		}, 50)
	}
	window.addEventListener('focus', schedule)
	window.addEventListener('online', schedule)
	document.addEventListener('visibilitychange', schedule)
	return () => {
		disposed = true
		clearTimeout(timer)
		window.removeEventListener('focus', schedule)
		window.removeEventListener('online', schedule)
		document.removeEventListener('visibilitychange', schedule)
	}
}
