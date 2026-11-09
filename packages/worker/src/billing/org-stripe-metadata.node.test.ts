import { expect, test } from 'vitest'
import {
	buildOrgBillingMetadata,
	KODY_ORG_ID_METADATA_KEY,
	resolveOrgIdFromStripeMetadata,
} from './org-stripe-metadata.ts'

test('buildOrgBillingMetadata writes only kody_org_id', () => {
	expect(buildOrgBillingMetadata('org-acme')).toEqual({
		kody_org_id: 'org-acme',
	})
})

test('resolveOrgIdFromStripeMetadata reads kody_org_id', () => {
	expect(
		resolveOrgIdFromStripeMetadata({
			[KODY_ORG_ID_METADATA_KEY]: ' org-acme ',
		}),
	).toBe('org-acme')
})

test('resolveOrgIdFromStripeMetadata ignores legacy kody_stable_user_id', () => {
	expect(
		resolveOrgIdFromStripeMetadata({ kody_stable_user_id: 'stable-1' }),
	).toBeNull()
})

test('resolveOrgIdFromStripeMetadata returns null when missing or blank', () => {
	expect(resolveOrgIdFromStripeMetadata(null)).toBeNull()
	expect(resolveOrgIdFromStripeMetadata(undefined)).toBeNull()
	expect(resolveOrgIdFromStripeMetadata({})).toBeNull()
	expect(
		resolveOrgIdFromStripeMetadata({
			[KODY_ORG_ID_METADATA_KEY]: '  ',
		}),
	).toBeNull()
})
