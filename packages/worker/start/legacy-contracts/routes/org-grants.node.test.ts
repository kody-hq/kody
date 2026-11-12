import { jsx } from 'react/jsx-runtime'
import { expect, test } from 'vitest'
import { renderStartPage } from '../../test-support/render-start-page.ts'
import { OrgGrantsPage } from '../../pages/org-management.tsx'
import type { OrgGrantsLoaderData } from '#universal/loader-data.ts'

function grant(
	id: string,
	canRevoke: boolean,
	subjectType: 'user' | 'team' = 'team',
): OrgGrantsLoaderData['grants'][number] {
	return {
		id,
		resourceType: 'package',
		resourceId: 'pkg-1',
		resourceLabel: 'Demo Package',
		subjectType,
		subjectId: id,
		subjectLabel: `@${id}`,
		preset: 'use',
		presetLabel: 'Use',
		permissions: [],
		createdAt: '2026-01-01T00:00:00.000Z',
		canRevoke,
	}
}

function renderGrants(data: OrgGrantsLoaderData) {
	return renderStartPage(
		jsx(OrgGrantsPage, {
			data,
			queryKey: ['page', 'bob', 'loadOrgGrants', { slug: 'zeta-co' }],
		}),
		'/@zeta-co/-/grants',
	)
}

const org: OrgGrantsLoaderData['org'] = {
	id: 'org-zeta',
	slug: 'zeta-co',
	displayName: 'Zeta Co',
	avatarUrl: null,
	personal: false,
	role: 'member',
}

function teamGrant(
	id: string,
	overrides: Partial<OrgGrantsLoaderData['grants'][number]> = {},
): OrgGrantsLoaderData['grants'][number] {
	return {
		...grant(id, true),
		subjectId: 'team-1',
		subjectLabel: 'Platform (@platform)',
		resourceId: `pkg-${id}`,
		...overrides,
	}
}

const orgPermissions = [
	'package:read',
	'app:read',
	'job:read',
	'integration:read',
	'email:read',
	'team:read',
	'member:read',
	'package:create',
	'integration:create',
]

test('teams and the whole organization get one row each with a compact summary and an Access link', async () => {
	const html = await renderGrants({
		ok: true,
		org: { ...org, role: 'owner' },
		canManage: true,
		people: [],
		subjects: [],
		orgWideRead: null,
		memberCount: 12,
		teams: [
			{ teamId: 'team-1', slug: 'platform', name: 'Platform', memberCount: 3 },
			{ teamId: 'team-2', slug: 'design', name: 'Design', memberCount: 1 },
		],
		grants: [
			teamGrant('org', {
				resourceType: 'org',
				resourceId: 'org-zeta',
				resourceLabel: 'Organization',
				preset: null,
				presetLabel: null,
				permissions: orgPermissions,
			}),
			...Array.from({ length: 14 }, (_, index) => teamGrant(`p${index}`)),
			teamGrant('a1', { resourceType: 'app' }),
			teamGrant('a2', { resourceType: 'app', resourceId: 'pkg-p2' }),
			{
				...grant('everyone-1', true),
				subjectType: 'org',
				subjectId: 'org-zeta',
				subjectLabel: 'Everyone in this organization',
			},
		],
	})
	expect(html).toContain('Org: 9 permissions, 14 packages, 2 apps')
	expect(html).toContain('href="/@zeta-co/-/grants/team/team-1"')
	expect(html).toContain('href="/@zeta-co/-/grants/team/team-2"')
	expect(html).toContain('href="/@zeta-co/-/grants/everyone"')
	expect(html).toContain('Team · 3 members')
	expect(html).toContain('Team · 1 member')
	expect(html).toContain('Everyone · 12 members')
	expect(html).toContain('No grants')
	expect(html).toContain('1 package')
	expect(html.match(/data-testid="org-grant-person-summary"/g)).toHaveLength(3)
	// Grants are listed and revoked on each Access page, not one card each here.
	expect(html).not.toContain('data-grant-id=')
	expect(html).not.toContain('org-grant-revoke')
	expect(html).not.toContain('package:read')
})

test('a viewer who cannot manage sees only teams that hold grants and no empty organization row', async () => {
	const html = await renderGrants({
		ok: true,
		org,
		canManage: false,
		people: [],
		subjects: [],
		orgWideRead: null,
		memberCount: 4,
		teams: [],
		grants: [teamGrant('p1')],
	})
	expect(html).toContain('Platform (@platform)')
	expect(html).toContain('1 package')
	expect(html).not.toContain('Everyone in this organization')
	expect(html).not.toContain('org-grant-revoke')
})

