import { createElement } from 'react'
import { expect, test } from 'vitest'
import { renderStartPage } from '../test-support/render-start-page.ts'
import { AccountConnectedAppDisconnectOptions } from './account-connected-apps-disconnect-options.tsx'

test('disconnect options render unchecked and hide when no unused credentials remain', async () => {
	const options = await renderStartPage(
		createElement(AccountConnectedAppDisconnectOptions, {
			credentials: [{ id: 'credential-calendar', name: 'Calendar' }],
			selectedIds: new Set<string>(),
			onChange: () => {},
		}),
		'/account/connected-apps',
	)
	expect(options).toContain('Also disconnect <!-- -->Calendar')
	expect(options).not.toContain('credential-calendar')
	expect(options).not.toMatch(/<input[^>]*checked/)

	const empty = await renderStartPage(
		createElement(AccountConnectedAppDisconnectOptions, {
			credentials: [],
			selectedIds: new Set<string>(),
			onChange: () => {},
		}),
		'/account/connected-apps',
	)
	expect(empty).not.toContain('Also disconnect')
})
