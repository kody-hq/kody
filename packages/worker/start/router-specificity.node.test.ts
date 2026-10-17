import { expect, test } from 'vitest'
import { createMemoryHistory, createRouter } from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen.ts'

// Match the production-generated tree, without invoking loaders or maintaining
// a second list of route definitions that could drift from the deployed app.
const router = createRouter({
	routeTree,
	history: createMemoryHistory(),
	context: { queryClient: new QueryClient(), getCommittedPage: () => null },
})
function match(path: string) {
	const [, params, route] = router.getMatchedRoutes(path)
	return {
		path: route?.fullPath,
		params,
		exact: Boolean(route && params['**'] === undefined),
	}
}
test('native static nested endpoints beat dynamic siblings', () => {
	for (const [path, expected] of [
		[
			'/account/mcp-servers/oauth/callback',
			'/account/mcp-servers/oauth/callback',
		],
		[
			'/account/mcp-servers/logos/server-id',
			'/account/mcp-servers/logos/$serverId',
		],
		['/admin/users/42', '/admin/users/$stableUserId'],
		['/blog/rss.xml', '/blog/rss.xml'],
		['/docs/connect.md', '/docs/connect.md'],
		[
			'/.well-known/agent-skills/build/SKILL.md',
			'/.well-known/agent-skills/$skillId/SKILL.md',
		],
	] as const) {
		expect(match(path)).toMatchObject({ path: expected, exact: true })
	}
})
test('native suffix parameters strip Markdown and image extensions', () => {
	expect(match('/blog/hello-world.md')).toMatchObject({
		path: '/blog/{$slug}.md',
		params: { slug: 'hello-world' },
		exact: true,
	})
	expect(match('/docs/how-kody-works.md')).toMatchObject({
		path: '/docs/{$slug}.md',
		params: { slug: 'how-kody-works' },
		exact: true,
	})
	expect(match('/og/pricing.png')).toMatchObject({
		path: '/og/{$page}.png',
		params: { page: 'pricing' },
		exact: true,
	})
	expect(match('/profiles/ada/avatar/abcdef.jpg')).toMatchObject({
		path: '/profiles/$username/avatar/$file',
		params: { username: 'ada', file: 'abcdef.jpg' },
		exact: true,
	})
})
test('raw and asset splats accept both their root and nested file paths', () => {
	for (const [root, pattern] of [
		['/community/listing/raw', '/community/$listingId/raw/$'],
		['/community/listing/assets', '/community/$listingId/assets/$'],
		['/@ada/pkg/raw/main', '/@{$username}/$kodyId/raw/$ref/$'],
		['/@ada/pkg/assets', '/@{$username}/$kodyId/assets/$'],
	] as const) {
		expect(match(root)).toMatchObject({ path: pattern, exact: true })
		expect(match(`${root}/src/index.ts`)).toMatchObject({
			path: pattern,
			params: { _splat: 'src/index.ts' },
			exact: true,
		})
	}
})
test('organization management paths do not consume public package paths', () => {
	expect(match('/@ada/-/secrets')).toMatchObject({
		path: '/@{$orgSlug}/-/secrets',
		params: { orgSlug: 'ada' },
		exact: true,
	})
	expect(match('/@ada/package')).toMatchObject({
		path: '/@{$username}/$kodyId',
		params: { username: 'ada', kodyId: 'package' },
		exact: true,
	})
	expect(match('/@ada/package/files/src/index.ts')).toMatchObject({
		path: '/@{$username}/$kodyId/files/$',
		params: { _splat: 'src/index.ts' },
		exact: true,
	})
})

test('approval bundles bind the organization and bundle independently of public package paths', () => {
	expect(match('/@acme/-/approvals/bundle-123')).toMatchObject({
		path: '/@{$orgSlug}/-/approvals/$bundleId',
		params: { orgSlug: 'acme', bundleId: 'bundle-123' },
		exact: true,
	})
})
