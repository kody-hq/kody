/**
 * Concurrency guards inside RepoSession DO external publish
 * (`cloneExternalRefForPublish` / `publishFromExternalRef` isFastForward).
 * Another push or publish advanced Artifacts HEAD or `published_commit`
 * while this attempt was running. Callers clear these by retrying publish.
 *
 * Thrown as plain Errors; subclass identity does not survive Durable Object
 * RPC, so MCP observability matches these phrases to keep them on mcp-event
 * and out of Sentry (KODY-DZ).
 */

/** Current Artifacts HEAD race phrase (shared by builder and matcher). */
export const artifactsHeadMovedWhilePublishingPhrase =
	'Artifacts HEAD moved from "'

/** Legacy wording still matched for in-flight DO builds / stored errors. */
export const artifactsHeadChangedBeforePublishLegacyPhrase =
	'Artifacts HEAD changed from "'

export const publishedCommitMovedDuringPublishMessage =
	'The published commit moved while this publish was running. Retry the publish.'

/**
 * Build the actionable Artifacts HEAD race message. Keep both SHAs so the
 * caller can see which tip was requested and which tip won.
 */
export function buildArtifactsHeadChangedBeforePublishMessage(
	expectedHead: string,
	actualHead: string,
) {
	return (
		`The package's ${artifactsHeadMovedWhilePublishingPhrase}${expectedHead}" to "${actualHead}" while publishing. ` +
		'Retry the publish (or re-run so the newest pushed commit publishes).'
	)
}

export function buildPublishedCommitMovedDuringPublishMessage() {
	return publishedCommitMovedDuringPublishMessage
}

/**
 * Match current and legacy Artifacts HEAD race phrases. Both forms keep the
 * expected and actual SHAs between double quotes.
 */
export function isArtifactsHeadChangedBeforePublishMessage(message: string) {
	return (
		message.includes(artifactsHeadChangedBeforePublishLegacyPhrase) ||
		message.includes(artifactsHeadMovedWhilePublishingPhrase)
	)
}

export function isPublishedCommitMovedDuringPublishMessage(message: string) {
	return message.includes(publishedCommitMovedDuringPublishMessage)
}

/** Either publish-concurrency guard — caller-retryable, not a platform defect. */
export function isPublishConcurrencyCallerMessage(message: string) {
	return (
		isArtifactsHeadChangedBeforePublishMessage(message) ||
		isPublishedCommitMovedDuringPublishMessage(message)
	)
}
