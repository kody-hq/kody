import { createElement } from 'react'
import { expect, test } from 'vitest'
import { renderStartPage } from './test-support/render-start-page.ts'
import { renderPackageRepoActions } from './components/package-title-actions.tsx'
import { PackageFollowContext } from './components/package-follow-context.ts'

const follow = {
	kind: 'repo' as const,
	loggedIn: true,
	loginHref: '/login?redirectTo=%2F%40owner%2Frepo%23follow',
	repoHref: '/@owner/repo',
	following: false,
}
function actions() {
	return renderPackageRepoActions({
		fork: null,
		publishHref: null,
		packageAppHref: null,
		follow,
	})
}

test('other native package tabs link to the repo follow panel', async () => {
	const html = await renderStartPage(actions(), '/@owner/repo/settings')
	expect(html).toContain('href="/@owner/repo#follow"')
	expect(html).toContain('aria-controls="package-follow-panel"')
	expect(html).toContain('data-following="false"')
	expect(html).toContain('Get pushes from this repository in your workspace.')
})

test('native repo title reflects current follow query and panel state', async () => {
	const html = await renderStartPage(
		createElement(
			PackageFollowContext.Provider,
			{ value: { open: true, following: true, toggle: () => {}, panel: null } },
			actions(),
		),
		'/@owner/repo',
	)
	expect(html).toContain('aria-expanded="true"')
	expect(html).toContain('data-following="true"')
	expect(html).toContain('Following')
})

test('signed-out follow directs to login without exposing panel controls', async () => {
	const html = await renderStartPage(
		renderPackageRepoActions({
			fork: null,
			publishHref: null,
			packageAppHref: null,
			follow: { ...follow, loggedIn: false },
		}),
		'/@owner/repo',
	)
	expect(html).toContain('href="/login?redirectTo=%2F%40owner%2Frepo%23follow"')
	expect(html).not.toContain('aria-controls=')
})

test('Open app is the only app control; a leftover origin href does not render', async () => {
	const html = await renderStartPage(
		renderPackageRepoActions({
			fork: null,
			publishHref: null,
			packageAppHref: '/@owner/packages/demo',
			packageAppOriginHref: 'https://owner.kody.run/packages/demo',
			follow: null,
		}),
		'/@owner/demo',
	)
	expect(html).toContain('data-testid="open-package-app"')
	expect(html).toContain('href="/@owner/packages/demo"')
	expect(html).toContain('<span>Open app</span>')
	expect(html).not.toContain('data-testid="package-app-origin-link"')
	expect(html).not.toContain('owner.kody.run')
})
