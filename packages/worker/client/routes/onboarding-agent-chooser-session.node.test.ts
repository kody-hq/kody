import { expect, test } from 'vitest'
import {
	clearOnboardingAgentChooserSession,
	onboardingAgentChooserSessionKey,
	readRememberedOnboardingAgentChooser,
	rememberOnboardingAgentChooser,
	resolveOnboardingAgentChooser,
} from './onboarding-agent-chooser-session.ts'
import { pickOnboardingAgentChooser } from './onboarding-mcp-clients.ts'

/** Installs a window + sessionStorage stub; dispose restores the globals. */
function installBrowserSession() {
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
	const originalSessionStorage = Object.getOwnPropertyDescriptor(
		globalThis,
		'sessionStorage',
	)
	const store = new Map<string, string>()
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: globalThis,
	})
	Object.defineProperty(globalThis, 'sessionStorage', {
		configurable: true,
		value: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => store.set(key, value),
			removeItem: (key: string) => store.delete(key),
		},
	})
	clearOnboardingAgentChooserSession()
	return {
		store,
		[Symbol.dispose]() {
			clearOnboardingAgentChooserSession()
			for (const [name, descriptor] of [
				['window', originalWindow],
				['sessionStorage', originalSessionStorage],
			] as const) {
				if (descriptor) Object.defineProperty(globalThis, name, descriptor)
				else Reflect.deleteProperty(globalThis, name)
			}
		},
	}
}

test('remembered chooser retains the SSR agent order', async () => {
	using browser = installBrowserSession()
	const ssrPick = pickOnboardingAgentChooser(() => 0)
	const otherPick = pickOnboardingAgentChooser((max) => Math.max(0, max - 1))
	expect(ssrPick.desktopFeatured).not.toEqual(otherPick.desktopFeatured)
	expect(ssrPick.mobileFeatured).not.toEqual(otherPick.mobileFeatured)

	rememberOnboardingAgentChooser(ssrPick)
	expect(readRememberedOnboardingAgentChooser()).toEqual(ssrPick)
	expect(
		JSON.parse(browser.store.get(onboardingAgentChooserSessionKey) ?? 'null'),
	).toEqual(ssrPick)

	expect(resolveOnboardingAgentChooser((max) => Math.max(0, max - 1))).toEqual(
		ssrPick,
	)
})

test('onboarding agent chooser session ignores invalid storage and does not persist on the server', () => {
	{
		using _browser = installBrowserSession()
		sessionStorage.setItem(onboardingAgentChooserSessionKey, '{"nope":true}')
		expect(readRememberedOnboardingAgentChooser()).toBeNull()
		const first = resolveOnboardingAgentChooser(() => 0)
		const reshuffle = pickOnboardingAgentChooser((max) => Math.max(0, max - 1))
		expect(first.desktopFeatured).not.toEqual(reshuffle.desktopFeatured)
		expect(
			resolveOnboardingAgentChooser((max) => Math.max(0, max - 1)),
		).toEqual(first)
	}

	const serverPick = pickOnboardingAgentChooser(() => 0)
	rememberOnboardingAgentChooser(serverPick)
	expect(readRememberedOnboardingAgentChooser()).toBeNull()
})
