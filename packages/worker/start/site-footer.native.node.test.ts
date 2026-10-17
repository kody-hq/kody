import { createElement } from 'react'
import { expect, test } from 'vitest'
import { SiteFooter } from './components/site-footer.tsx'
import { renderStartPage } from './test-support/render-start-page.ts'

test.each([false, true])(
	'footer preserves public navigation for loggedIn=%s',
	async (loggedIn) => {
		const html = await renderStartPage(
			createElement(SiteFooter, {
				loggedIn,
				loginHref: '/login?returnTo=%2Ffeatures',
			}),
		)
		for (const href of [
			'/features',
			'/community',
			'/discord',
			'/docs',
			'/use-cases',
			'/pricing',
			'/faq',
			'/support',
			'/blog',
			'/privacy',
			'/terms',
			'/for/business',
		])
			expect(html).toContain(`href="${href}"`)
		expect(html).toContain('aria-labelledby="footer-for-heading"')
		expect(html).toContain('id="footer-for-heading"')
		expect(html).toContain(
			loggedIn ? 'href="/account"' : 'href="/login?returnTo=%2Ffeatures"',
		)
	},
)
