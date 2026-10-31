import { expect, test } from 'vitest'
import {
	type ProfileItem,
	buildProfileTree,
	canEditProfile,
	canRevokeProfile,
	descendantCount,
	expiryChangeProblem,
	findTreeNode,
	subProfileBlock,
	subProfileGrantOptions,
	visibleTreeIds,
} from './profiles.ts'

function profile(
	id: string,
	parent: string | null,
	depth: number,
	overrides: Partial<ProfileItem> = {},
): ProfileItem {
	return {
		id,
		name: id,
		parentProfileId: parent,
		actingUserId: 'u_jane',
		actingHandle: 'jane',
		depth,
		status: 'active',
		expiresAt: null,
		effectiveExpiresAt: null,
		revokedAt: null,
		createdAt: '2026-10-31T00:00:00.000Z',
		chain: [{ id, name: id }],
		grants: [],
		...overrides,
	}
}

const jane = { userId: 'u_jane', username: 'jane', isOwner: false }

test('nests sub-profiles under their parents down to depth 5', () => {
	const flat = [
		profile('l5', 'l4', 5),
		profile('l1', null, 1),
		profile('l3', 'l2', 3),
		profile('l2', 'l1', 2),
		profile('l4', 'l3', 4),
		profile('other-root', null, 1),
	]
	const tree = buildProfileTree(flat)
	expect(tree.map((node) => node.profile.id)).toEqual(['l1', 'other-root'])
	const deepest = findTreeNode(tree, 'l5')
	expect(deepest?.level).toBe(5)
	expect(descendantCount(tree[0]!)).toBe(4)
	expect(visibleTreeIds(tree, new Set())).toEqual([
		'l1',
		'l2',
		'l3',
		'l4',
		'l5',
		'other-root',
	])
	expect(visibleTreeIds(tree, new Set(['l2']))).toEqual([
		'l1',
		'l2',
		'other-root',
	])
	expect(subProfileBlock(deepest!.profile, jane)).toBe('depth')
	expect(subProfileBlock(findTreeNode(tree, 'l4')!.profile, jane)).toBeNull()
})

test('keeps parent_inactive descendants under a revoked parent, active first', () => {
	const tree = buildProfileTree([
		profile('root', null, 1, { status: 'revoked' }),
		profile('child-b', 'root', 2, { status: 'parent_inactive' }),
		profile('child-a', 'root', 2, { status: 'parent_inactive' }),
		profile('alive', null, 1),
	])
	expect(tree.map((node) => node.profile.id)).toEqual(['alive', 'root'])
	const root = findTreeNode(tree, 'root')!
	expect(root.children.map((node) => node.profile.status)).toEqual([
		'parent_inactive',
		'parent_inactive',
	])
	expect(root.children.map((node) => node.profile.id)).toEqual([
		'child-a',
		'child-b',
	])
	expect(subProfileBlock(root.children[0]!.profile, jane)).toBe('inactive')
	expect(canRevokeProfile(root.profile, jane)).toBe(false)
	expect(canRevokeProfile(root.children[0]!.profile, jane)).toBe(true)
})

test('a profile whose parent is not listed becomes a detached root', () => {
	const tree = buildProfileTree([profile('orphan', 'gone', 2)])
	expect(tree).toHaveLength(1)
	expect(tree[0]).toMatchObject({ level: 1, detached: true })
})

test('Owners revoke but never edit or nest under another member', () => {
	const owner = { userId: 'u_owner', username: 'owner', isOwner: true }
	const theirs = profile('theirs', null, 1)
	expect(canRevokeProfile(theirs, owner)).toBe(true)
	expect(canEditProfile(theirs, owner)).toBe(false)
	expect(subProfileBlock(theirs, owner)).toBe('not_yours')
	expect(canEditProfile(theirs, jane)).toBe(true)
})

test('expiry only moves earlier and never past the parents', () => {
	const now = new Date('2026-10-31T00:00:00.000Z')
	expect(
		expiryChangeProblem({
			current: '2026-11-10T00:00:00.000Z',
			next: '2026-11-20T00:00:00.000Z',
			now,
		}),
	).toMatch(/only move earlier/)
	expect(
		expiryChangeProblem({
			current: null,
			parentLimit: '2026-11-05T00:00:00.000Z',
			next: '2026-11-06T00:00:00.000Z',
			now,
		}),
	).toMatch(/outlive its parents/)
	expect(
		expiryChangeProblem({
			current: '2026-11-10T00:00:00.000Z',
			next: '2026-11-02T00:00:00.000Z',
			now,
		}),
	).toBeNull()
	expect(
		expiryChangeProblem({
			current: null,
			next: '2026-10-30T00:00:00.000Z',
			now,
		}),
	).toMatch(/future/)
})

test('sub-profile grant options only offer what the whole chain still holds', () => {
	const pkg = (permissions: Array<string>) => ({
		resourceType: 'package',
		resourceId: 'pkg_1',
		label: 'pkg-one',
		permissions,
	})
	const root = profile('root', null, 1, {
		grants: [pkg(['package:read'])] as ProfileItem['grants'],
	})
	const child = profile('child', 'root', 2, {
		chain: [
			{ id: 'root', name: 'root' },
			{ id: 'child', name: 'child' },
		],
		grants: [pkg(['package:read', 'package:write'])] as ProfileItem['grants'],
	})
	expect(subProfileGrantOptions(child, [root, child])).toEqual([
		{
			resourceType: 'package',
			resourceId: 'pkg_1',
			label: 'pkg-one',
			permissions: ['package:read'],
		},
	])
	expect(subProfileGrantOptions(child, [child])).toEqual([])
})
