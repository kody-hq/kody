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

function row(html: string, grantId: string) {
	const marker = `data-grant-id="${grantId}"`
	const start = html.indexOf(marker)
	expect(start).toBeGreaterThan(-1)
	const end = html.indexOf('</li>', start)
	expect(end).toBeGreaterThan(start)
	return html.slice(start, end)
}

test('revoke is offered only for grants the viewer may revoke', async () => {
	const html = await renderGrants({
		ok: true,
		org,
		canManage: true,
		people: [],
		subjects: [],
		orgWideRead: null,
		grants: [grant('grant-ok', true), grant('grant-denied', false)],
	})

	expect(row(html, 'grant-ok')).toMatch(
		/<button(?=[^>]*type="button")(?=[^>]*data-testid="org-grant-revoke")[^>]*>/,
	)
	expect(row(html, 'grant-ok')).toMatch(/Revoke<\/button>/)
	expect(row(html, 'grant-denied')).toContain('@grant-denied')
	expect(row(html, 'grant-denied')).not.toContain(
		'data-testid="org-grant-revoke"',
	)
	expect(html.match(/data-testid="org-grant-revoke"/g)).toHaveLength(1)
})

test('a viewer who cannot manage members sees no revoke buttons', async () => {
	const html = await renderGrants({
		ok: true,
		org,
		canManage: false,
		people: [],
		subjects: [],
		orgWideRead: null,
		grants: [grant('grant-resource-ok', true)],
	})
	expect(html).toContain('data-grant-id="grant-resource-ok"')
	expect(html).toContain('@grant-resource-ok')
	expect(html).not.toContain('data-testid="org-grant-revoke"')
})

test('organization grants read as labels, not raw permission ids', async () => {
	const html = await renderGrants({
		ok: true,
		org,
		canManage: false,
		people: [],
		subjects: [],
		orgWideRead: null,
		grants: [
			{
				...grant('grant-org-read', false),
				resourceType: 'org',
				resourceId: 'org-zeta',
				resourceLabel: 'Organization',
				preset: null,
				presetLabel: null,
				permissions: ['job:read', 'integration:read', 'team:read'],
			},
		],
	})
	const orgRow = row(html, 'grant-org-read')
	expect(orgRow).toContain('Organization-wide access')
	expect(orgRow).toContain('Read: Jobs and run history, Credentials')
	expect(orgRow).not.toContain('org-zeta')
	expect(orgRow).not.toContain('job:read')
})

test('the read access form lists members and teams with read-only options', async () => {
	const html = await renderGrants({
		ok: true,
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
	expect(html.match(/data-testid="org-wide-read-option"/g)).toHaveLength(5)
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
		org: { ...org, role: 'owner' },
		canManage: true,
		people: [],
		orgWideRead: null,
		subjects: [
			{ userId: 'owner-1', label: '@olive', kind: 'member', role: 'owner' },
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
	expect(html.match(/data-testid="org-grant-person-summary"/g)).toHaveLength(3)
	// Direct grants to people are changed on the Access page, not listed here.
	expect(html).not.toContain('data-grant-id="g-1"')
	expect(html).toContain('Search people')
	expect(html).toContain('Filter by person')
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