test('the read access form lists members and teams with read-only options', async () => {
	const html = await renderGrants({
		ok: true,
		teams: [],
		memberCount: 0,
		org: { ...org, role: 'owner' },
		canManage: true,
		grants: [],
		people: [],
		subjects: [],
		orgWideRead: {
			subjects: [
				{
					key: 'user:p-1',
					kind: 'user',
					label: '@casey',
					reads: [],
					creates: [],
					manages: [],
				},
				{
					key: 'team:t-1',
					kind: 'team',
					label: 'Support (@support)',
					reads: ['job:read'],
					creates: [],
					manages: [],
				},
			],
		},
	})
	expect(html).toContain('data-testid="org-wide-read-form"')
	expect(html).toContain('Organization-wide read access')
	expect(html).toContain('@casey')
	expect(html).toContain('Support (@support)')
	expect(html.match(/data-testid="org-wide-read-option"/g)).toHaveLength(6)
	expect(html).toContain('data-permission="job:read"')
	expect(html).not.toMatch(/data-permission="[a-z_]+:(write|execute|use)"/)
	expect(html).toContain('data-testid="org-create-access-form"')
	expect(html.match(/data-testid="org-create-access-option"/g)).toHaveLength(3)
	for (const permission of [
		'package:create',
		'secret:create',
		'integration:create',
	]) {
		expect(html).toContain(`data-permission="${permission}"`)
	}
})

test('the read access form is hidden from viewers who cannot grant', async () => {
	const html = await renderGrants({
		ok: true,
		teams: [],
		memberCount: 0,
		org,
		canManage: false,
		grants: [],
		people: [],
		subjects: [],
		orgWideRead: null,
	})
	expect(html).not.toContain('data-testid="org-wide-read-form"')
	expect(html).not.toContain('data-testid="org-create-access-form"')
})

test('people are grouped into one row each with a summary and an Access link', async () => {
	const html = await renderGrants({
		ok: true,
		teams: [],
		memberCount: 0,
		org: { ...org, role: 'owner' },
		canManage: true,
		people: [],
		orgWideRead: null,
		subjects: [
			{ userId: 'owner-1', label: '@olive', kind: 'member', role: 'owner' },
			{ userId: 'admin-1', label: '@ada', kind: 'member', role: 'admin' },
			{ userId: 'work-1', label: '@work', kind: 'member', role: 'member' },
			{ userId: 'idle-1', label: '@idle', kind: 'member', role: 'member' },
		],
		grants: [
			{ ...grant('work-1', true, 'user'), id: 'g-1', resourceId: 'pkg-1' },
			{ ...grant('work-1', true, 'user'), id: 'g-2', resourceId: 'pkg-2' },
			{ ...grant('work-1', true, 'user'), id: 'g-3', resourceId: 'pkg-3' },
			{
				...grant('work-1', true, 'user'),
				id: 'g-4',
				resourceType: 'credential',
				resourceId: 'cred-1',
			},
			{
				...grant('work-1', true, 'user'),
				id: 'g-5',
				resourceType: 'credential',
				resourceId: 'cred-2',
			},
		],
	})
	expect(html).toContain('3 packages, 2 credentials')
	expect(html).toContain('href="/@zeta-co/-/grants/user/work-1"')
	expect(html).toContain('No direct grants')
	expect(html).toContain('Full access')
	expect(html).not.toContain('href="/@zeta-co/-/grants/user/owner-1"')
	expect(html).toContain(
		'Full access except deleting the organization or changing Owners',
	)
	expect(html).toContain('>Admin<')
	// Four people plus the whole-organization row a manager can open.
	expect(html.match(/data-testid="org-grant-person-summary"/g)).toHaveLength(5)
	expect(html).toContain('href="/@zeta-co/-/grants/everyone"')
	// Direct grants to people are changed on the Access page, not listed here.
	expect(html).not.toContain('data-grant-id="g-1"')
	expect(html).toContain('Search people and teams')
	expect(html).toContain('Filter by who')
	expect(html).toContain('Filter by resource type')
})

test('a large organization is paged instead of rendering every person', async () => {
	const subjects = Array.from({ length: 60 }, (_, index) => ({
		userId: `user-${index}`,
		label: `@person-${String(index).padStart(2, '0')}`,
		kind: 'member' as const,
		role: 'member' as const,
	}))
	const html = await renderGrants({
		ok: true,
		teams: [],
		memberCount: 0,
		org,
		canManage: true,
		people: [],
		orgWideRead: null,
		subjects,
		grants: [],
	})
	expect(html.match(/data-testid="org-grant-person-summary"/g)).toHaveLength(25)
	expect(html).toContain('@person-00')
	expect(html).not.toContain('@person-59')
})
