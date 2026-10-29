import { expect, test } from 'vitest'
import { type OrganizationSummary } from '#universal/org-pages.ts'
import {
	connectOauthTargetOrg,
	orderConnectOauthOrgs,
	shouldPickConnectOauthOrg,
} from './connect-oauth-org.tsx'

const personal: OrganizationSummary = {
	slug: 'test-user',
	displayName: null,
	role: 'owner',
	personal: true,
}
const team: OrganizationSummary = {
	slug: 'test-team',
	displayName: 'Test Team',
	role: 'member',
	personal: false,
}
const href =
	'/connect/oauth?provider=github&authorizeUrl=https%3A%2F%2Fgithub.com%2Flogin%2Foauth%2Fauthorize&tokenUrl=https%3A%2F%2Fgithub.com%2Flogin%2Foauth%2Faccess_token&flow=confidential'

test('multi-org visits without org pick first, defaulting to personal', () => {
	expect(
		shouldPickConnectOauthOrg({
			organizations: [team, personal],
			flowOrg: null,
			href,
		}),
	).toBe(true)
	expect(orderConnectOauthOrgs([team, personal])[0]?.slug).toBe('test-user')
	expect(
		connectOauthTargetOrg({ organizations: [team, personal], flowOrg: null })
			?.slug,
	).toBe('test-user')
})

test('explicit org, single-org, and provider callbacks skip the picker', () => {
	expect(
		shouldPickConnectOauthOrg({
			organizations: [team, personal],
			flowOrg: 'test-team',
			href: `${href}&org=test-team`,
		}),
	).toBe(false)
	expect(
		connectOauthTargetOrg({
			organizations: [team, personal],
			flowOrg: 'test-team',
		})?.slug,
	).toBe('test-team')
	expect(
		shouldPickConnectOauthOrg({
			organizations: [personal],
			flowOrg: null,
			href,
		}),
	).toBe(false)
	expect(
		shouldPickConnectOauthOrg({
			organizations: [team, personal],
			flowOrg: null,
			href: '/connect/oauth?code=abc&state=xyz',
		}),
	).toBe(false)
})
