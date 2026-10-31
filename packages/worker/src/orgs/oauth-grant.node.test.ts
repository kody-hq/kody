import {
	ownerIdFromStored,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	grantBindingFields,
	grantHasRetiredConnectionProfile,
	grantHasMetadataOrgId,
	grantMatchesConsentOrg,
	readOrgIdFromGrantMetadata,
	readOrgIdFromGrantMetadataOrUserId,
	readOrgIdFromGrantProps,
	readOrgIdFromGrantPropsOrUserId,
	stampOrgIdOnTokenExchange,
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
		readOrgIdFromGrantPropsOrUserId({ userId: ownerIdFromStored('user-1') }),
	).toBe('user-1')
	expect(
		readOrgIdFromGrantPropsOrUserId({
			orgId: ownerIdFromStored('org-1'),
			userId: ownerIdFromStored('user-1'),
		}),
	).toBe('org-1')
})

test('grantHasMetadataOrgId reads plaintext metadata only', () => {
	expect(
		grantHasMetadataOrgId({ metadata: { orgId: 'org-1' }, clientId: 'c' }),
	).toBe(true)
	expect(grantHasMetadataOrgId({ metadata: { orgId: '  ' } })).toBe(false)
	expect(grantHasMetadataOrgId({ metadata: {} })).toBe(false)
	expect(grantHasMetadataOrgId(null)).toBe(false)
})

test('grantMatchesConsentOrg uses metadata.orgId then userId fallback', () => {
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
	).toBe(true)
	expect(
		grantMatchesConsentOrg({
			metadata: {},
			userId: ownerIdFromStored('user-1'),
			orgId: ownerIdFromStored('org-acme'),
		}),
	).toBe(false)
	expect(
		readOrgIdFromGrantMetadataOrUserId({
			metadata: null,
			userId: ownerIdFromStored('user-1'),
		}),
	).toBe('user-1')
})

test('stampOrgIdOnTokenExchange backfills orgId from userId and no-ops when set', () => {
	expect(
		stampOrgIdOnTokenExchange({
			props: { userId: ownerIdFromStored('user-1'), email: 'ada@example.com' },
			grantType: 'refresh_token',
		}),
	).toEqual({
		newProps: {
			userId: ownerIdFromStored('user-1'),
			email: 'ada@example.com',
			orgId: ownerIdFromStored('user-1'),
		},
	})
	expect(
		stampOrgIdOnTokenExchange({
			props: {
				userId: ownerIdFromStored('user-1'),
				orgId: ownerIdFromStored('org-1'),
			},
			grantType: 'authorization_code',
		}),
	).toBeUndefined()
	expect(
		stampOrgIdOnTokenExchange({
			props: {
				userId: ownerIdFromStored('user-1'),
				orgId: ownerIdFromStored('user-1'),
			},
			grantType: 'refresh_token',
		}),
	).toBeUndefined()
	expect(
		stampOrgIdOnTokenExchange({ props: {}, grantType: 'refresh_token' }),
	).toBeUndefined()
	expect(stampOrgIdOnTokenExchange({ props: null })).toBeUndefined()
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
