import { raiseSignal } from './process-tree.js'

/** The part of a child process the tracker needs. */
export type TrackedChild = {
	kill(signal?: NodeJS.Signals): boolean
	once(event: 'close' | 'error', listener: () => void): unknown
}

type SignalTarget = Pick<NodeJS.EventEmitter, 'on' | 'off' | 'listenerCount'>

const stopSignals: Array<NodeJS.Signals> = ['SIGINT', 'SIGTERM', 'SIGHUP']

/**
 * Children that must not outlive this process. While any is running, SIGINT,
 * SIGTERM, SIGHUP and exit kill them all. A signal nobody else handles is
 * re-raised after that, so the default exit (130/143) still happens.
 */
export function createChildTracker(
	input: {
		target?: SignalTarget
		raise?: (signal: NodeJS.Signals) => void
	} = {},
) {
	const target = input.target ?? process
	const raise = input.raise ?? raiseSignal
	const children = new Set<TrackedChild>()
	let listening = false
	const killAll = () => {
		for (const child of children) {
			try {
				child.kill('SIGTERM')
			} catch {
				// Already gone.
			}
		}
		children.clear()
		stopListening()
	}
	const onSignal = (signal: NodeJS.Signals) => {
		killAll()
		if (target.listenerCount(signal) === 0) raise(signal)
	}
	function stopListening() {
		if (!listening) return
		listening = false
		for (const signal of stopSignals) target.off(signal, onSignal)
		target.off('exit', killAll)
	}
	return {
		track<Child extends TrackedChild>(child: Child): Child {
			children.add(child)
			const untrack = () => {
				children.delete(child)
				if (children.size === 0) stopListening()
			}
			child.once('close', untrack)
			child.once('error', untrack)
			if (!listening) {
				listening = true
				for (const signal of stopSignals) target.on(signal, onSignal)
				target.on('exit', killAll)
			}
			return child
		},
		killAll,
		get size() {
			return children.size
		},
	}
}

export type ChildTracker = ReturnType<typeof createChildTracker>

/** Process-wide tracker for short-lived helper children (Keychain reads). */
export const helperChildren = createChildTracker()
