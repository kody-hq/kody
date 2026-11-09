import {
	ownerIdFromStored,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	grantBindingFields,
	grantHasRetiredConnectionProfile,
	grantMatchesConsentOrg,
	readOrgIdFromGrantMetadata,
	readOrgIdFromGrantProps,
} from './oauth-grant.ts'

test('grantBindingFields stamps the same orgId and personId on props and metadata', () => {
	expect(
		grantBindingFields({
			orgId: ownerIdFromStored('org-1'),
			personId: personIdFromStored('person-1'),
		}),
	).toEqual({
		props: { orgId: 'org-1', personId: 'person-1' },
		metadata: { orgId: 'org-1', personId: 'person-1' },
	})
})

test('readOrgId helpers ignore missing or blank values', () => {
	expect(readOrgIdFromGrantProps({ orgId: ' org-1 ' as OwnerId })).toBe('org-1')
	expect(
		readOrgIdFromGrantMetadata({ orgId: ownerIdFromStored('org-1') }),
	).toBe('org-1')
	expect(readOrgIdFromGrantProps({})).toBeNull()
	expect(readOrgIdFromGrantProps(null)).toBeNull()
	expect(readOrgIdFromGrantProps({ orgId: '  ' as OwnerId })).toBeNull()
	expect(
		readOrgIdFromGrantProps({ userId: ownerIdFromStored('user-1') }),
	).toBeNull()
})

test('grantMatchesConsentOrg matches metadata.orgId only', () => {
	expect(
		grantMatchesConsentOrg({
			metadata: { orgId: ownerIdFromStored('org-acme') },
			userId: ownerIdFromStored('user-1'),
			orgId: ownerIdFromStored('org-acme'),
		}),
	).toBe(true)
	expect(
		grantMatchesConsentOrg({
			metadata: { orgId: ownerIdFromStored('org-acme') },
			userId: ownerIdFromStored('user-1'),
			orgId: ownerIdFromStored('org-ada'),
		}),
	).toBe(false)
	expect(
		grantMatchesConsentOrg({
			metadata: {},
			userId: ownerIdFromStored('user-1'),
			orgId: ownerIdFromStored('user-1'),
		}),
	).toBe(false)
	expect(
		grantMatchesConsentOrg({
			metadata: {},
			userId: ownerIdFromStored('user-1'),
			orgId: ownerIdFromStored('org-acme'),
		}),
	).toBe(false)
})

test('grantHasRetiredConnectionProfile flags only grants stamped with a profile name', () => {
	expect(
		grantHasRetiredConnectionProfile({ connectionProfileName: 'work' }),
	).toBe(true)
	expect(
		grantHasRetiredConnectionProfile({ connectionProfileName: '  ' }),
	).toBe(false)
	expect(
		grantHasRetiredConnectionProfile({ connectionProfileName: null }),
	).toBe(false)
	expect(grantHasRetiredConnectionProfile({ orgId: 'org-1' })).toBe(false)
	expect(grantHasRetiredConnectionProfile(null)).toBe(false)
	expect(grantHasRetiredConnectionProfile('work')).toBe(false)
})
