import { expect, test } from 'vitest'
import { fileTreePermission, filePublicParentAllows } from './tree-access.ts'
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
