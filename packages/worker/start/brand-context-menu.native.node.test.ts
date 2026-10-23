import { expect, test } from 'vitest'
import { createElement as jsx } from 'react'
import { renderStartPage } from './test-support/render-start-page.ts'
import { SiteHeader } from './components/site-header.tsx'

test('site header brand wraps a context-menu host around the home link', async () => {
	const html = await renderStartPage(
		jsx(SiteHeader, {
			loggedIn: false,
			organizationSession: null,
			displayName: '',
			username: '',
			avatarUrl: null,
			showAdminLink: false,
			showDemoIndicator: false,
			loginHref: '/login',
			currentPathname: '/',
		}),
		'/',
	)
	expect(html).toContain('href="/"')
	expect(html).toContain('viewBox="220.727 325.009973 807.440627 593.242027"')
	expect(html).toContain('>Kody</span>')
	// Menu is closed until right-click; SSR should not emit menu items.
	expect(html).not.toContain('Copy logo as SVG')
	expect(html).not.toContain('All brand assets')
})
