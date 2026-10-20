import { expect, test } from 'vitest'
import {
	buildRepoApplyPatchParseCallerMessage,
	isGitPushNotFastForwardError,
	isGitPushNotFastForwardMessage,
	isRepoSessionApplyPatchCallerMessage,
	isRepoSessionInactiveMessage,
	isRepoSessionNotFoundMessage,
	isRepoSessionStructuralEditCallerMessage,
} from './repo-session-caller-error.ts'

test('isGitPushNotFastForwardError matches isomorphic-git PushRejected non-FF only', () => {
	expect(
		isGitPushNotFastForwardMessage(
			'Push rejected because it was not a simple fast-forward. Use "force: true" to override.',
		),
	).toBe(true)
	expect(
		isGitPushNotFastForwardMessage('Push rejected because tag-exists'),
	).toBe(false)

	const nonFastForward = Object.assign(
		new Error(
			'Push rejected because it was not a simple fast-forward. Use "force: true" to override.',
		),
		{ name: 'PushRejectedError', code: 'PushRejectedError' },
	)
	expect(isGitPushNotFastForwardError(nonFastForward)).toBe(true)

	const tagExists = Object.assign(
		new Error('Push rejected because tag-exists'),
		{ name: 'PushRejectedError', code: 'PushRejectedError' },
	)
	expect(isGitPushNotFastForwardError(tagExists)).toBe(false)

	expect(isGitPushNotFastForwardError(new Error('D1 write failed.'))).toBe(
		false,
	)
})

test('isRepoSessionNotFoundMessage matches missing and wrong-user phrases only', () => {
	expect(
		isRepoSessionNotFoundMessage('Repo session "none" was not found.'),
	).toBe(true)
	expect(
		isRepoSessionNotFoundMessage(
			'Repo session "none" was not found. Use repoListSessions or repoOpenSession to obtain a valid session_id.',
		),
	).toBe(true)
	expect(
		isRepoSessionNotFoundMessage(
			'Repo session "de72ddd6-e277-4f69-a5db-3d6ece06ca6b" was not found for this user.',
		),
	).toBe(true)
	expect(
		isRepoSessionNotFoundMessage(
			'Repo session "de72ddd6-e277-4f69-a5db-3d6ece06ca6b" is published; open a new session before continuing.',
		),
	).toBe(false)
	expect(isRepoSessionNotFoundMessage('Source "abc" was not found.')).toBe(
		false,
	)
	expect(
		isRepoSessionInactiveMessage(
			'Repo session "de72ddd6-e277-4f69-a5db-3d6ece06ca6b" is published; open a new session before continuing.',
		),
	).toBe(true)
})

test('isRepoSessionStructuralEditCallerMessage matches delete and move validation only', () => {
	const callerMessages = [
		'repo session delete edits require path.',
		'repo session delete edit target "src/index.js" was not found.',
		'repo session delete edit target "index.ts" was not found.',
		'repo session delete edit target "index.js" was not found.',
		'repo session move edits require path and to.',
		'repo session move edit source and destination are the same: "src/a.ts".',
		'repo session move edits cannot target the same destination twice: "src/b.ts".',
		'repo session move edit source "src/index.js" was not found.',
		'repo session move edit destination "src/b.ts" already exists.',
		'repo session edits cannot combine a delete/move touching "src/a.ts" with a write/replace/writeJson edit for the same path in one call. Split them into separate repoEditFiles calls.',
	]
	expect(
		callerMessages.filter(
			(message) => !isRepoSessionStructuralEditCallerMessage(message),
		),
	).toEqual([])

	const platformMessages = [
		'Source "abc" was not found.',
		'Manifest "package.json" was not found.',
		'Saved package "demo" was not found.',
		'Repo session "none" was not found.',
		'Path "docs" was not found in the repo session workspace.',
		'repo session write edits require content.',
		'repo session replace edits require search.',
		'repo session writeJson edits require a value.',
		'Failed to read repo session file "index.ts" while collecting workspace snapshot.',
		'repo session delete edit target "src/index.js" was not found. Source "abc" was not found.',
		'repo session delete edit target "" was not found.',
	]
	expect(
		platformMessages.filter((message) =>
			isRepoSessionStructuralEditCallerMessage(message),
		),
	).toEqual([])
})

test('isRepoSessionApplyPatchCallerMessage matches apply-patch caller phrases only', () => {
	const malformed = buildRepoApplyPatchParseCallerMessage(
		'Hunk at line 4 contained invalid line @@ -8,8 +8,8 @@',
	)
	expect(malformed).toContain('git apply patch is malformed:')
	expect(malformed).toContain(
		'Hunk header line counts (the numbers after @@) must match the hunk body.',
	)

	const callerMessages = [
		'git apply patch did not contain any file changes.',
		'git apply patch is missing a target file path.',
		'git apply patch did not apply cleanly to src/index.ts.',
		malformed,
		buildRepoApplyPatchParseCallerMessage(
			'Added line count did not match for hunk at line 3',
		),
		// Legacy wrap from the first KODY-A3 deploy (prefix still matches).
		'git apply patch: Hunk at line 4 contained invalid line @@ -8,8 +8,8 @@',
		// Raw `diff` parse phrases (defense for unwrapped / in-flight DO RPC).
		'Hunk at line 4 contained invalid line @@ -8,8 +8,8 @@',
		'Hunk at line 5 has more lines than expected (expected 1 old lines and 1 new lines)',
		'Added line count did not match for hunk at line 3',
		'Removed line count did not match for hunk at line 2',
		'Missing "+++ ..." file header for a/src/index.ts',
		'Missing "--- ..." file header for b/src/index.ts',
	]
	expect(
		callerMessages.filter(
			(message) => !isRepoSessionApplyPatchCallerMessage(message),
		),
	).toEqual([])

	const platformMessages = [
		'Durable Object storage unavailable',
		'Source "abc" was not found.',
		'repo session delete edit target "src/index.js" was not found.',
		'Failed to read repo session file "index.ts" while collecting workspace snapshot.',
		'git status failed',
		'Hunk header looked wrong but was unrelated platform text',
		'Missing required field for package publish',
	]
	expect(
		platformMessages.filter((message) =>
			isRepoSessionApplyPatchCallerMessage(message),
		),
	).toEqual([])
})
