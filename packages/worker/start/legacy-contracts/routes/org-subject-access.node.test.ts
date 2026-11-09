import { jsx } from 'react/jsx-runtime'
import { expect, test } from 'vitest'
import { renderStartPage } from '../../test-support/render-start-page.ts'
import { OrgSubjectAccessPage } from '../../pages/org-subject-access.tsx'
import type {
	OrgSubjectAccessGrant,
	OrgSubjectAccessLoaderData,
} from '#universal/loader-data.ts'

const org: OrgSubjectAccessLoaderData['org'] = {
	id: 'org-zeta',
	slug: 'zeta-co',
	displayName: 'Zeta Co',
	avatarUrl: null,
	personal: false,
	role: 'owner',
}

function grant(
	id: string,
	overrides: Partial<OrgSubjectAccessGrant> = {},
): OrgSubjectAccessGrant {
	return {
		id,
		resourceType: 'package',
		resourceId: `pkg-${id}`,
		resourceLabel: `Package ${id}`,
		subjectType: 'team',
		subjectId: 'team-1',
		subjectLabel: 'Platform (@platform)',
		preset: 'use',
		presetLabel: 'Use',
		permissions: ['package:read', 'package:execute'],
		createdAt: '2026-01-01T00:00:00.000Z',
		via: 'direct',
		canRevoke: true,
		...overrides,
	}
}

function renderAccess(data: OrgSubjectAccessLoaderData) {
	return renderStartPage(
		jsx(OrgSubjectAccessPage, {
			data,
			queryKey: ['page', 'bob', 'loadOrgSubjectAccess', { slug: 'zeta-co' }],
		}),
		'/@zeta-co/-/grants/team/team-1',
	)
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

test('a team access page groups grants by type with compact permissions and bulk revoke', async () => {
	const html = await renderAccess({
		ok: true,
		org,
		canManage: true,
		subject: {
			kind: 'team',
			teamId: 'team-1',
			slug: 'platform',
			name: 'Platform',
			memberCount: 3,
		},
		options: { packages: [], credentials: [] },
		grants: [
			grant('org', {
				resourceType: 'org',
				resourceId: 'org-zeta',
				resourceLabel: 'Organization',
				preset: null,
				presetLabel: null,
				permissions: orgPermissions,
			}),
			...Array.from({ length: 30 }, (_, index) =>
				grant(`p${String(index).padStart(2, '0')}`),
			),
			grant('app', { resourceType: 'app', resourceLabel: 'Inbox app' }),
			grant('cred', { resourceType: 'credential', resourceLabel: 'apiToken' }),
			grant('everyone', {
				subjectType: 'org',
				subjectId: 'org-zeta',
				subjectLabel: 'Everyone in this organization',
				resourceLabel: 'Shared package',
				via: 'everyone',
				canRevoke: false,
			}),
		],
	})
	expect(html).toContain('Access for Platform')
	expect(html).toContain('Team @platform · 3 members')
	const direct = html.slice(
		html.indexOf('data-testid="access-direct"'),
		html.indexOf('data-testid="access-inherited"'),
	)
	// Groups render in type order; one page holds 25 grants.
	expect(direct.indexOf('Organization permissions')).toBeLessThan(
		direct.indexOf('>Packages<'),
	)
	expect(direct).toContain('9 permissions · Create:')
	expect(direct).toContain('data-testid="access-grant-permissions"')
	expect(direct).not.toContain('package:read')
	expect(direct.match(/data-testid="access-grant"/g)).toHaveLength(25)
	expect(direct.match(/data-testid="access-grant-remove"/g)).toHaveLength(25)
	expect(direct).toContain('aria-label="Select this page"')
	expect(direct).toContain('aria-label="Select Package p00"')
	expect(direct).toContain('Filter by resource type')
	expect(html).toContain('From everyone in the organization')
	const inherited = html.slice(html.indexOf('data-testid="access-inherited"'))
	expect(inherited).toContain('Shared package')
	expect(inherited).not.toContain('access-grant-remove')
	expect(inherited).not.toContain('aria-label="Select')
})

test('the whole organization page reads as everyone, and a viewer who cannot manage gets no controls', async () => {
	const html = await renderAccess({
		ok: true,
		org: { ...org, role: 'member' },
		canManage: false,
		subject: { kind: 'org', memberCount: 12 },
		options: null,
		grants: [
			grant('p1', {
				subjectType: 'org',
				subjectId: 'org-zeta',
				canRevoke: false,
			}),
		],
	})
	expect(html).toContain('Access for everyone')
	expect(html).toContain(
		'12 members. Every member of @zeta-co gets these grants',
	)
	expect(html).toContain('Package p1')
	expect(html).not.toContain('access-grant-remove')
	expect(html).not.toContain('access-grant-preset')
	expect(html).not.toContain('Select this page')
	expect(html).not.toContain('Give access')
})
