import { expect, test } from 'vitest'
import { readCommunityInstallResult } from './community-install-result.ts'

test('readCommunityInstallResult accepts a successful install payload', () => {
	expect(
		readCommunityInstallResult({
			ok: true,
			status: 'installed',
			targetName: '@nwalker/tanstack-github-dashboard',
			agentPrompt: 'Review then publish.',
			packageId: 'pkg-1',
			alreadyInstalled: false,
		}),
	).toEqual({
		status: 'installed',
		targetName: '@nwalker/tanstack-github-dashboard',
		agentPrompt: 'Review then publish.',
		packageId: 'pkg-1',
		failedChecks: [],
		alreadyInstalled: false,
	})
})

test('readCommunityInstallResult surfaces server error text when ok is false', () => {
	expect(() =>
		readCommunityInstallResult({
			ok: false,
			error:
				'Catalog entry snapshot for "listing-1" was not found and could not be recovered from the origin repository.',
		}),
	).toThrow(/Catalog entry snapshot/)
})

test('readCommunityInstallResult does not throw undefined.ok when the payload is missing', () => {
	expect(() => readCommunityInstallResult(undefined)).toThrow(
		'Unable to install this public package.',
	)
	expect(() => readCommunityInstallResult(null)).toThrow(
		'Unable to install this public package.',
	)
})
