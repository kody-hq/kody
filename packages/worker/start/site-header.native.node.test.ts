import { expect, test } from 'vitest'
import { usageHrefForAccountMenu } from './components/org-switcher.tsx'

test('usage links stay in a billable route org and fall back for unauthorized scopes', () => {
	const orgs = [
		{ slug: 'ada', personal: true, role: 'owner' as const },
		{ slug: 'acme', personal: false, role: 'owner' as const },
		{ slug: 'member-org', personal: false, role: 'member' as const },
	]
	expect(
		usageHrefForAccountMenu({
			pathname: '/@acme/-/billing',
			organizations: orgs,
			username: 'ada',
		}),
	).toBe('/@acme/-/usage')
	expect(
		usageHrefForAccountMenu({
			pathname: '/@member-org/-/agents',
			organizations: orgs,
			username: 'ada',
		}),
	).toBe('/@ada/-/usage')
	expect(
		usageHrefForAccountMenu({
			pathname: '/@stranger/pkg',
			organizations: orgs,
			username: 'ada',
		}),
	).toBe('/@ada/-/usage')
})
