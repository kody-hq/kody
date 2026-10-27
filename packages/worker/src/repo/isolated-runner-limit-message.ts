const heavyWorkOffloadGuideId = 'heavy_work_offload'

/**
 * Shared advice appended when a throwaway check/rebuild isolate hits a
 * Durable Object memory or CPU reset. The usual cause is the npm graph
 * (PDF.js-class libraries), not the author's source files.
 */
export function isolatedRunnerResourceLimitAdvice() {
	return (
		'This usually means the npm dependency graph — not just the package ' +
		'source — is too large to bundle inside a Worker isolate. Shrink the ' +
		'graph, or keep the Kody package as a thin orchestrator and offload ' +
		'the heavy work to a process you operate. Load ' +
		`\`search({ entity: "guide:${heavyWorkOffloadGuideId}" })\`.`
	)
}

/**
 * Caller-facing copy when `packagePublishExternalPush` dies on a Durable
 * Object isolate memory/CPU reset (or DO SQLite SQLITE_NOMEM). Those resets
 * are deterministic for a given package tip, so the publish path must not
 * burn retries as if they were deploy-time code-updated blips.
 */
export function externalPublishResourceLimitMessage() {
	return (
		'packagePublishExternalPush hit the Durable Object isolate memory or ' +
		'CPU limit while cloning, checking, or rebuilding this package, so ' +
		'the publish stopped instead of retrying the same limit. That limit ' +
		'is deterministic for this package tip — shrink the source tree and ' +
		'dependency graph, or keep the package as a thin orchestrator. ' +
		isolatedRunnerResourceLimitAdvice()
	)
}
