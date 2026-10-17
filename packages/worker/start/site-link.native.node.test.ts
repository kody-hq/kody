import { createElement, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
	stripSearchParams,
} from '@tanstack/react-router'
import { memoriesSearch } from './filter-search.ts'
import { expect, test } from 'vitest'
import { SiteLink } from './components/site-link.tsx'
async function renderStartPage(page: ReactNode, href = '/test') {
	const root = createRootRoute()
	const routes = ['/test', '/docs', '/docs/connect', '/onboarding/step-2'].map(
		(path) =>
			createRoute({
				getParentRoute: () => root,
				path,
				component: () => page,
			}),
	)
	const router = createRouter({
		origin: 'https://kody.test',
		routeTree: root.addChildren(routes),
		history: createMemoryHistory({ initialEntries: [href] }),
	})
	await router.load()
	return renderToString(createElement(RouterProvider, { router }))
}

test('exact active links preserve explicit current semantics and default to page', async () => {
	for (const current of ['step', 'true', false, undefined] as const) {
		const html = await renderStartPage(
			createElement(
				SiteLink,
				{ href: '/onboarding/step-2', 'aria-current': current },
				'Step',
			),
			'/onboarding/step-2',
		)
		expect(html).toContain(`aria-current="${current ?? 'page'}"`)
		expect(html).toContain('data-status="active"')
	}
})

test('section links retain caller current state for descendants without marking ordinary parent links active', async () => {
	const current = await renderStartPage(
		createElement(SiteLink, { href: '/docs', 'aria-current': 'page' }, 'Docs'),
		'/docs/connect',
	)
	expect(current).toContain('aria-current="page"')
	const ordinary = await renderStartPage(
		createElement(SiteLink, { href: '/docs' }, 'Docs'),
		'/docs/connect',
	)
	expect(ordinary).not.toContain('aria-current=')
	expect(ordinary).not.toContain('data-status="active"')
})

test('external links remain plain anchors with their supplied accessibility state', async () => {
	const html = await renderStartPage(
		createElement(
			SiteLink,
			{ href: 'https://example.com/docs', 'aria-current': 'location' },
			'External docs',
		),
	)
	expect(html).toContain('href="https://example.com/docs"')
	expect(html).toContain('aria-current="location"')
	expect(html).not.toContain('data-status=')
	expect(html).not.toMatch(/\scurrent=/)
})

test('download links retain browser download semantics without Router interception', async () => {
	const html = await renderStartPage(
		createElement(
			SiteLink,
			{ href: '/account/export.json', download: 'kody.json' },
			'Export',
		),
	)
	expect(html).toContain('href="/account/export.json"')
	expect(html).toContain('download="kody.json"')
	expect(html).not.toContain('data-status=')
})

async function renderMemoryLink(href: string, documentNavigation = false) {
	const root = createRootRoute()
	const route = createRoute({
		getParentRoute: () => root,
		path: '/memories/$memoryId',
		validateSearch: memoriesSearch,
		search: { middlewares: [stripSearchParams({ includeDeleted: false })] },
		staticData: documentNavigation ? { documentNavigation: true as const } : {},
		component: () => createElement(SiteLink, { href }, 'Memory'),
	})
	const router = createRouter({
		origin: 'https://kody.test',
		routeTree: root.addChildren([route]),
		history: createMemoryHistory({ initialEntries: ['/memories/one'] }),
	})
	await router.load()
	return renderToString(createElement(RouterProvider, { router }))
}

test('page links give Router separate pathname, search and hash with native default stripping', async () => {
	for (const includeDeleted of [false, true]) {
		const html = await renderMemoryLink(
			`/memories/one?q=%22123%22&includeDeleted=${includeDeleted}#detail`,
		)
		const href = /href="([^"]+)"/.exec(html)?.[1]?.replaceAll('&amp;', '&')
		expect(href).toBe(
			`/memories/one?q=%22123%22${includeDeleted ? '&includeDeleted=true' : ''}#detail`,
		)
		expect(href?.match(/\?/g)).toHaveLength(1)
	}
	const hashOnly = await renderMemoryLink('/memories/one#detail')
	expect(hashOnly).toContain('href="/memories/one#detail"')
})

test('document links preserve opaque protocol query values and hash exactly', async () => {
	const html = await renderMemoryLink(
		'/memories/one?state=%22opaque%22&includeDeleted=false#detail',
		true,
	)
	expect(html).toContain(
		'href="/memories/one?state=%22opaque%22&amp;includeDeleted=false#detail"',
	)
	expect(html).not.toContain('data-status=')
})
