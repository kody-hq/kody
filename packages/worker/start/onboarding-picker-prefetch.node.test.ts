import { createElement as jsx } from 'react'
import { renderStartPage } from './test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { onboardingStep3EcosystemGroups } from '#universal/onboarding-agent-ecosystems.ts'
import { canonicalOnboardingAgentChooser } from '#universal/onboarding-mcp-clients.ts'
import { onboardingSecondAgentHref } from '#universal/onboarding-process.ts'
import { OnboardingMcpClientTabs } from './pages/onboarding-mcp-client-tabs.tsx'
import { defaultKodyMcpUrl } from '#client/routes/onboarding-mcp-clients.ts'
import { onboardingAgentPickerPrefetchHrefs } from '#client/routes/onboarding-picker-prefetch.ts'

function chipHrefsFromHtml(html: string, testIdPrefix: string) {
	return [...html.matchAll(/<a\b[^>]*>/g)]
		.map((match) => match[0])
		.filter((tag) => tag.includes(`data-testid="${testIdPrefix}`))
		.map((tag) => tag.match(/href="([^"]+)"/)?.[1] ?? '')
}

test('step 1 picker prefetch matches every rendered chip', async () => {
	const chooser = canonicalOnboardingAgentChooser()
	const agentHrefs = onboardingAgentPickerPrefetchHrefs(null, chooser)
	const agentHtml = await renderStartPage(
		jsx(OnboardingMcpClientTabs, { mcpServerUrl: defaultKodyMcpUrl }),
		'/onboarding/step-1',
	)
	expect(chipHrefsFromHtml(agentHtml, 'onboarding-agent-')).toEqual(agentHrefs)
	expect(agentHrefs).toContain('/onboarding/step-1/cursor')
	expect(agentHrefs).toContain('/onboarding/step-1/not-listed')
	expect(agentHrefs).toContain('/onboarding/step-1/chatgpt')
	expect(onboardingAgentPickerPrefetchHrefs('cursor', chooser)).toEqual([])
})

test('step 3 picker prefetch uses second-agent hrefs and keeps search', async () => {
	const search = '?redirectTo=%2Faccount'
	const chooser = canonicalOnboardingAgentChooser()
	const step3Ids = onboardingStep3EcosystemGroups.flatMap((group) => [
		...group.agents,
	])
	const hrefs = onboardingAgentPickerPrefetchHrefs(
		null,
		chooser,
		search,
		onboardingSecondAgentHref,
		step3Ids,
	)
	const html = await renderStartPage(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: defaultKodyMcpUrl,
			search,
			agentHref: onboardingSecondAgentHref,
			ecosystemGroups: onboardingStep3EcosystemGroups,
			greyedAgents: ['chatgpt', 'codex'],
			greyedReasons: {
				chatgpt: 'connected',
				codex: 'connected',
			},
			greyedTitles: {
				chatgpt: 'Already connected.',
				codex: 'Already connected.',
			},
		}),
		'/onboarding/step-3',
	)
	expect(hrefs).toContain(`/onboarding/step-3/cursor-local${search}`)
	expect(hrefs).toContain(`/onboarding/step-3/claude-code${search}`)
	expect(html).toContain(
		'href="/onboarding/step-3/cursor-local?redirectTo=%2Faccount"',
	)
	expect(html).toContain('data-greyed="true"')
	expect(html).toContain('data-testid="onboarding-agent-chatgpt"')
	// Connected mark keeps the card as a link so connect steps stay reachable.
	expect(html).toContain(
		'href="/onboarding/step-3/chatgpt?redirectTo=%2Faccount"',
	)
	expect(html).toMatch(
		/<a(?=[^>]*href="\/onboarding\/step-3\/chatgpt\?redirectTo=%2Faccount")(?=[^>]*data-greyed="true")[^>]*>/,
	)
	expect(html).toContain(
		'href="/onboarding/step-3/codex?redirectTo=%2Faccount"',
	)
})
