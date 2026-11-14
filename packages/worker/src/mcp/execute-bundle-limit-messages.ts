/**
 * Copy and predicates for hosted execute bundles that are too large for Kody
 * cloud. Kept free of bundler imports so the executor's error details and the
 * bundle builder can share them.
 */

/** What an agent runs instead when hosted execute cannot bundle a module. */
export const executeLocallyCommand =
	'npx -y @kodycodes/cli@latest execute --local --file <file>'

const executeBundleResourceLimitMessagePrefix =
	'This code and its imports are too large to bundle on Kody cloud'

/** Caller-facing copy when one isolated execute bundle hits its limits. */
export const executeBundleResourceLimitMessage =
	`${executeBundleResourceLimitMessagePrefix} (the bundler hit its memory or CPU limit), ` +
	'so nothing ran and only this request failed. ' +
	`Run it on your machine instead: save the module to a file and run \`${executeLocallyCommand}\`. ` +
	"Local runs bundle with your machine's memory and call the same Kody capabilities. " +
	'To stay on Kody cloud, import fewer or smaller packages in one module.'

const executeBundleTimeoutMessagePrefix = 'Execute module bundling exceeded '

export function createExecuteBundleTimeoutMessage(timeoutMs: number) {
	const seconds = Math.max(1, Math.round(timeoutMs / 1000))
	return `${executeBundleTimeoutMessagePrefix}${seconds}s before sandbox start. Heavy multi-export package graphs (for example multiple zod-based exports from one package) can exceed this budget; prefer remix/data-schema for agent-facing export validation, or import one heavy export per execute module. Nothing ran. To run it as written, bundle on your machine: save the module to a file and run \`${executeLocallyCommand}\`.`
}

/** True for either way a hosted execute bundle is too large to build. */
export function isExecuteBundleTooLargeMessage(message: string) {
	return (
		message.includes(executeBundleResourceLimitMessagePrefix) ||
		message.includes(executeBundleTimeoutMessagePrefix)
	)
}
