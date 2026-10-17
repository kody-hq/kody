import { jsx } from 'react/jsx-runtime'
import { expect, test } from 'vitest'
import { renderStartPage } from './test-support/render-start-page.ts'
import { OnboardingMcpClientTabs } from './pages/onboarding-mcp-client-tabs.tsx'
import {
	defaultKodyMcpUrl,
	hermesMcpGuideUrl,
} from '#universal/onboarding-mcp-clients.ts'
const renderTabs = (
	props: Partial<Parameters<typeof OnboardingMcpClientTabs>[0]>,
) =>
	renderStartPage(
		jsx(OnboardingMcpClientTabs, { mcpServerUrl: defaultKodyMcpUrl, ...props }),
	)
test('native agent picker features Hermes and keeps Muse available under Not listed', async () => {
	const picker = await renderTabs({})
	expect(picker).toContain('data-testid="onboarding-agent-hermes"')
	expect(picker).toContain('href="/onboarding/step-1/hermes"')
	expect(picker).toContain('/images/icons/hermes.svg')
	expect(picker).not.toContain('data-testid="onboarding-agent-muse"')
	const more = await renderTabs({ selectedAgent: 'other' })
	expect(more).toContain('data-testid="onboarding-agent-hermes"')
	expect(more).toContain('data-testid="onboarding-agent-muse"')
	expect(more).toContain('href="/onboarding/step-1/muse"')
})
test.each([defaultKodyMcpUrl, 'https://preview.example.com/mcp'])(
	'native Hermes setup uses the selected endpoint %s in CLI and YAML',
	async (mcpServerUrl) => {
		const html = await renderTabs({ selectedAgent: 'hermes', mcpServerUrl })
		const text = html.replace(/<[^>]*>/g, '').replaceAll('&quot;', '"')
		expect(html).toContain('data-agent="hermes"')
		expect(text).toContain(
			`hermes mcp add kody --url ${mcpServerUrl} --auth oauth`,
		)
		expect(text).toContain(`url: "${mcpServerUrl}"`)
		expect(text).toContain('~/.hermes/config.yaml')
		expect(text).toContain('~/.hermes/mcp-tokens/kody.json')
		expect(text).toContain('hermes mcp login kody')
		expect(text).toContain('auth: oauth')
		expect(html).toContain(`href="${hermesMcpGuideUrl}"`)
		expect(html).toContain('data-testid="onboarding-authenticate-callout"')
		expect(html).toContain('data-surface="mobile"')
		expect(html).toContain(
			'Add Kody on the computer or server that runs Hermes',
		)
		expect(html.indexOf('hermes mcp add kody')).toBeLessThan(
			html.indexOf('onboarding-mcp-manual-json'),
		)
		expect(html).toMatch(
			/<details(?![^>]*\bopen\b)[^>]*data-testid="onboarding-mcp-manual-json"/,
		)
	},
)
