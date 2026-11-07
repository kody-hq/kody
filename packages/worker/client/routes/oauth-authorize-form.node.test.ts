import { expect, test } from 'vitest'
import {
	oauthAuthorizeActionsDisabled,
	oauthAuthorizeApproveAriaLabel,
	oauthAuthorizeConsentFormAttrs,
	oauthAuthorizeEmailVerificationDenyDisabled,
	oauthAuthorizeGrantHeading,
	oauthAuthorizeOrgField,
	readOAuthAuthorizeConsentOrgs,
	readOAuthAuthorizeSelectedOrgSlug,
} from './oauth-authorize-form.ts'

test('authorize consent form defaults preserve the OAuth query on native submit', () => {
	const search =
		'?response_type=code&client_id=demo&state=abc&code_challenge=xyz'
	const href = `/oauth/authorize${search}`

	expect(oauthAuthorizeConsentFormAttrs(href)).toEqual({
		method: 'post',
		action: href,
	})
	expect(oauthAuthorizeConsentFormAttrs(`https://kody.codes${href}`)).toEqual({
		method: 'post',
		action: href,
	})

	// Consent actions stay disabled until hydration and a ready status.
	const actions: Array<[boolean, boolean, boolean]> = [
		[false, true, true],
		[true, true, false],
		[true, false, true],
	]
	expect(
		actions.filter(
			([hydrated, statusReady, want]) =>
				oauthAuthorizeActionsDisabled({
					hydrated,
					statusReady,
					submitting: false,
					sessionLoading: false,
					needsEmailVerification: false,
				}) !== want,
		),
	).toEqual([])

	expect(
		oauthAuthorizeApproveAriaLabel({
			hydrated: false,
			label: 'Approve connection',
		}),
	).toBe('Approve connection (available after the page finishes loading)')
	expect(
		oauthAuthorizeApproveAriaLabel({
			hydrated: true,
			label: 'Approve connection',
		}),
	).toBeUndefined()

	const deny: Array<[boolean, boolean, boolean]> = [
		[false, false, true],
		[true, false, false],
		[true, true, true],
	]
	expect(
		deny.filter(
			([hydrated, submitting, want]) =>
				oauthAuthorizeEmailVerificationDenyDisabled({
					hydrated,
					submitting,
					sessionLoading: false,
				}) !== want,
		),
	).toEqual([])
})

test('consent org field hides the picker for a sole org and requires a pick when several', () => {
	expect(oauthAuthorizeGrantHeading(null)).toBe('This agent gets full access')
	expect(oauthAuthorizeGrantHeading('acme')).toBe(
		'This agent gets full access in @acme',
	)
	expect(
		oauthAuthorizeOrgField({
			orgs: [{ slug: 'ada', displayName: 'Ada', role: 'owner' }],
			selectedOrgSlug: 'ada',
			signedIn: true,
		}),
	).toEqual({ kind: 'hidden', slug: 'ada' })
	expect(
		oauthAuthorizeOrgField({
			orgs: [
				{ slug: 'acme', displayName: 'Acme', role: 'member' },
				{ slug: 'ada', displayName: 'Ada', role: 'owner' },
			],
			selectedOrgSlug: 'acme',
			signedIn: true,
		}),
	).toEqual({
		kind: 'picker',
		selectedSlug: 'acme',
		options: [
			{ slug: 'acme', displayName: 'Acme', role: 'member' },
			{ slug: 'ada', displayName: 'Ada', role: 'owner' },
		],
	})
	const requiredOrgs = [
		{ slug: 'acme', displayName: 'Acme', role: 'member' },
		{ slug: 'ada', displayName: 'Ada', role: 'owner' },
	]
	expect(
		oauthAuthorizeOrgField({
			orgs: requiredOrgs,
			selectedOrgSlug: 'ada',
			signedIn: true,
			requiredOrgSlug: 'ada',
			requiredReason: 'Stay on ada for this client.',
		}),
	).toEqual({
		kind: 'locked',
		slug: 'ada',
		reason: 'Stay on ada for this client.',
		options: requiredOrgs,
	})
	expect(
		oauthAuthorizeOrgField({
			orgs: requiredOrgs,
			selectedOrgSlug: 'ada',
			signedIn: true,
			requiredOrgSlug: 'ADA',
		}),
	).toMatchObject({
		kind: 'locked',
		slug: 'ada',
		reason: expect.stringContaining('@ada'),
	})
	expect(
		oauthAuthorizeOrgField({
			orgs: [{ slug: 'ada', displayName: 'Ada', role: 'owner' }],
			selectedOrgSlug: 'ada',
			signedIn: true,
			requiredOrgSlug: 'ada',
		}),
	).toEqual({ kind: 'hidden', slug: 'ada' })
	expect(
		oauthAuthorizeOrgField({
			orgs: requiredOrgs,
			selectedOrgSlug: 'acme',
			signedIn: true,
			requiredOrgSlug: 'missing',
		}),
	).toEqual({ kind: 'missing' })
	expect(
		oauthAuthorizeOrgField({
			orgs: [],
			selectedOrgSlug: null,
			signedIn: true,
		}),
	).toEqual({ kind: 'missing' })
	expect(
		oauthAuthorizeOrgField({
			orgs: [],
			selectedOrgSlug: null,
			signedIn: false,
		}),
	).toEqual({ kind: 'pending' })
	expect(
		readOAuthAuthorizeConsentOrgs([
			{ slug: 'Acme', displayName: 'Acme', role: 'owner' },
			{ slug: '' },
			null,
		]),
	).toEqual([{ slug: 'acme', displayName: 'Acme', role: 'owner' }])
	expect(readOAuthAuthorizeSelectedOrgSlug(' Acme ')).toBe('acme')
})
