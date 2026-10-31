import { expect, test } from 'vitest'
import { type EffectivePermissions } from '#worker/authorization/authorize.ts'
import { enablerCanSee } from './run-gate.ts'

function access(
	permissions: Array<string>,
	isOwner = false,
): EffectivePermissions {
	return {
		orgId: 'org-1',
		permissions: new Set(permissions),
		isOwner,
		resourcePermissions: new Map(),
		credentialScopes: null,
	} as unknown as EffectivePermissions
}

test('an org permission audience needs that permission', () => {
	const audience = { resource: null, orgPermission: 'member:read' as const }
	expect(enablerCanSee(access(['member:read']), audience)).toBe(true)
	expect(enablerCanSee(access(['package:read']), audience)).toBe(false)
	expect(enablerCanSee(access([], true), audience)).toBe(true)
})

test('no resource reaches owners only', () => {
	expect(enablerCanSee(access(['member:read']), { resource: null })).toBe(false)
	expect(enablerCanSee(access([], true), { resource: null })).toBe(true)
})
