import { expect, test } from 'vitest'
import {
	fileTreeAccess,
	fileTreePermission,
	filePublicParentAllows,
} from './tree-access.ts'
import type { EffectivePermissions } from '#worker/authorization/authorize.ts'
import type { FileMetadata } from '#universal/files.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
function fixture() {
	const orgId = ownerIdFromStored('org_test')
	const root: FileMetadata = {
		id: 'root',
		name: 'Root',
		mediaType: 'application/vnd.kody.directory',
		revisionId: 'rev',
		createdAt: '',
		updatedAt: '',
		revisions: [],
	}
	const child = { ...root, id: 'child', parentId: 'root' },
		leaf = { ...root, id: 'leaf', parentId: 'child' }
	const files = new Map([root, child, leaf].map((f) => [f.id, f]))
	const access: EffectivePermissions = {
		orgId,
		permissions: new Set(['file:read']),
		isOwner: false,
		credentialScopes: null,
		resourcePermissions: new Map([
			['file:root', new Set(['file:read', 'file:write'])],
		]),
	}
	return { files, access }
}
test('directory grants inherit down arbitrary depth while missing parents and cycles fail closed', () => {
	const { files, access } = fixture()
	expect(fileTreePermission(access, files, 'file:write', 'leaf')).toBe(true)
	files.set('root', { ...files.get('root')!, parentId: 'leaf' })
	expect(fileTreePermission(access, files, 'file:write', 'leaf')).toBe(false)
	files.delete('root')
	expect(fileTreePermission(access, files, 'file:read', 'leaf')).toBe(false)
})
test('restricted descendants block root access and direct child sharing cannot bypass them', () => {
	const { files, access } = fixture()
	files.set('child', { ...files.get('child')!, accessMode: 'restricted' })
	access.resourcePermissions = new Map([
		...access.resourcePermissions,
		['file:leaf', new Set(['file:read'])],
	])
	expect(fileTreePermission(access, files, 'file:read', 'leaf')).toBe(false)
	access.resourcePermissions = new Map([
		...access.resourcePermissions,
		['file:child', new Set(['file:read'])],
	])
	expect(fileTreePermission(access, files, 'file:read', 'leaf')).toBe(true)
})
test('inherited grants still respect narrowed credential scopes', () => {
	const { files, access } = fixture()
	access.credentialScopes = new Set(['file:read'])
	expect(fileTreePermission(access, files, 'file:write', 'leaf')).toBe(false)
	expect(fileTreePermission(access, files, 'file:read', 'leaf')).toBe(true)
})

test('a restricted ancestor caps every permission, even with broader org or child grants', () => {
	const { files, access } = fixture()
	files.set('child', { ...files.get('child')!, accessMode: 'restricted' })
	access.permissions = new Set([...access.permissions, 'file:write'])
	access.resourcePermissions = new Map([
		...access.resourcePermissions,
		['file:child', new Set(['file:read'])],
		['file:leaf', new Set(['file:read', 'file:write'])],
	])
	expect(fileTreePermission(access, files, 'file:read', 'leaf')).toBe(true)
	expect(fileTreePermission(access, files, 'file:write', 'leaf')).toBe(false)
	access.resourcePermissions = new Map([
		...access.resourcePermissions,
		['file:child', new Set(['file:read', 'file:write'])],
	])
	expect(fileTreePermission(access, files, 'file:write', 'leaf')).toBe(true)
})

test('public links stop working beneath a newly restricted ancestor', () => {
	const { files } = fixture()
	expect(filePublicParentAllows(files, 'leaf')).toBe(true)
	files.set('child', { ...files.get('child')!, accessMode: 'restricted' })
	expect(filePublicParentAllows(files, 'leaf')).toBe(false)
	expect(filePublicParentAllows(files, 'child')).toBe(true)
	files.delete('root')
	expect(filePublicParentAllows(files, 'child')).toBe(false)
})

const denialMessage = (decision: ReturnType<typeof fileTreeAccess>) =>
	'error' in decision ? decision.error.message : null

test('a missing file or ancestor is reported as missing, not as a denial', () => {
	const { files, access } = fixture()
	expect(fileTreeAccess(access, files, 'file:read', 'nope')).toEqual({
		allowed: false,
		missing: 'file',
	})
	files.delete('root')
	expect(fileTreeAccess(access, files, 'file:read', 'leaf')).toEqual({
		allowed: false,
		missing: 'parent',
	})
	files.set('root', { ...files.get('child')!, id: 'root', parentId: 'leaf' })
	expect(fileTreeAccess(access, files, 'file:read', 'leaf')).toEqual({
		allowed: false,
		missing: 'parent',
	})
})

test('denials carry the authorizer error for missing permissions, token scopes, and profile grants', () => {
	const { files, access } = fixture()
	access.resourcePermissions = new Map()
	expect(
		denialMessage(fileTreeAccess(access, files, 'file:write', 'leaf')),
	).toBe('Missing file:write on file "leaf". An org Owner can grant it.')

	const scoped = fixture()
	scoped.access.credentialScopes = new Set(['file:read'])
	const scopeDenial = fileTreeAccess(
		scoped.access,
		scoped.files,
		'file:write',
		'leaf',
	)
	expect('error' in scopeDenial && scopeDenial.error.code).toBe(
		'credential_scope',
	)
	expect(denialMessage(scopeDenial)).toMatch(
		/^This credential is not scoped for file:write on file "root"\. Mint a token that adds it: /,
	)

	const profiled = fixture()
	profiled.access.profileChain = {
		inactive: null,
		layers: [
			{
				id: 'profile',
				name: 'file-reviewer',
				self: true,
				orgPermissions: new Set(),
				resourcePermissions: new Map([['file:root', new Set(['file:read'])]]),
			},
		],
	}
	expect(
		fileTreeAccess(profiled.access, profiled.files, 'file:read', 'leaf'),
	).toEqual({ allowed: true })
	expect(
		denialMessage(
			fileTreeAccess(profiled.access, profiled.files, 'file:write', 'leaf'),
		),
	).toBe(
		'Profile "file-reviewer" was not granted file:write on file "root". The person it acts for can grant it (accessGrant with subject_type "profile").',
	)
})

test('a restricted ancestor denies with the authorizer error naming that ancestor', () => {
	const { files, access } = fixture()
	files.set('child', { ...files.get('child')!, accessMode: 'restricted' })
	expect(
		denialMessage(fileTreeAccess(access, files, 'file:read', 'leaf')),
	).toBe('Missing file:read on file "child". An org Owner can grant it.')
	access.resourcePermissions = new Map([
		...access.resourcePermissions,
		['file:child', new Set(['file:read'])],
	])
	expect(
		denialMessage(fileTreeAccess(access, files, 'file:write', 'leaf')),
	).toBe('Missing file:write on file "child". An org Owner can grant it.')
})
