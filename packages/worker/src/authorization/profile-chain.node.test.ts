import {
	orgPermissions,
	type OrgPermission,
} from '@kody-internal/shared/org-permissions.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
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
	chain: ProfileChainAccess | null,
	overrides: Partial<EffectivePermissions> = {},
): EffectivePermissions {
	return {
		orgId,
		permissions: new Set(orgPermissions),
		isOwner: true,
		resourcePermissions: new Map(),
		credentialScopes: null,
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

const lockedCredentials = new Map([
	[
		'package:pkg-1',
		[
			{
				needKey: 'rooms-db',
				credentialName: 'Prod DB',
				reason: 'publisher' as const,
			},
		],
	],
])

test('a profile acting for an Owner changes a package with unmappable credentials only when its chain allows it', () => {
	const permitted = access({
		inactive: null,
		layers: [layer('helper', true, both(['package:read', 'package:write']))],
	})
	expect(checkPermission(permitted, 'package:write', pkg).allowed).toBe(true)
	const capped = access({
		inactive: null,
		layers: [layer('helper', true, both(['package:read', 'package:execute']))],
	})
	const denied = checkPermission(capped, 'package:write', pkg)
	expect(denied).toMatchObject({
		allowed: false,
		error: { code: 'profile_grant' },
	})
	expect(checkPermission(capped, 'package:execute', pkg).allowed).toBe(true)
})

test("a collaborator's profile inherits the unmappable-credential lock even when its chain holds write", () => {
	const effective = access(
		{
			inactive: null,
			layers: [layer('helper', true, both(['package:read', 'package:write']))],
		},
		{
			isOwner: false,
			permissions: new Set(['org:read']),
			resourcePermissions: new Map([
				['package:pkg-1', new Set(['package:read', 'package:write'])],
			]),
			unmappableCredentialLocks: lockedCredentials,
		},
	)
	const denied = checkPermission(effective, 'package:write', pkg)
	expect(denied).toMatchObject({
		allowed: false,
		error: { code: 'unmappable_credentials' },
	})
})

const notesKey: OrgResource = {
	type: 'credential',
	id: 'cred-1',
	orgId,
	label: 'notes-api-key',
}
const unnamedKey: OrgResource = { type: 'credential', id: 'cred-2', orgId }

function credentialAccess(input: {
	personHolds: boolean
	tokenScopes: Array<OrgPermission> | null
	profile: 'none' | 'granted' | 'not-granted' | 'parent-missing' | 'inactive'
}): EffectivePermissions {
	const granted = {
		'credential:cred-1': ['secret:use'] as Array<OrgPermission>,
	}
	const chain: ProfileChainAccess | null =
		input.profile === 'none'
			? null
			: input.profile === 'inactive'
				? {
						inactive: {
							id: 'prf_helper',
							name: 'helper',
							self: true,
							reason: 'revoked',
						},
						layers: [layer('helper', true, granted)],
					}
				: {
						inactive: null,
						layers: [
							layer(
								'helper',
								true,
								input.profile === 'not-granted' ? {} : granted,
							),
							layer(
								'agent',
								false,
								input.profile === 'parent-missing' ? {} : granted,
							),
						],
					}
	return access(chain, {
		isOwner: false,
		permissions: new Set(input.personHolds ? (['secret:use'] as const) : []),
		credentialScopes: input.tokenScopes ? new Set(input.tokenScopes) : null,
		profileChain: chain,
	})
}

// Every combination of person access, token scope, and profile chain: which
// cases are allowed and which denial each reports.
test.each([
	{ personHolds: true, tokenScopes: null, profile: 'none', expected: null },
	{
		personHolds: true,
		tokenScopes: ['secret:use'],
		profile: 'none',
		expected: null,
	},
	{
		personHolds: true,
		tokenScopes: ['secret:use'],
		profile: 'granted',
		expected: null,
	},
	{ personHolds: true, tokenScopes: null, profile: 'granted', expected: null },
	{
		personHolds: true,
		tokenScopes: ['package:read'],
		profile: 'none',
		expected: 'credential_scope',
	},
	{
		personHolds: true,
		tokenScopes: ['package:read'],
		profile: 'granted',
		expected: 'credential_scope',
	},
	{
		personHolds: true,
		tokenScopes: ['secret:use'],
		profile: 'not-granted',
		expected: 'profile_grant',
	},
	{
		personHolds: true,
		tokenScopes: ['secret:use'],
		profile: 'parent-missing',
		expected: 'profile_grant',
	},
	{
		personHolds: true,
		tokenScopes: ['package:read'],
		profile: 'not-granted',
		expected: 'profile_grant',
	},
	{
		personHolds: true,
		tokenScopes: ['secret:use'],
		profile: 'inactive',
		expected: 'profile_inactive',
	},
	{
		personHolds: false,
		tokenScopes: ['secret:use'],
		profile: 'granted',
		expected: 'missing_permission',
	},
	{
		personHolds: false,
		tokenScopes: ['secret:use'],
		profile: 'not-granted',
		expected: 'missing_permission',
	},
	{
		personHolds: false,
		tokenScopes: null,
		profile: 'none',
		expected: 'missing_permission',
	},
] as const)(
	'credential use: person $personHolds, token $tokenScopes, profile $profile -> $expected',
	({ expected, ...input }) => {
		const decision = checkPermission(
			credentialAccess({
				...input,
				tokenScopes: input.tokenScopes ? [...input.tokenScopes] : null,
			}),
			'secret:use',
			notesKey,
		)
		if (expected === null) {
			expect(decision.allowed).toBe(true)
			return
		}
		expect(decision.allowed).toBe(false)
		if (!decision.allowed) {
			expect(decision.error.code).toBe(expected)
			expect(decision.error.message).not.toContain('cred-1')
		}
	},
)

test('a profile credential denial names the profile and the credential by name', () => {
	const denied = checkPermission(
		credentialAccess({
			personHolds: true,
			tokenScopes: ['secret:use'],
			profile: 'not-granted',
		}),
		'secret:use',
		notesKey,
	)
	expect(denied.allowed).toBe(false)
	if (denied.allowed) return
	expect(denied.error.message).toBe(
		'Profile "helper" was not granted secret:use on credential "notes-api-key". The person it acts for can share the credential with it under Credentials (or accessGrant with resource_type "credential" and subject_type "profile").',
	)
	expect(denied.error.mintScopes).toBeNull()

	const parent = checkPermission(
		credentialAccess({
			personHolds: true,
			tokenScopes: ['secret:use'],
			profile: 'parent-missing',
		}),
		'secret:use',
		notesKey,
	)
	if (!parent.allowed) {
		expect(parent.error.message).toContain(
			'Parent profile "agent" does not hold secret:use on credential "notes-api-key"',
		)
	}
})

test('a profile credential denial never prints a raw credential id', () => {
	const effective = credentialAccess({
		personHolds: true,
		tokenScopes: ['secret:use'],
		profile: 'not-granted',
	})
	const denied = checkPermission(effective, 'secret:use', unnamedKey)
	expect(denied.allowed).toBe(false)
	if (!denied.allowed) {
		expect(denied.error.code).toBe('profile_grant')
		expect(denied.error.message).toContain('on this credential')
		expect(denied.error.message).not.toContain('cred-2')
	}
})

test('a profile denial on a token that also lacks the scope says both', () => {
	const denied = checkPermission(
		credentialAccess({
			personHolds: true,
			tokenScopes: ['package:read'],
			profile: 'not-granted',
		}),
		'secret:use',
		notesKey,
	)
	if (!denied.allowed) {
		expect(denied.error.code).toBe('profile_grant')
		expect(denied.error.message).toContain(
			'This token is also not scoped for secret:use',
		)
	}
})
