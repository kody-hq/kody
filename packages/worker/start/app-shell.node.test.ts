import { expect, test } from 'vitest'
import { createMemoryHistory, createRouter } from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen.ts'
import { appShellForMatches } from './app-shell.ts'
import { appMainCss, mainGutterPaddingCss } from './components/app-layout.ts'

const router = createRouter({
	routeTree,
	history: createMemoryHistory(),
	context: { queryClient: new QueryClient(), getCommittedPage: () => null },
})
function shell(path: string) {
	const [routes, params, route] = router.getMatchedRoutes(path)
	expect(route).toBeDefined()
	expect(params['**']).toBeUndefined()
	return appShellForMatches(
		routes.map((route) => ({ staticData: route.options.staticData ?? {} })),
	)
}

test('the native page routes own their gutters, including nested onboarding and package views', () => {
	for (const path of [
		'/',
		'/404',
		'/500',
		'/features',
		'/features/memory',
		'/features/packages',
		'/features/triggers',
		'/features/credentials',
		'/believe',
		'/with/cursor',
		'/features/apps',
		'/for/business',
		'/pricing',
		'/faq',
		'/case-studies',
		'/blog',
		'/blog/example',
		'/community',
		'/community/listing',
		'/community/listing/files/src/index.ts',
		'/docs',
		'/docs/connect',
		'/docs/how-kody-works',
		'/onboarding',
		'/onboarding/step-1',
		'/onboarding/step-1/claude',
		'/onboarding/step-2',
		'/onboarding/step-2/gmail',
		'/onboarding/step-3',
		'/onboarding/step-3/claude',
		'/use-cases',
		'/use-cases/ai-workflow-automation',
		'/use-cases/claude-code-custom-tools',
		'/use-cases/mcp-gateway',
		'/use-cases/scheduled-workflows',
		'/use-cases/shared-agent-memory',
		'/compare/composio-alternatives',
		'/compare/n8n-alternatives',
		'/integrations/claude',
		'/integrations/gmail',
		'/integrations/slack',
		'/@ada',
		'/@ada/-/repositories',
		'/@ada/example',
		'/@ada/example/settings',
		'/@ada/example/collaborators',
		'/@ada/example/files/src/index.ts',
		'/@ada/example/tree/main/src/index.ts',
		'/account/packages/id/files/src/index.ts',
		'/@ada/-/settings',
		'/@ada/-/collaborators',
	])
		expect(shell(path).gutters).toBe('page')
})

test('auth and focused approval routes select independent shell modes', () => {
	for (const path of ['/login', '/signup'])
		expect(shell(path).mode).toBe('auth')
	for (const path of [
		'/account/packages/id/approve-capabilities',
		'/@ada/example/approve-capabilities',
		'/@ada/-/approvals/bundle',
	]) {
		expect(shell(path)).toMatchObject({ mode: 'focused', gutters: 'app' })
	}
	for (const path of [
		'/account',
		'/@ada/-/jobs',
		'/@ada/example/credentials',
		'/account/packages/id/approve-publish',
	]) {
		expect(shell(path)).toMatchObject({ mode: 'standard', gutters: 'app' })
	}
	expect(shell('/oauth/authorize').preserveLoginReturn).toBe(true)
	expect(shell('/login').preserveLoginReturn).toBe(false)
})

test('unclassified routes use the standard shell and illustrated failures remove app gutters', () => {
	const standard = appShellForMatches([])
	expect(standard).toEqual({
		mode: 'standard',
		gutters: 'app',
		preserveLoginReturn: false,
	})
	expect(appMainCss(standard, false)).toMatchObject(mainGutterPaddingCss)
	expect(appMainCss(standard, true)).not.toHaveProperty('padding')
	expect(appMainCss(shell('/login'), true)).toHaveProperty('display', 'grid')
})
