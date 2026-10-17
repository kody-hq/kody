import { jsx } from '@emotion/react/jsx-runtime'
import { renderStartPage as renderToString } from './test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { renderDocsPager, renderDocsShell } from './pages/docs-shell.tsx'
import { docsIntroSlug } from '#universal/docs-nav.ts'

test('docs shell marks the sidebar and highlights the open page', async () => {
	const html = await renderToString(
		renderDocsShell({
			current: 'oauth',
			children: jsx('p', { children: 'Article' }),
		}),
	)

	expect(html).toContain('data-docs-shell')
	expect(html).toContain('data-docs-nav')
	expect(html).toContain('<details')
	expect(html).toContain('>OAuth (bring your own app)</span>')
	expect(html).toContain('min-height:44px')
	expect(html).toContain('href="/docs/oauth"')
	expect(html).toContain('aria-current="page"')
	expect(html).toContain('data-section-current="true"')
	expect(html).toContain('href="/docs"')
	expect(html).toContain('href="/docs/search-and-execute"')
	expect(html).not.toContain('href="/docs/admin-events"')
	expect(html).not.toContain('data-docs-admin-nav')
	expect(html.indexOf('href="/docs"')).toBeLessThan(
		html.indexOf('href="/docs/search-and-execute"'),
	)
	expect(html.indexOf('href="/docs/search-and-execute"')).toBeLessThan(
		html.indexOf('href="/docs/how-kody-works"'),
	)

	const adminHtml = await renderToString(
		renderDocsShell({
			current: 'admin-events',
			isAdmin: true,
			children: jsx('p', { children: 'Admin article' }),
		}),
	)
	expect(adminHtml).toContain('href="/docs/admin-events"')
	expect(adminHtml).toContain('data-docs-admin-nav="true"')
	expect(adminHtml).toContain('>Admin events</')
})

test('docs sidebar and mobile menu leave room for hanging nav-link focus rings', async () => {
	const html = await renderToString(
		renderDocsShell({
			current: 'text-your-agent',
			children: jsx('p', { children: 'Article' }),
		}),
	)

	// `overflow-y:auto` computes overflow-x to auto, which clips outlines.
	// Links hang 0.6rem left so their pill aligns with heading text; the
	// scroller must pad that hang plus the global 2.5px + 3px focus ring.
	expect(html).toContain('overflow-y:auto')
	expect(html).toContain('padding-left:calc(0.6rem + 8px)')
	expect(html).toContain('margin-left:-0.6rem')
	expect(html).toContain('overflow:visible')
})

test('docs shell treats /docs/connect as the providers section', async () => {
	const html = await renderToString(
		renderDocsShell({
			current: 'connect',
			children: jsx('p', { children: 'Providers' }),
		}),
	)

	expect(html).toContain('href="/docs/connect"')
	expect(html).toMatch(
		/<a(?=[^>]*href="\/docs\/connect")(?=[^>]*aria-current="page")[^>]*>/,
	)
	expect(html).toContain('data-section-current="true"')
})

test('docs pager omits empty placeholders and links neighbors', async () => {
	const first = await renderToString(renderDocsPager(docsIntroSlug))
	expect(first).toContain('href="/docs/search-and-execute"')
	expect(first).not.toContain('<span></span>')
	expect(first).not.toContain('Previous')

	const last = await renderToString(renderDocsPager('platform-friction'))
	expect(last).toContain('Previous')
	expect(last).not.toContain('Next')

	const adminLast = await renderToString(
		renderDocsPager('platform-friction', true),
	)
	expect(adminLast).toContain('href="/docs/admin-events"')
	expect(adminLast).toContain('Next')
})
