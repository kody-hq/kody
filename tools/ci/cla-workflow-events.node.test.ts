import { expect, test } from 'vitest'

import {
	claRerunEventOrder,
	pickClaRerunCandidate,
	shouldRunClaCheckJob,
} from './cla-workflow-events.ts'

test('CLA check runs on pull_request_target for non-closed actions only', () => {
	expect(
		shouldRunClaCheckJob({
			eventName: 'pull_request_target',
			action: 'opened',
		}),
	).toBe(true)
	expect(
		shouldRunClaCheckJob({
			eventName: 'pull_request_target',
			action: 'reopened',
		}),
	).toBe(true)
	expect(
		shouldRunClaCheckJob({
			eventName: 'pull_request_target',
			action: 'synchronize',
		}),
	).toBe(true)
	expect(
		shouldRunClaCheckJob({
			eventName: 'pull_request_target',
			action: 'closed',
		}),
	).toBe(false)
})

test('CLA check does not run on pull_request or issue_comment', () => {
	expect(
		shouldRunClaCheckJob({
			eventName: 'pull_request',
			action: 'opened',
		}),
	).toBe(false)
	expect(
		shouldRunClaCheckJob({
			eventName: 'issue_comment',
			action: 'created',
		}),
	).toBe(false)
})

test('post-sign re-run looks up pull_request_target only', () => {
	expect(claRerunEventOrder()).toEqual(['pull_request_target'])
})

test('re-run selection skips skipped workflow runs', () => {
	expect(
		pickClaRerunCandidate([
			{
				id: 1,
				event: 'pull_request_target',
				status: 'completed',
				conclusion: 'skipped',
			},
			{
				id: 2,
				event: 'pull_request_target',
				status: 'completed',
				conclusion: 'failure',
			},
		])?.id,
	).toBe(2)
	expect(
		pickClaRerunCandidate([
			{
				id: 3,
				event: 'pull_request_target',
				status: 'in_progress',
				conclusion: null,
			},
		])?.id,
	).toBe(3)
	expect(pickClaRerunCandidate([])).toBe(null)
})
