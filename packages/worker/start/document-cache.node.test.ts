import { expect, test } from 'vitest'
import { createRouter, createMemoryHistory } from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen.ts'
import { anonymousDocumentCachePolicy } from './document-cache-policy.ts'
import { documentCache } from './document-cache.ts'
const router = createRouter({
	origin: 'https://kody.test',
	routeTree,
	history: createMemoryHistory(),
	context: { queryClient: new QueryClient(), getCommittedPage: () => null },
})
function policy(path: string) {
	return anonymousDocumentCachePolicy(router, path)
}
test('native routes explicitly own anonymous cache eligibility and visibility TTL', () => {
	expect(router.routesById.__root__?.options.server?.middleware).toContain(
		documentCache,
	)
	for (const path of [
		'/',
		'/pricing',
		'/faq',
		'/believe',
		'/case-studies',
		'/for/business',
		'/with/claude',
		'/use-cases/mcp-gateway',
		'/blog',
		'/community',
		'/onboarding/step-1/cursor',
		'/docs/connect',
		'/docs/secrets',
		'/llms.txt',
		'/docs/llms.txt',
		'/login',
		'/signup',
	])
		expect(policy(path)).toBe('marketing')
	for (const path of [
		'/@alice/tool',
		'/@alice/tool/tree/main/src',
		'/community/id',
		'/community/id/files/src',
	])
		expect(policy(path)).toBe('visibility')
	for (const path of [
		'/account',
		'/@alice/tool/settings',
		'/@alice/tool/files/src',
		'/@alice/tool.git',
		'/@alice/tool.git/info/refs',
		'/@alice/-/settings',
		'/verify-email',
		'/oauth/authorize',
		'/_serverFn/example',
		'/docs/nested/unknown',
	])
		expect(policy(path)).toBeUndefined()
})
