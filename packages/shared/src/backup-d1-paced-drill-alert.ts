/**
 * Sentry grouping for the weekly paced D1 restore drill
 * (`dr_d1_paced_restore_drill`). Drill failures get their own fingerprint so
 * a platform reset ("Worker exceeded memory limit.") never folds into an
 * unrelated, possibly ignored, issue with the same message.
 */
export const pacedRestoreDrillLane = 'dr_d1_paced_restore_drill'

export type PacedRestoreDrillFailureKind =
	| 'oom'
	| 'timeout'
	| 'interrupted'
	| 'deadline'
	| 'mismatch'
	| 'error'

/** Where the drill was when it failed (read from D1 progress rows). */
export type PacedRestoreDrillCheckpoint = {
	day: string
	source: string | null
	table: string | null
	phase: string | null
}

export function classifyPacedRestoreDrillFailure(
	error: unknown,
): PacedRestoreDrillFailureKind {
	const message = error instanceof Error ? error.message : String(error)
	if (/memory limit/i.test(message)) return 'oom'
	if (/CPU time limit|time limit|timed out|timeout/i.test(message)) {
		return 'timeout'
	}
	return 'error'
}

export function pacedRestoreDrillSentryFingerprint(
	kind: PacedRestoreDrillFailureKind,
	source: string | null,
) {
	return ['dr-d1-paced-restore-drill', kind, source ?? 'unknown-source']
}

type DrillSentryScope = {
	setFingerprint: (fingerprint: Array<string>) => unknown
	setTag: (key: string, value: string) => unknown
	setLevel: (level: 'fatal' | 'error') => unknown
	setContext: (name: string, context: Record<string, unknown> | null) => unknown
}

export function applyPacedRestoreDrillSentryScope(
	scope: DrillSentryScope,
	input: {
		kind: PacedRestoreDrillFailureKind
		checkpoint: PacedRestoreDrillCheckpoint | null
	},
) {
	const source = input.checkpoint?.source ?? null
	scope.setFingerprint(pacedRestoreDrillSentryFingerprint(input.kind, source))
	scope.setLevel('fatal')
	scope.setTag('dr.drill.kind', input.kind)
	scope.setTag('dr.drill.source', source ?? 'unknown')
	scope.setTag('dr.drill.phase', input.checkpoint?.phase ?? 'unknown')
	scope.setContext('dr_paced_restore_drill', {
		kind: input.kind,
		day: input.checkpoint?.day ?? null,
		source,
		table: input.checkpoint?.table ?? null,
		phase: input.checkpoint?.phase ?? null,
	})
}
