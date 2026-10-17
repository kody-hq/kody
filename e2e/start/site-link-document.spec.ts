import { build } from 'esbuild'
import { expect, test } from '../playwright-utils.ts'

// Bundle the real component into an isolated browser fixture. The production
// application gets no test route, and native click handlers still run.
test('document SiteLinks preserve opaque query values on a hydrated left click', async ({
	page,
	baseURL,
}) => {
	const href =
		'/site-link-document-target?state=%22opaque%22&includeDeleted=false#detail'
	const result = await build({
		stdin: {
			resolveDir: process.cwd(),
			loader: 'tsx',
			contents: `
				import { createElement } from 'react'
				import { createRoot } from 'react-dom/client'
				import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, stripSearchParams } from '@tanstack/react-router'
				import { SiteLink } from './packages/worker/start/components/site-link.tsx'
				import { memoriesSearch } from './packages/worker/start/filter-search.ts'
				const root = createRootRoute()
				const source = createRoute({ getParentRoute: () => root, path: '/site-link-document-fixture', component: () => createElement(SiteLink, { href: ${JSON.stringify(href)}, 'aria-current': 'location' }, 'Continue protocol') })
				const target = createRoute({ getParentRoute: () => root, path: '/site-link-document-target', staticData: { documentNavigation: true }, validateSearch: memoriesSearch, search: { middlewares: [stripSearchParams({ includeDeleted: false })] } })
				const router = createRouter({ origin: window.location.origin, isServer: false, routeTree: root.addChildren([source, target]), history: createMemoryHistory({ initialEntries: ['/site-link-document-fixture'] }) })
				await router.load()
				createRoot(document.getElementById('root')).render(createElement(RouterProvider, { router }))
			`,
		},
		bundle: true,
		write: false,
		format: 'esm',
		platform: 'browser',
		define: { 'process.env.NODE_ENV': '"production"' },
	})
	await page.route('**/site-link-document-fixture', (route) =>
		route.fulfill({
			contentType: 'text/html',
			body: '<!doctype html><div id="root"></div>',
		}),
	)
	await page.route('**/site-link-document-target?**', (route) =>
		route.fulfill({
			contentType: 'text/html',
			body: '<h1>Protocol destination</h1>',
		}),
	)
	await page.goto('/site-link-document-fixture')
	await page.addScriptTag({
		type: 'module',
		content: result.outputFiles[0]!.text,
	})
	const link = page.getByRole('link', { name: 'Continue protocol' })
	await expect(link).toHaveAttribute('href', href)
	await expect(link).toHaveAttribute('aria-current', 'location')
	const requested = page.waitForRequest(
		(request) =>
			request.isNavigationRequest() &&
			new URL(request.url()).pathname === '/site-link-document-target',
	)
	await link.click()
	const request = await requested
	expect(new URL(request.url()).search).toBe(
		'?state=%22opaque%22&includeDeleted=false',
	)
	await expect(page).toHaveURL(new URL(href, baseURL).href)
	await expect(
		page.getByRole('heading', { name: 'Protocol destination' }),
	).toBeVisible()
})
