import { orgPermissions } from '@kody-internal/shared/org-permissions.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { expect, test } from 'vitest'
import {
	checkOrgWide,
	checkPermission,
	type EffectivePermissions,
	type OrgResource,
	type ProfileChainAccess,
	type ProfileChainLayer,
	resourceListScope,
} from './authorize.ts'

const orgId = ownerIdFromStored('org-1')
const pkg: OrgResource = { type: 'package', id: 'pkg-1', orgId, label: 'tools' }
const other: OrgResource = { type: 'package', id: 'pkg-2', orgId }

function layer(
	name: string,
	self: boolean,
	grants: Record<string, Array<OrgPermission>>,
	orgLevel: Array<OrgPermission> = [],
): ProfileChainLayer {
	return {
		id: `prf_${name}`,
		name,
		self,
		orgPermissions: new Set(orgLevel),
		resourcePermissions: new Map(
			Object.entries(grants).map(([key, list]) => [key, new Set(list)]),
		),
	}
}

function access(
	chain: ProfileChainAccess,
	overrides: Partial<EffectivePermissions> = {},
): EffectivePermissions {
	return {
		orgId,
		permissions: new Set(orgPermissions),
		isOwner: true,
		resourcePermissions: new Map(),
		credentialScopes: null,
		profileGrants: null,
		profileChain: chain,
		...overrides,
	}
}

const both = (permissions: Array<OrgPermission>) => ({
	'package:pkg-1': permissions,
})

test('an Owner acting as a profile only reaches what every layer was granted', () => {
	const effective = access({
		inactive: null,
		layers: [
			layer('helper', true, both(['package:read', 'package:execute'])),
			layer('agent', false, both(['package:read', 'package:execute'])),
		],
	})
	expect(checkPermission(effective, 'package:execute', pkg).allowed).toBe(true)
	const denied = checkPermission(effective, 'package:execute', other)
	expect(denied).toMatchObject({
		allowed: false,
		error: { code: 'profile_grant' },
	})
	if (!denied.allowed) expect(denied.error.message).toContain('"helper"')
})

test('a denial names the blocking ancestor when the profile itself holds the grant', () => {
	const effective = access({
		inactive: null,
		layers: [
			layer('helper', true, both(['package:read', 'package:write'])),
			layer('agent', false, both(['package:read'])),
		],
	})
	const denied = checkPermission(effective, 'package:write', pkg)
	expect(denied.allowed).toBe(false)
	if (!denied.allowed) {
		expect(denied.error.code).toBe('profile_grant')
		expect(denied.error.message).toContain('Parent profile "agent"')
	}
})

test('a revoked or expired layer blocks everything and says which one', () => {
	const effective = access({
		inactive: {
			id: 'prf_agent',
			name: 'agent',
			self: false,
			reason: 'expired',
		},
		layers: [
			layer('helper', true, both(['package:read'])),
			layer('agent', false, both(['package:read'])),
		],
	})
	const denied = checkPermission(effective, 'package:read', pkg)
	expect(denied.allowed).toBe(false)
	if (!denied.allowed) {
		expect(denied.error.code).toBe('profile_inactive')
		expect(denied.error.message).toContain('Parent profile "agent" is expired')
	}
})

test('the person still caps the profile: missing person access wins', () => {
	const effective = access(
		{ inactive: null, layers: [layer('helper', true, both(['package:read']))] },
		{ isOwner: false, permissions: new Set() },
	)
	expect(checkPermission(effective, 'package:read', pkg)).toMatchObject({
		allowed: false,
		error: { code: 'missing_permission' },
	})
})

test('profiles never get org-wide family reads; lists narrow to granted ids', () => {
	const effective = access({
		inactive: null,
		layers: [
			layer('helper', true, {
				'package:pkg-1': ['package:read'],
				'package:pkg-2': ['package:read'],
			}),
			layer('agent', false, both(['package:read'])),
		],
	})
	expect(checkOrgWide(effective, 'package:read').allowed).toBe(false)
	const scope = resourceListScope(effective, 'package:read', 'package')
	expect(scope).toEqual({ kind: 'granted', ids: new Set(['pkg-1']) })
})

test('org-level allowlist permissions pass only when every layer holds them', () => {
	const allowed = access({
		inactive: null,
		layers: [
			layer('helper', true, {}, ['org:execute']),
			layer('agent', false, {}, ['org:execute']),
		],
	})
	expect(checkOrgWide(allowed, 'org:execute').allowed).toBe(true)
	const blocked = access({
		inactive: null,
		layers: [
			layer('helper', true, {}, ['org:execute']),
			layer('agent', false, {}, []),
		],
	})
	expect(checkOrgWide(blocked, 'org:execute')).toMatchObject({
		allowed: false,
		error: { code: 'profile_grant' },
	})
})

test('unprofiled access is unchanged', () => {
	const { profileChain: _drop, ...unprofiled } = access({
		inactive: null,
		layers: [],
	})
	expect(checkPermission(unprofiled, 'package:write', other).allowed).toBe(true)
	expect(resourceListScope(unprofiled, 'package:read', 'package')).toEqual({
		kind: 'all',
	})
})

test('a publish-time import denial names the blocking layer', () => {
	const imported: OrgResource = {
		type: 'package',
		id: 'pkg-1',
		orgId,
		label: '@acme/lib',
	}
	const selfMissing = checkPermission(
		access({
			inactive: null,
			layers: [
				layer('helper', true, {}),
				layer('agent', false, both(['package:execute'])),
			],
		}),
		'package:execute',
		imported,
	)
	expect(selfMissing).toMatchObject({ allowed: false })
	if (!selfMissing.allowed) {
		expect(selfMissing.error.message).toContain('Profile "helper"')
		expect(selfMissing.error.message).toContain('@acme/lib')
	}
	const ancestorMissing = checkPermission(
		access({
			inactive: null,
			layers: [
				layer('helper', true, both(['package:execute'])),
				layer('agent', false, {}),
			],
		}),
		'package:execute',
		imported,
	)
	if (!ancestorMissing.allowed) {
		expect(ancestorMissing.error.message).toContain('Parent profile "agent"')
	} else {
		throw new Error('expected the ancestor to block the import')
	}
	expect(
		checkPermission(
			access({ inactive: null, layers: [] }, { profileChain: null }),
			'package:execute',
			imported,
		).allowed,
	).toBe(true)
})
