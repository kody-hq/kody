import { createElement } from 'react'
import { expect, test } from 'vitest'
import { PrivacyRoute } from './pages/privacy.tsx'
import { renderStartPage } from './test-support/render-start-page.ts'

test('the hosted privacy policy discloses what a referring org can see', async () => {
	const html = await renderStartPage(createElement(PrivacyRoute), '/privacy')

	expect(html).toContain(
		'If an organization refers you, its billing summary can show your username, whether the referral is pending or rewarded, and the reward date when recorded.',
	)
})
