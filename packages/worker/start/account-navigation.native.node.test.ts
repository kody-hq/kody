import { createElement } from 'react'
import { expect, test } from 'vitest'
import { renderStartPage } from './test-support/render-start-page.ts'
import {
	AccountPageHeader,
	AccountManagementShell,
} from './pages/account-management-components.tsx'

async function header(path: string) {
	return renderStartPage(
		createElement(AccountManagementShell, {
			currentHref: path,
			children: createElement(AccountPageHeader, {
				title: 'Test',
				description: '',
				currentHref: path,
			}),
		}),
		path,
	)
}

test('workspace rail groups Activity siblings as native navigation tabs', async () => {
	const html = await header('/@acme/-/workflows')
	expect(html).toContain('aria-label="Activity pages"')
	expect(html).toMatch(
		/<a(?=[^>]*href="\/@acme\/-\/workflows")(?=[^>]*aria-current="page")[^>]*>/,
	)
	expect(html).toContain('href="/@acme/-/waiting"')
	expect(html).toContain('href="/@acme/-/agents"')
})

test('workspace settings do not duplicate Activity tabs in the rail', async () => {
	const html = await header('/@acme/-/settings')
	expect(html).toContain('href="/@acme/-/activity"')
	expect(html).toContain('href="/@acme/-/agents"')
	expect(html).not.toContain('href="/@acme/-/workflows"')
	expect(html).not.toContain('href="/@acme/-/waiting"')
})

test('personal account rail keeps account chrome without legacy usage links', async () => {
	const html = await header('/account')
	expect(html).toContain('href="/account/security"')
	expect(html).toContain('href="/account/organizations"')
	expect(html).not.toContain('href="/account/usage"')
	expect(html).not.toContain('Usage &amp; credits')
	expect(html).not.toContain('account-section-tabs')
})

test('empty workspace shells reserve the navigation column in server-rendered markup', async () => {
	const html = await header('/@acme/-/jobs')
	expect(
		html.match(/<div(?=[^>]*data-account-navigation(?:[\s=>]))[^>]*>/g),
	).toHaveLength(1)
	expect(
		html.match(/<nav(?=[^>]*data-account-nav(?:[\s=>]))[^>]*>/g),
	).toHaveLength(1)
	expect(
		html.match(/<div(?=[^>]*data-account-content(?:[\s=>]))[^>]*>/g),
	).toHaveLength(1)
	expect(html.indexOf('data-account-navigation')).toBeLessThan(
		html.indexOf('data-account-content'),
	)
	expect(html).toMatch(/grid-template-columns:200px minmax\(0,\s*1fr\)/)
	// Sticky top matches the header block; padding restores the 5rem content line.
	expect(html).toMatch(
		/position:\s*sticky[^}]*top:\s*calc\(0\.8rem \+ 44px \+ 0\.8rem \+ 1px\)/,
	)
	expect(html).toMatch(
		/padding-top:\s*calc\(5rem - calc\(0\.8rem \+ 44px \+ 0\.8rem \+ 1px\)\)/,
	)
	expect(html).toContain('href="/@acme/-/agents"')
})

test('navless shells do not acquire workspace navigation', async () => {
	const html = await renderStartPage(
		createElement(AccountManagementShell, {
			children: createElement('h1', null, 'Verify your email'),
		}),
		'/pending-verification',
	)
	expect(html).not.toContain('data-account-nav')
	expect(html).toContain('data-account-content')
	expect(html).toContain('Verify your email')
})

test('focused matched route hides the rail without inferring policy from its URL', async () => {
	const html = await renderStartPage(
		createElement(AccountManagementShell, {
			currentHref: '/@acme/-/jobs',
			children: 'Review',
		}),
		'/@acme/-/jobs',
		null,
		undefined,
		{ mode: 'focused' },
	)
	expect(html).not.toContain('aria-label="Activity pages"')
	expect(html).toContain('Review')
})
