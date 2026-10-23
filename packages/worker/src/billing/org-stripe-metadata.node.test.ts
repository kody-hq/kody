import { expect, test, vi } from 'vitest'
import {
	buildOrgBillingMetadata,
	classifyStripeOrgIdMetadataSource,
	KODY_ORG_ID_METADATA_KEY,
	KODY_STABLE_USER_ID_METADATA_KEY,
	resolveOrgIdFromStripeMetadata,
	stripeMetadataOrgIdLegacyFallbackLogEvent,
} from './org-stripe-metadata.ts'

test('buildOrgBillingMetadata dual-writes the same org id on both keys', () => {
	expect(buildOrgBillingMetadata('org-acme')).toEqual({
		kody_org_id: 'org-acme',
		kody_stable_user_id: 'org-acme',
	})
})

test('classifyStripeOrgIdMetadataSource falls back to kody_stable_user_id', () => {
	expect(
		classifyStripeOrgIdMetadataSource({
			[KODY_STABLE_USER_ID_METADATA_KEY]: 'stable-1',
		}),
	).toBe('kody_stable_user_id')
})

test('resolveOrgIdFromStripeMetadata falls back to kody_stable_user_id and logs', () => {
	const info = vi.spyOn(console, 'info').mockImplementation(() => {})
	try {
		expect(
			resolveOrgIdFromStripeMetadata({
				[KODY_STABLE_USER_ID_METADATA_KEY]: 'stable-1',
			}),
		).toBe('stable-1')
		expect(info).toHaveBeenCalledWith(
			stripeMetadataOrgIdLegacyFallbackLogEvent,
			{ source: 'kody_stable_user_id' },
		)
	} finally {
		info.mockRestore()
	}
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
