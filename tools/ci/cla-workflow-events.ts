/**
 * Event routing for `.github/workflows/cla.yml` job `cla` and the post-sign
 * re-run lookup in the `record` job. Mirrored in the workflow `if:` / script;
 * keep them in sync.
 *
 * Why `pull_request_target` (not `pull_request`):
 * - Fork PRs always get a read-only `GITHUB_TOKEN` on `pull_request`, so the
 *   unsigned-instructions comment 403s (`Resource not accessible by
 *   integration`). See kody-hq/kody#1764 / Actions run 32902603916.
 * - `pull_request_target` runs from the base repository with a write-capable
 *   token. Safety depends on base-ref checkout only and never executing PR
 *   head code (documented in decision 0018).
 *
 * The check job shares the `pull_request_target` trigger with
 * `record-on-merge` (`closed`). Only non-closed actions run the check.
 */
export type ClaCheckEventName = 'pull_request_target'

export type ClaCheckEventRouteInput = {
	eventName: string
	/** `github.event.action` (e.g. opened, synchronize, closed) */
	action: string
}

export type ClaWorkflowRunSummary = {
	id: number
	event: string
	status: string
	conclusion: string | null
}

/**
 * Returns whether the CLA check job should run for this workflow event.
 * Check path is `pull_request_target` only; `closed` belongs to record-on-merge.
 */
export function shouldRunClaCheckJob(input: ClaCheckEventRouteInput): boolean {
	return input.eventName === 'pull_request_target' && input.action !== 'closed'
}

/**
 * Event order for post-sign re-run lookup. Single-event path after the fork
 * fix: only `pull_request_target` runs the check.
 */
export function claRerunEventOrder(): Array<ClaCheckEventName> {
	return ['pull_request_target']
}

/**
 * Pick a workflow run that is worth waiting on or re-running. Skipped runs
 * (e.g. a `pull_request_target` `closed` run that only drives record-on-merge)
 * are ignored so we do not re-trigger a no-op while the real check stays red.
 */
export function pickClaRerunCandidate(
	runs: Array<ClaWorkflowRunSummary>,
): ClaWorkflowRunSummary | null {
	for (const run of runs) {
		if (run.status !== 'completed') {
			return run
		}
		if (run.conclusion !== 'skipped') {
			return run
		}
	}
	return null
}
