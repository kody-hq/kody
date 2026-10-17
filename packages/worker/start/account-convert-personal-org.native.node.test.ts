import { jsx } from 'react/jsx-runtime'
import { expect, test } from 'vitest'
import { AccountConvertPersonalOrgPanel } from './pages/account-convert-personal-org-panel.tsx'
import { renderStartPage } from './test-support/render-start-page.ts'
test('native account conversion disclosure names what stays and moves before opening confirmation', async () => {
	const html = await renderStartPage(
		jsx(AccountConvertPersonalOrgPanel, { username: 'old-handle' }),
	)
	expect(html).toContain('Convert personal organization')
	expect(html).toContain(
		'memories, credentials, integrations, and MCP servers move with you',
	)
	expect(html).toContain('data-testid="account-convert-personal-org-start"')
	expect(html.replace(/<[^>]*>/g, '')).toContain('Convert @old-handle')
	expect(html).not.toContain(
		'data-testid="account-convert-personal-org-submit"',
	)
})
