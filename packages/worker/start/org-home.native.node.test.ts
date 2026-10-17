import { expect, test } from 'vitest'
import { createElement } from 'react'
import { renderStartPage as renderToString } from './test-support/render-start-page.ts'
import { OrgHomePage } from './pages/org-home.tsx'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
const renderOrgHomeMain = (input: {
	slug: string
	handle: string
	role: OrgRole | null
}) =>
	createElement(OrgHomePage, {
		org: { slug: input.slug, displayName: null, role: input.role },
	})

test('org home lists every management section for a member', async () => {
	const html = await renderToString(
		renderOrgHomeMain({
			slug: 'acme',
			handle: '@acme',
			role: 'member',
		}),
	)
	expect(html).toContain('data-testid="org-home-nav"')
	expect(html).toContain('data-testid="org-home-nav-workspace"')
	expect(html).toContain('>Workspace<')
	expect(html).toContain('href="/@acme/-/settings"')
	expect(html).toContain('href="/@acme/-/members"')
	expect(html).toContain('href="/@acme/-/teams"')
	expect(html).toContain('href="/@acme/-/grants"')
	expect(html).toContain('href="/@acme/-/collaborators"')
	expect(html).not.toContain('href="/@acme/-/billing"')
	expect(html).toContain('href="/@acme/-/credentials"')
	expect(html).toContain('href="/@acme/-/jobs"')
	expect(html).toContain('href="/@acme/-/repositories"')
	expect(html).toContain('href="/@acme/-/agents"')
	expect(html).not.toContain('Invite members and share access')
})

test('org home includes billing for owners and hides teams for billing admins', async () => {
	const owner = await renderToString(
		renderOrgHomeMain({
			slug: 'acme',
			handle: '@acme',
			role: 'owner',
		}),
	)
	expect(owner).toContain('href="/@acme/-/billing"')
	expect(owner).toContain('href="/@acme/-/teams"')
	expect(owner).toContain('Invite members and share access')

	const billing = await renderToString(
		renderOrgHomeMain({
			slug: 'acme',
			handle: '@acme',
			role: 'billing',
		}),
	)
	expect(billing).toContain('href="/@acme/-/billing"')
	expect(billing).not.toContain('href="/@acme/-/teams"')
	expect(billing).toContain('href="/@acme/-/settings"')
	expect(billing).not.toContain('Invite members and share access')
})

test('org home hides management nav for collaborators', async () => {
	const html = await renderToString(
		renderOrgHomeMain({
			slug: 'acme',
			handle: '@acme',
			role: null,
		}),
	)
	expect(html).toContain('data-testid="org-home"')
	expect(html).not.toContain('data-testid="org-home-nav"')
	// Grant-only collaborators open Agents via the share step; the
	// workspace step (packages/jobs/credentials) 404s for them, so it stays hidden.
	expect(html).toContain('href="/@acme/-/agents"')
	expect(html).not.toContain('href="/@acme/-/repositories"')
	expect(html).not.toContain('href="/@acme/-/jobs"')
	expect(html).not.toContain('href="/@acme/-/credentials"')
	expect(html).not.toContain('Repositories, agents, credentials, and jobs')
})
