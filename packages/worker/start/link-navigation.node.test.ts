import { expect, test } from 'vitest'
import { createRouter, createMemoryHistory } from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen.ts'
import { linkNavigation } from './link-navigation.ts'

const router = createRouter({
	routeTree,
	history: createMemoryHistory(),
	origin: 'https://kody.test',
	context: { queryClient: new QueryClient(), getCommittedPage: () => null },
})
test.each([
	['/oauth/authorize', true],
	['/oauth/callback', true],
	['/auth', true],
	['/auth/github/callback', true],
	['/llms.txt', true],
	['/account/export.json', true],
	['/account/memories-export.json', true],
	['/account/connections', false],
	['/account/secrets', false],
	['/pricing', false],
	['/unsubscribe/tips', false],
	['/not-a-route/nested', true],
])('native route owns document navigation for %s', (pathname, document) => {
	expect(linkNavigation(router, pathname).reloadDocument).toBe(document)
})
