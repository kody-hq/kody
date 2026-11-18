/** Mirrors the worker's publish-outside-cloud advice for compute limits. */
export const executionContextPublishDocsUrl =
	'https://kody.codes/docs/execution-contexts#try-publishing-from-a-context'

/** `--build local` and `--context` publishes need this experiment on; `dev check --build local` does not. */
const executionContextsExperimentUrl = 'https://kody.codes/account/experiments'

export const publishOutsideCloudAdvice =
	"This package is near Kody cloud's build CPU or memory limit. Build it on " +
	'your machine with `npx -y @kodycodes/cli@latest package publish <package> --build local`, or on an ' +
	'execution context with `--context <name>`. Kody serves that build as is ' +
	'and does not build it again, so these limits do not apply to it. Both of those publish ' +
	`commands need the Execution contexts experiment: turn it on at ${executionContextsExperimentUrl} ` +
	`(docs: ${executionContextPublishDocsUrl}). ` +
	'`kody dev check --build local` runs the same build on your machine before you publish, and works without the experiment.'
