import { renderStartPage as renderToString } from '../../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import {
	renderInstallStrip,
	renderReadmeSection,
} from '../../components/community-detail-sections.tsx'
test('install strip shows next steps after a successful install', async () => {
	const html = await renderToString(
		renderInstallStrip({
			installMessage: null,
			installOutcome: {
				status: 'installed',
				targetName: '@jane/notion-mcp',
				agentPrompt: 'Call packageGet for @jane/notion-mcp.',
				packageId: 'pkg-1',
				failedChecks: [],
			},
		}),
	)
	expect(html).toContain('data-testid="community-install-next-steps"')
	expect(html).toContain('Installed as @jane/notion-mcp.')
	expect(html).toContain('Use in agent')
})

test('readme section keeps README and only links Agent docs when AGENTS.md is present', async () => {
	const withAgents = await renderToString(
		renderReadmeSection(['Human setup.'], '/@jane/demo/tree/main/AGENTS.md'),
	)
	expect(withAgents).toContain('id="readme-title"')
	expect(withAgents).toContain('README')
	expect(withAgents).toContain('Human setup.')
	expect(withAgents).toContain('data-testid="community-agents-docs-link"')
	expect(withAgents).toContain('href="/@jane/demo/tree/main/AGENTS.md"')

	const withoutAgents = await renderToString(
		renderReadmeSection(['Human setup.']),
	)
	expect(withoutAgents).toContain('id="readme-title"')
	expect(withoutAgents).toContain('README')
	expect(withoutAgents).not.toContain(
		'data-testid="community-agents-docs-link"',
	)
})
