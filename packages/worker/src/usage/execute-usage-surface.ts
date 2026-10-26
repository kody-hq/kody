import { type RunSurface } from '#worker/run-records/types.ts'

/**
 * Whether a bundled sandbox run should emit the `execute` usage metric.
 *
 * `execute` is MCP execute-tool sandbox work only, one event per call —
 * the surface `execute_unique_workers_per_day` caps (that cap counts unique
 * workers, not calls). Job, package-export, workflow, and other
 * surfaces already record their own event types; they must not also
 * inflate `execute` or stamp `first_execute_at`.
 */
export function shouldRecordExecuteUsageForRun(input: {
	surface: RunSurface | null | undefined
	hasPackageContext: boolean
}): boolean {
	if (input.surface) {
		switch (input.surface) {
			case 'execute':
				return true
			case 'export':
			case 'subscription':
			case 'app_fetch':
			case 'app_realtime':
			case 'job':
			case 'workflow':
			case 'webhook':
				return false
			default: {
				const exhaustive: never = input.surface
				throw new Error(`Unhandled run surface: ${String(exhaustive)}`)
			}
		}
	}
	return !input.hasPackageContext
}
