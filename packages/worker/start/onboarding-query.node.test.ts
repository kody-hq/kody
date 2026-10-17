import { expect, test, vi } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { loadOnboarding } from '#start/server/onboarding'
import { loadOnboardingRoute, onboardingQuery } from './onboarding-query.ts'
import { canonicalOnboardingAgentChooser } from '#universal/onboarding-mcp-clients.ts'
import { type OnboardingPayload } from '#universal/onboarding-types.ts'

vi.mock('#start/server/onboarding', () => ({ loadOnboarding: vi.fn() }))

test('wizard steps share refreshed progress and isolate it from another actor', async () => {
	const payload: OnboardingPayload = {
		ok: true,
		loggedIn: true,
		username: 'alice',
		emailVerified: true,
		mcpServerUrl: 'https://example.com/mcp',
		setupPrompt: '',
		discoveryPrompt: '',
		persistPrompt: '',
		hasAccessWin: false,
		hasSecondMcpClient: false,
		hasMcpClient: false,
		connectedAgents: [],
		secondAgentStandardGift: {
			received: false,
			active: false,
			status: 'none',
			expiresAt: null,
			grantedAt: null,
		},
		needsOnboarding: true,
		featuredListings: [],
		featuredMcpServers: [],
		customMcpServers: [],
		persistedPackageName: null,
		accessWinMemorySubject: null,
		checklist: null,
	}
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	})
	const options = onboardingQuery('alice', undefined)
	const read = vi.mocked(loadOnboarding)
	read.mockResolvedValue({
		payload,
		canonicalBaseUrl: 'https://example.com',
		onboardingAgentChooser: canonicalOnboardingAgentChooser(),
	})
	const observer = new QueryObserver(client, options)
	const seen: Array<boolean> = []
	const unsubscribe = observer.subscribe((result) => {
		if (result.data) seen.push(result.data.payload.hasMcpClient)
	})
	try {
		const first = await loadOnboardingRoute(
			client,
			options,
			{ pathname: '/onboarding/step-1', searchStr: '' },
			false,
			{ step: 1, agent: null, valid: true },
		)
		expect(first.head.title).toBe('Get started')
		await loadOnboardingRoute(
			client,
			options,
			{ pathname: '/onboarding/step-2', searchStr: '?redirectTo=%2Faccount' },
			false,
			{ step: 2, agent: null, valid: true },
		)
		expect(read).toHaveBeenCalledTimes(1)
		read.mockResolvedValue({
			payload: { ...payload, hasMcpClient: true },
			canonicalBaseUrl: 'https://example.com',
			onboardingAgentChooser: canonicalOnboardingAgentChooser(),
		})
		await observer.refetch()
		await loadOnboardingRoute(
			client,
			options,
			{ pathname: '/onboarding/step-1', searchStr: '' },
			false,
			{ step: 1, agent: null, valid: true },
		)
		expect(read).toHaveBeenCalledTimes(2)
		expect(seen).toContain(false)
		expect(seen.at(-1)).toBe(true)
		expect(
			client.getQueryData(onboardingQuery('bob', undefined).queryKey),
		).toBeUndefined()
		await expect(
			loadOnboardingRoute(
				client,
				options,
				{ pathname: '/onboarding', searchStr: '' },
				false,
				'index',
			),
		).rejects.toMatchObject({ options: { href: '/onboarding/step-2' } })
		// Route selection owns redirect intent even if presentation location differs.
		for (const step of [1, 2, 3] as const) {
			await expect(
				loadOnboardingRoute(
					client,
					options,
					{
						pathname: '/onboarding/step-1',
						searchStr: '?redirectTo=%2Faccount',
					},
					false,
					{ step, agent: null, valid: false },
				),
			).rejects.toMatchObject({
				options: { href: `/onboarding/step-${step}?redirectTo=%2Faccount` },
			})
		}
		read.mockRejectedValueOnce(new Error('Temporary failure'))
		await observer.refetch()
		expect(observer.getCurrentResult().data?.payload.hasMcpClient).toBe(true)
		read.mockResolvedValue({
			payload: { ...payload, emailVerified: false },
			canonicalBaseUrl: 'https://example.com',
			onboardingAgentChooser: canonicalOnboardingAgentChooser(),
		})
		await observer.refetch()
		for (const pathname of [
			'/onboarding',
			'/onboarding/step-1',
			'/onboarding/step-1/cursor',
			'/onboarding/step-2',
			'/onboarding/step-2/github',
			'/onboarding/step-3',
			'/onboarding/step-3/cursor',
		]) {
			await expect(
				loadOnboardingRoute(
					client,
					options,
					{ pathname, searchStr: '?redirectTo=%2Faccount' },
					false,
					'index',
				),
			).rejects.toMatchObject({
				options: { href: '/pending-verification?redirectTo=%2Faccount' },
			})
		}
	} finally {
		unsubscribe()
		client.clear()
	}
})
