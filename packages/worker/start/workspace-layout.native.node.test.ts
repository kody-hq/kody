import { expect, test } from 'vitest'
import { createElement as jsx } from 'react'
import { featureFlagKeys } from '#universal/feature-flags/registry.ts'
import { type SessionInfo } from '#client/session.ts'
import { renderStartPage } from './test-support/render-start-page.ts'
import { WorkspaceLayout } from './components/workspace-layout.tsx'

const session: SessionInfo = {
	email: 'user@example.com',
	username: 'ada',
	emailVerified: true,
	emailVerificationDelivery: null,
	avatarUrl: null,
	roles: ['user'],
	permissions: [],
	featureFlags: Object.fromEntries(
		featureFlagKeys.map((key) => [key, false]),
	) as SessionInfo['featureFlags'],
	organizations: [
		{ slug: 'ada', displayName: 'Ada', role: 'owner', personal: true },
	],
}

test('workspace sidebar brand uses the theme SVG mark and a context-menu host', async () => {
	const html = await renderStartPage(
		jsx(WorkspaceLayout, {}),
		'/account',
		session,
		undefined,
		undefined,
		{
			workspaceLayout: 'private',
			navigation: { rail: 'account', item: 'overview' },
		},
	)
	expect(html).toContain('data-workspace-layout')
	expect(html).toContain('aria-label="Kody home"')
	expect(html).toContain('viewBox="220.727 325.009973 807.440627 593.242027"')
	expect(html).toContain('fill="currentColor"')
	expect(html).not.toContain('src="/images/kody-mark.png"')
	expect(html).toContain('1.75rem')
	expect(html).toContain('0.7rem')
	expect(html).toMatch(/font-family:[^;]*var\(--font-display\)/)
	// Menu is closed until right-click; SSR should not emit menu items.
	expect(html).not.toContain('Copy logo as SVG')
	expect(html).not.toContain('All brand assets')
})
