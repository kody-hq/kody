import { type EcpRunTiming } from '@kody-internal/shared/execution-context-protocol/index.ts'

/** Daemon-reported phases (daemon clock) plus what Kody measured around them. */
export type ExecutionContextRunTiming = EcpRunTiming & {
	/** run.commit sent until the result arrived, on Kody's clock. */
	serverMs: number
	/** serverMs minus daemonMs: dispatch and return on the wire. */
	transitMs: number
}

const timingFields = [
	'queueMs',
	'setupMs',
	'packageGraphMs',
	'executeMs',
	'daemonMs',
] as const

export function runTiming(
	reported: unknown,
	committedAt: number | null,
	now: number,
): ExecutionContextRunTiming | undefined {
	if (!reported || typeof reported !== 'object' || committedAt === null) {
		return undefined
	}
	const body = reported as Record<string, unknown>
	const ms = (value: unknown) =>
		typeof value === 'number' && Number.isFinite(value) && value >= 0
			? Math.round(value)
			: undefined
	const daemonMs = ms(body.daemonMs)
	if (daemonMs === undefined) return undefined
	const timing: Record<string, unknown> = {}
	for (const field of timingFields) {
		const value = ms(body[field])
		if (value !== undefined) timing[field] = value
	}
	if (typeof body.packageGraphCached === 'boolean') {
		timing.packageGraphCached = body.packageGraphCached
	}
	const serverMs = Math.max(0, now - committedAt)
	return {
		queueMs: 0,
		setupMs: 0,
		executeMs: 0,
		...timing,
		daemonMs,
		serverMs,
		transitMs: Math.max(0, serverMs - daemonMs),
	} as ExecutionContextRunTiming
}
