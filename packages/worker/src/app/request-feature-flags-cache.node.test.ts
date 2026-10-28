import { expect, test } from 'vitest'
import { featureFlagOrgSlugFromPathname } from './request-feature-flags-cache.ts'

test('org context comes from /@slug page paths only', () => {
	expect(featureFlagOrgSlugFromPathname('/@Team')).toBe('team')
	expect(featureFlagOrgSlugFromPathname('/@team/settings/domains')).toBe('team')
	expect(featureFlagOrgSlugFromPathname('/@team%2Dx/packages')).toBe('team-x')
	expect(featureFlagOrgSlugFromPathname('/account')).toBeNull()
	expect(featureFlagOrgSlugFromPathname('/')).toBeNull()
	expect(featureFlagOrgSlugFromPathname('/@/x')).toBeNull()
	expect(featureFlagOrgSlugFromPathname('/@%E0%A4%A')).toBeNull()
})
