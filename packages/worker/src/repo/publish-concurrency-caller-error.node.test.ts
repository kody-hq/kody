import { expect, test } from 'vitest'
import {
	buildArtifactsHeadChangedBeforePublishMessage,
	buildPublishedCommitMovedDuringPublishMessage,
	isArtifactsHeadChangedBeforePublishMessage,
	isPublishConcurrencyCallerMessage,
	isPublishedCommitMovedDuringPublishMessage,
	publishedCommitMovedDuringPublishMessage,
} from './publish-concurrency-caller-error.ts'

test('Artifacts HEAD race builder keeps both SHAs and matches current plus legacy phrases', () => {
	const current = buildArtifactsHeadChangedBeforePublishMessage(
		'commit-stale',
		'commit-new',
	)
	expect(current).toBe(
		'The package\'s Artifacts HEAD moved from "commit-stale" to "commit-new" while publishing. Retry the publish (or re-run so the newest pushed commit publishes).',
	)
	expect(isArtifactsHeadChangedBeforePublishMessage(current)).toBe(true)
	expect(isPublishConcurrencyCallerMessage(current)).toBe(true)

	const legacy =
		'Artifacts HEAD changed from "commit-stale" to "commit-new" before publish.'
	expect(isArtifactsHeadChangedBeforePublishMessage(legacy)).toBe(true)
	expect(isPublishConcurrencyCallerMessage(legacy)).toBe(true)

	expect(
		isArtifactsHeadChangedBeforePublishMessage(
			'Artifacts git clone failed for https://example.test/repo.git',
		),
	).toBe(false)
	expect(isPublishConcurrencyCallerMessage('D1 write failed.')).toBe(false)
})

test('published-commit race builder is stable and matches only that phrase', () => {
	const message = buildPublishedCommitMovedDuringPublishMessage()
	expect(message).toBe(publishedCommitMovedDuringPublishMessage)
	expect(isPublishedCommitMovedDuringPublishMessage(message)).toBe(true)
	expect(isPublishConcurrencyCallerMessage(message)).toBe(true)
	expect(
		isPublishedCommitMovedDuringPublishMessage(
			'The published commit was not reachable from any ref.',
		),
	).toBe(false)
})
