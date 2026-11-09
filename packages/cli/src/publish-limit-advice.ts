/** Mirrors the worker's publish-outside-cloud advice for compute limits. */
export const executionContextPublishDocsUrl =
	'https://kody.codes/docs/execution-contexts#try-publishing-from-a-context'

export const publishOutsideCloudAdvice =
	"This package is near Kody cloud's build CPU or memory limit. Build it on " +
	'your machine with `kody package publish --build local`, or on an ' +
	`execution context with \`--context <name>\` (docs: ${executionContextPublishDocsUrl}). ` +
	'`kody dev check --build local` checks the same local build before you publish.'
