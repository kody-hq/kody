/** Known locations for `npm run ui:verify` output. Relative to the repo root. */
export const uiVerifyPaths = {
	/** Committed visual baselines. */
	baselines: 'e2e/ui-verify/baselines',
	/** Everything the run writes (CI uploads this directory). */
	output: '.tmp/ui-verify',
	report: '.tmp/ui-verify/report.md',
	results: '.tmp/ui-verify/results.json',
	screenshots: '.tmp/ui-verify/screenshots',
	testResults: '.tmp/ui-verify/test-results',
} as const

export const uiVerifyUpdateCommand = 'npm run ui:verify -- --update'
