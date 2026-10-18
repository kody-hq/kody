import { expect, test } from 'vitest'
import {
	PackagePublishLockedError,
	buildPackagePublishApprovalPath,
	buildPackagePublishApprovalUrl,
	buildPackageUnlockPath,
	buildPackageUnlockUrl,
	isGitCommitSha,
	isSavedPackageLocked,
} from './package-publish-lock.ts'

test('publish lock treats a stored timestamp as locked and builds a commit-named approval URL', () => {
	expect(isSavedPackageLocked(null)).toBe(false)
	expect(isSavedPackageLocked(undefined)).toBe(false)
	expect(isSavedPackageLocked('')).toBe(false)
	expect(isSavedPackageLocked('   ')).toBe(false)
	expect(isSavedPackageLocked('2026-08-28T12:00:00.000Z')).toBe(true)

	expect(isGitCommitSha('7f3a91c')).toBe(false)
	expect(isGitCommitSha('7f3a91c2e8b4d0aa')).toBe(false)
	expect(isGitCommitSha('a'.repeat(64))).toBe(false)
	expect(isGitCommitSha('a'.repeat(40))).toBe(true)
	expect(isGitCommitSha('A'.repeat(40))).toBe(true)
	expect(isGitCommitSha('not-a-sha')).toBe(false)
	expect(isGitCommitSha('')).toBe(false)

	expect(
		buildPackagePublishApprovalPath({
			username: 'user',
			kodyId: 'notes',
			commit: 'abc1234',
		}),
	).toBe('/@user/notes/approve-publish?commit=abc1234')
	expect(
		buildPackagePublishApprovalUrl({
			baseUrl: 'https://kody.codes',
			username: 'user',
			kodyId: 'notes',
			commit: 'abc1234',
		}),
	).toBe('https://kody.codes/@user/notes/approve-publish?commit=abc1234')

	const error = new PackagePublishLockedError({
		packageId: 'pkg-1',
		packageName: '@user/notes',
		pendingCommit: 'abc1234',
		currentPublishedCommit: 'oldcommit',
	})
	expect(error.message).toContain('@user/notes')

	expect(buildPackageUnlockPath({ username: 'user', kodyId: 'notes' })).toBe(
		'/@user/notes/settings',
	)
	expect(
		buildPackageUnlockUrl({
			baseUrl: 'https://kody.codes',
			username: 'user',
			kodyId: 'notes',
		}),
	).toBe('https://kody.codes/@user/notes/settings')
})
