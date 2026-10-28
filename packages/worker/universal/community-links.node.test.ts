import { expect, test } from 'vitest'
import {
	boundOrgSlugForUrls,
	getCommunityListingHref,
	getCommunityPackageHrefFromName,
	orgSectionHrefFromPackageScope,
	packageApprovePublishHrefFromScope,
	packageHrefFromScope,
	packageScopeFromName,
	packageScopeFromNameOrOwner,
	packageSettingsHrefFromScope,
} from '#universal/community-links.ts'

test('community listing hrefs prefer the canonical pair and fall back to the id URL', () => {
	expect(
		getCommunityListingHref({
			listingId: 'listing-1',
			ownerUsername: 'kentcdodds',
			kodyId: 'devin',
		}),
	).toBe('/@kentcdodds/devin')

	expect(
		getCommunityListingHref({
			listingId: 'listing-1',
			listingName: '@kentcdodds/devin',
			kodyId: 'devin',
		}),
	).toBe('/@kentcdodds/devin')

	// Names are validated as scoped, so these are the defensive paths -- and a
	// dead `/@unknown/...` link would be worse than the id URL it replaced.
	expect(
		getCommunityListingHref({ listingId: 'listing-1', listingName: 'devin' }),
	).toBe('/community/listing-1')

	expect(
		getCommunityListingHref({
			listingId: 'listing-1',
			ownerUsername: 'kentcdodds',
			kodyId: null,
		}),
	).toBe('/community/listing-1')
})

test('getCommunityPackageHrefFromName builds the canonical owner path', () => {
	expect(getCommunityPackageHrefFromName('@jane/hn-pulse')).toBe(
		'/@jane/hn-pulse',
	)
	expect(getCommunityPackageHrefFromName('unscoped')).toBeNull()
})

test('packageScopeFromName prefers the owner encoded in the package name', () => {
	expect(packageScopeFromName('@team-org/ci-alerts')).toEqual({
		ownerUsername: 'team-org',
		kodyId: 'ci-alerts',
	})
	expect(packageScopeFromName('ci-alerts')).toBeNull()
})

test('packageScopeFromNameOrOwner ignores a mismatched page-level owner', () => {
	expect(
		packageScopeFromNameOrOwner({
			packageName: '@team-org/ci-alerts',
			ownerUsername: 'personal-handle',
			kodyId: 'ci-alerts',
		}),
	).toEqual({
		ownerUsername: 'team-org',
		kodyId: 'ci-alerts',
	})
	expect(
		packageScopeFromNameOrOwner({
			ownerUsername: 'team-org',
			kodyId: 'ci-alerts',
		}),
	).toEqual({
		ownerUsername: 'team-org',
		kodyId: 'ci-alerts',
	})
})

test('package and org URL helpers build from package scope', () => {
	const scope = packageScopeFromName('@team-org/ci-alerts')
	expect(scope).not.toBeNull()
	if (!scope) return
	expect(packageHrefFromScope(scope)).toBe('/@team-org/ci-alerts')
	expect(packageSettingsHrefFromScope(scope)).toBe(
		'/@team-org/ci-alerts/settings',
	)
	expect(packageApprovePublishHrefFromScope(scope)).toBe(
		'/@team-org/ci-alerts/approve-publish',
	)
	expect(orgSectionHrefFromPackageScope(scope, 'webhooks')).toBe(
		'/@team-org/-/webhooks',
	)
	expect(orgSectionHrefFromPackageScope(scope, 'jobs', 'job-1')).toBe(
		'/@team-org/-/jobs/job-1',
	)
})

test('boundOrgSlugForUrls uses the stamped org slug over the person handle', () => {
	expect(
		boundOrgSlugForUrls({
			username: 'personal-handle',
			request: { org: { slug: 'team-org' } },
		}),
	).toBe('team-org')
	expect(
		boundOrgSlugForUrls({
			username: 'personal-handle',
			request: { org: { slug: null } },
		}),
	).toBe('personal-handle')
})
