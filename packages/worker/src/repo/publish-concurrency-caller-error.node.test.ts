import { expect, test } from 'vitest'
import {
	buildArtifactsHeadChangedBeforePublishMessage,
	buildPublishedCommitMovedDuringPublishMessage,
	isArtifactsHeadChangedBeforePublishMessage,
	isPublishConcurrencyCallerMessage,
	isPublishedCommitMovedDuringPublishMessage,
} from './publish-concurrency-caller-error.ts'

test('Artifacts HEAD race builder interpolates both SHAs; matchers accept current and legacy phrases', () => {
	expect(
		buildArtifactsHeadChangedBeforePublishMessage('commit-stale', 'commit-new'),
	).toBe(
		'The package\'s Artifacts HEAD moved from "commit-stale" to "commit-new" while publishing. Retry the publish (or re-run so the newest pushed commit publishes).',
	)

	// Phrases written here, not via the builder — so a matcher that only
	// round-trips its own output would fail.
	expect(
		isArtifactsHeadChangedBeforePublishMessage(
			'The package\'s Artifacts HEAD moved from "aaa" to "bbb" while publishing.',
		),
	).toBe(true)
	expect(
		isArtifactsHeadChangedBeforePublishMessage(
			'Artifacts HEAD changed from "aaa" to "bbb" before publish.',
		),
	).toBe(true)
	expect(
		isPublishConcurrencyCallerMessage(
			'The package\'s Artifacts HEAD moved from "aaa" to "bbb" while publishing.',
		),
	).toBe(true)

	expect(
		isArtifactsHeadChangedBeforePublishMessage(
			'Artifacts git clone failed for https://example.test/repo.git',
		),
	).toBe(false)
	expect(isPublishConcurrencyCallerMessage('D1 write failed.')).toBe(false)
})

test('published-commit race matcher matches only that phrase', () => {
	expect(buildPublishedCommitMovedDuringPublishMessage()).toBe(
		'The published commit moved while this publish was running. Retry the publish.',
	)
	expect(
		isPublishedCommitMovedDuringPublishMessage(
			'The published commit moved while this publish was running. Retry the publish.',
		),
	).toBe(true)
	expect(
		isPublishConcurrencyCallerMessage(
			'The published commit moved while this publish was running. Retry the publish.',
		),
	).toBe(true)
	expect(
		isPublishedCommitMovedDuringPublishMessage(
			'The published commit was not reachable from any ref.',
		),
	).toBe(false)
})
