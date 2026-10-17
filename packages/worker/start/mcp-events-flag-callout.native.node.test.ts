import { renderStartPage as renderToString } from './test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { renderMcpEventsFlagCallout } from './pages/mcp-events-flag-callout.tsx'
import { routes } from '#universal/routes.ts'

test('mcp events flag callout covers logged-out, opt-in, and already-on', async () => {
	const loggedOut = await renderToString(
		renderMcpEventsFlagCallout({ loggedIn: false, enabled: false }),
	)
	expect(loggedOut).toContain('data-testid="mcp-events-flag-callout"')
	expect(loggedOut).toContain('data-testid="mcp-events-flag-login"')
	expect(loggedOut).toContain(
		`href="${routes.login.href()}?redirectTo=${encodeURIComponent(routes.docDetail.href({ slug: 'mcp-events' }))}"`,
	)
	expect(loggedOut).not.toContain('data-testid="mcp-events-flag-opt-in"')

	const loggedIn = await renderToString(
		renderMcpEventsFlagCallout({ loggedIn: true, enabled: false }),
	)
	expect(loggedIn).toContain('data-testid="mcp-events-flag-opt-in"')
	expect(loggedIn).toContain('type="button"')
	expect(loggedIn).not.toContain('data-testid="mcp-events-flag-login"')

	const alreadyOn = await renderToString(
		renderMcpEventsFlagCallout({ loggedIn: true, enabled: true }),
	)
	expect(alreadyOn).toContain('You are trying MCP Events')
	expect(alreadyOn).not.toContain('data-testid="mcp-events-flag-opt-in"')
	expect(alreadyOn).not.toContain('data-testid="mcp-events-flag-login"')
})
