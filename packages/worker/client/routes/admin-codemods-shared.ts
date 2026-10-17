export type RunMode = 'scan' | 'dry-run' | 'apply' | 'revert'
export type RunPhase = 'idle' | 'running' | 'complete' | 'error'

export type LiveRunItem = {
	itemId: string
	userId: string
	packageId: string
	kodyId: string
	status: string
	changedPaths: Array<string>
	findings: Array<{ path: string | null; message: string }>
	error: string | null
}
export const maxRunSteps = 200

export const runModes = [
	'scan',
	'dry-run',
	'apply',
	'revert',
] as const satisfies ReadonlyArray<RunMode>

export function parseCommaSeparatedIds(value: string): Array<string> {
	return value
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
}

export function mergeSummaryCounts(
	left: Record<string, number>,
	right: Partial<Record<string, number>>,
) {
	const next = { ...left }
	for (const [status, count] of Object.entries(right)) {
		if (typeof count !== 'number') continue
		next[status] = (next[status] ?? 0) + count
	}
	return next
}

export function formatSummaryCounts(summary: Record<string, number>) {
	const entries = Object.entries(summary).sort(([left], [right]) =>
		left.localeCompare(right),
	)
	if (entries.length === 0) return 'No items yet'
	return entries.map(([status, count]) => `${status}: ${count}`).join(' · ')
}

export function formatFindings(
	findings: Array<{ path: string | null; message: string }>,
) {
	if (findings.length === 0) return '—'
	return findings
		.map((finding) =>
			finding.path ? `${finding.path}: ${finding.message}` : finding.message,
		)
		.join('; ')
}
