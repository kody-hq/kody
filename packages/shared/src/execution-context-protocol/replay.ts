/**
 * Replay windows (ECP 5). Frame `seq` strictly increases by one per
 * direction starting at 1; any regression or gap closes the socket. Signed
 * HTTP nonces are unique per context for 120 s.
 */
export const ecpFrameClockSkewMs = 60_000

export type SeqCheck = 'ok' | 'replay'

export function checkNextSeq(lastSeen: number, received: number): SeqCheck {
	return Number.isSafeInteger(received) && received === lastSeen + 1
		? 'ok'
		: 'replay'
}

export function checkFrameClock(ts: number, now: number) {
	return Number.isFinite(ts) && Math.abs(now - ts) <= ecpFrameClockSkewMs
		? 'ok'
		: 'clock_skew'
}

/** In-memory nonce window (the DO keeps the durable one in SQLite). */
export class EcpNonceWindow {
	readonly #seen = new Map<string, number>()
	readonly windowMs: number
	constructor(windowMs: number) {
		this.windowMs = windowMs
	}

	/** True when the nonce is new; records it until `now + windowMs`. */
	consume(nonce: string, now: number) {
		for (const [key, expiresAt] of this.#seen) {
			if (expiresAt <= now) this.#seen.delete(key)
		}
		if (this.#seen.has(nonce)) return false
		this.#seen.set(nonce, now + this.windowMs)
		return true
	}
}
