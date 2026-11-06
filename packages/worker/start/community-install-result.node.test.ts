import { expect, test, vi } from 'vitest'
import {
	CommunityInstallInProgressError,
	CommunityInstallLostEnvelopeError,
	communityInstallOutcomeFromLiveFork,
	readCommunityInstallResult,
	resolveCommunityInstallResult,
} from './community-install-result.ts'

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

test('resolveCommunityInstallResult reconciles a lost Start envelope via live fork state', async () => {
	const loadForkState = vi.fn(async () => ({
		state: 'installed' as const,
		targetName: '@nstudio/tanstack-github-dashboard',
		href: '/@nstudio/tanstack-github-dashboard',
	}))
	const outcome = await resolveCommunityInstallResult({
		result: undefined,
		loadForkState,
	})
	expect(loadForkState).toHaveBeenCalledOnce()
	expect(outcome).toEqual(
		communityInstallOutcomeFromLiveFork({
			state: 'installed',
			targetName: '@nstudio/tanstack-github-dashboard',
			href: '/@nstudio/tanstack-github-dashboard',
		}),
	)
	expect(outcome.agentPrompt).toContain('@nstudio/tanstack-github-dashboard')
})

test('resolveCommunityInstallResult waits while live fork is still in progress', async () => {
	const loadForkState = vi
		.fn()
		.mockResolvedValueOnce({
			state: 'in_progress' as const,
			startedAt: '2026-11-06T21:15:00.000Z',
		})
		.mockResolvedValueOnce({
			state: 'adaptation_required' as const,
			targetName: '@nstudio/tanstack-github-dashboard',
			href: '/@nstudio/tanstack-github-dashboard',
		})
	const waitMs = vi.fn(async () => {})
	const outcome = await resolveCommunityInstallResult({
		result: undefined,
		loadForkState,
		waitMs,
		inProgressPollMs: 1,
		maxInProgressPolls: 3,
	})
	expect(waitMs).toHaveBeenCalledWith(1)
	expect(loadForkState).toHaveBeenCalledTimes(2)
	expect(outcome.status).toBe('adaptation_required')
	expect(outcome.targetName).toBe('@nstudio/tanstack-github-dashboard')
})

test('resolveCommunityInstallResult keeps in_progress as non-failure (no retry)', async () => {
	const loadForkState = vi.fn(async () => ({
		state: 'in_progress' as const,
		startedAt: '2026-11-06T21:15:00.000Z',
	}))
	const waitMs = vi.fn(async () => {})
	await expect(
		resolveCommunityInstallResult({
			result: undefined,
			loadForkState,
			waitMs,
			inProgressPollMs: 1,
			maxInProgressPolls: 2,
		}),
	).rejects.toBeInstanceOf(CommunityInstallInProgressError)
	expect(loadForkState).toHaveBeenCalledTimes(3)
})

test('resolveCommunityInstallResult keeps explicit server failures', async () => {
	const loadForkState = vi.fn()
	await expect(
		resolveCommunityInstallResult({
			result: { ok: false, error: 'Catalog entry not found.' },
			loadForkState,
		}),
	).rejects.toThrow('Catalog entry not found.')
	expect(loadForkState).not.toHaveBeenCalled()
})

test('resolveCommunityInstallResult signals a lost envelope when the fork never appears', async () => {
	await expect(
		resolveCommunityInstallResult({
			result: undefined,
			loadForkState: async () => ({ state: 'none' }),
		}),
	).rejects.toBeInstanceOf(CommunityInstallLostEnvelopeError)
})
