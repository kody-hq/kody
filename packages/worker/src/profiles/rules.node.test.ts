import { expect, test } from 'vitest'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import {
	canActOnProfile,
	chainExpiry,
	checkProfileGrants,
	isExpiryExtension,
	profileStatus,
	type RequestedProfileGrant,
} from './rules.ts'

const me = 'user_me'
const chain = [
	{ id: 'prf_root', acting_user_id: me },
	{ id: 'prf_mid', acting_user_id: me },
	{ id: 'prf_leaf', acting_user_id: me },
]

test('the person controls every profile they act for', () => {
	const actor = { userId: me, profileId: null, isOwner: false }
	for (const action of ['read', 'edit', 'revoke', 'create_child'] as const) {
		expect(canActOnProfile({ actor, targetChain: chain, action })).toBe(true)
	}
})

test('a profile manages only strict descendants, never itself, an ancestor, or a sibling', () => {
	const actor = { userId: me, profileId: 'prf_mid', isOwner: false }
	expect(canActOnProfile({ actor, targetChain: chain, action: 'edit' })).toBe(
		true,
	)
	// self
	expect(
		canActOnProfile({ actor, targetChain: chain.slice(0, 2), action: 'edit' }),
	).toBe(false)
	expect(
		canActOnProfile({
			actor,
			targetChain: chain.slice(0, 2),
			action: 'revoke',
		}),
	).toBe(false)
	// ancestor
	expect(
		canActOnProfile({ actor, targetChain: chain.slice(0, 1), action: 'edit' }),
	).toBe(false)
	// sibling: same parent, different id
	expect(
		canActOnProfile({
			actor,
			targetChain: [chain[0]!, { id: 'prf_sibling', acting_user_id: me }],
			action: 'edit',
		}),
	).toBe(false)
	// a child of itself is allowed
	expect(
		canActOnProfile({
			actor,
			targetChain: chain.slice(0, 2),
			action: 'create_child',
		}),
	).toBe(true)
})

test('an Owner may read and revoke another member’s profile but never edit it', () => {
	const actor = { userId: 'user_owner', profileId: null, isOwner: true }
	expect(canActOnProfile({ actor, targetChain: chain, action: 'read' })).toBe(
		true,
	)
	expect(canActOnProfile({ actor, targetChain: chain, action: 'revoke' })).toBe(
		true,
	)
	expect(canActOnProfile({ actor, targetChain: chain, action: 'edit' })).toBe(
		false,
	)
	expect(
		canActOnProfile({ actor, targetChain: chain, action: 'create_child' }),
	).toBe(false)
	const member = { userId: 'user_other', profileId: null, isOwner: false }
	expect(
		canActOnProfile({ actor: member, targetChain: chain, action: 'read' }),
	).toBe(false)
})

test('expiry only shortens', () => {
	expect(isExpiryExtension({ current: null, next: '2030-01-01' })).toBe(false)
	expect(isExpiryExtension({ current: '2030-01-01', next: '2029-01-01' })).toBe(
		false,
	)
	expect(isExpiryExtension({ current: '2030-01-01', next: '2031-01-01' })).toBe(
		true,
	)
	expect(isExpiryExtension({ current: '2030-01-01', next: null })).toBe(true)
})

test('status and effective expiry follow the whole chain', () => {
	const now = '2030-01-01T00:00:00.000Z'
	const live = { revoked_at: null, expires_at: null }
	expect(profileStatus([live, live], now)).toBe('active')
	expect(
		profileStatus([{ revoked_at: '2029-01-01', expires_at: null }, live], now),
	).toBe('parent_inactive')
	expect(
		profileStatus([live, { revoked_at: null, expires_at: '2029-12-31' }], now),
	).toBe('expired')
	expect(
		profileStatus([live, { revoked_at: '2029-01-01', expires_at: null }], now),
	).toBe('revoked')
	expect(
		chainExpiry([
			{ expires_at: '2031-01-01' },
			{ expires_at: null },
			{ expires_at: '2030-06-01' },
		]),
	).toBe('2030-06-01')
})

const packageGrant = (
	permissions: Array<OrgPermission>,
): RequestedProfileGrant => ({
	resourceType: 'package',
	resourceId: 'pkg_1',
	permissions,
})

test('a profile grant beyond what the creator holds is refused', () => {
	expect(
		checkProfileGrants({
			grants: [packageGrant(['package:read', 'package:write'])],
			parentGrants: null,
			callerHolds: (_type, _id, permission) => permission === 'package:read',
		}),
	).toMatchObject({
		code: 'profile_grant_exceeds_caller',
		permission: 'package:write',
	})
})

test('a sub-profile grant beyond its parent chain is refused', () => {
	expect(
		checkProfileGrants({
			grants: [packageGrant(['package:execute'])],
			parentGrants: new Map([['package:pkg_1', new Set(['package:read'])]]),
			callerHolds: () => true,
		}),
	).toMatchObject({
		code: 'profile_grant_exceeds_parent',
		permission: 'package:execute',
	})
	expect(
		checkProfileGrants({
			grants: [packageGrant(['package:read'])],
			parentGrants: new Map([['package:pkg_1', new Set(['package:read'])]]),
			callerHolds: () => true,
		}),
	).toBeNull()
})

test('org-wide and cross-kind grants are refused', () => {
	expect(
		checkProfileGrants({
			grants: [
				{
					resourceType: 'org' as never,
					resourceId: 'org_1',
					permissions: ['package:read'],
				},
			],
			parentGrants: null,
			callerHolds: () => true,
		}),
	).toMatchObject({ code: 'profile_grant_not_allowed' })
	expect(
		checkProfileGrants({
			grants: [packageGrant(['app:read'])],
			parentGrants: null,
			callerHolds: () => true,
		}),
	).toMatchObject({ code: 'profile_grant_not_allowed' })
	expect(
		checkProfileGrants({
			grants: [
				{
					resourceType: 'credential',
					resourceId: 'cred_1',
					permissions: ['secret:read'],
				},
			],
			parentGrants: null,
			callerHolds: () => true,
		}),
	).toMatchObject({ code: 'profile_grant_not_allowed' })
})
