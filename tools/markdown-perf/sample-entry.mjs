import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import createCache from '@emotion/cache'
import { CacheProvider } from '@emotion/react'
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from '@tanstack/react-router'
import { renderMarkdownNodes } from '../../packages/worker/start/components/markdown-view.tsx'
import { collectMarkdownFences } from '../../packages/worker/src/app/highlight-code.ts'
import { tokenizeSnippets } from '../../packages/highlight-worker/src/tokenize.ts'

let currentPage
const route = createRootRoute({ component: () => currentPage })
const router = createRouter({
	routeTree: route,
	history: createMemoryHistory(),
	origin: 'https://kody.test',
})
await router.load()

export function parse(markdown) {
	// Older revisions ignore this extra argument. Docs use first-party parsing.
	return collectMarkdownFences(markdown, true)
}
export function highlight(snippets) {
	return tokenizeSnippets(snippets)
}
export function render(markdown, fences) {
	currentPage = createElement(
		'div',
		null,
		renderMarkdownNodes(markdown, {
			linkPolicy: 'first-party',
			headingOffset: 0,
			headingIds: true,
			copyCodeBlocks: true,
			fences,
		}),
	)
	return renderToStaticMarkup(
		createElement(
			CacheProvider,
			{ value: createCache({ key: 'perf' }) },
			createElement(RouterProvider, { router }),
		),
	)
}
export function pipeline(markdown) {
	return render(markdown, highlight(parse(markdown)))
}
