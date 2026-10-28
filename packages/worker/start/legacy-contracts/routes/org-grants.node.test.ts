import { jsx } from 'react/jsx-runtime'
import { expect, test } from 'vitest'
import { renderStartPage } from '../../test-support/render-start-page.ts'
import { OrgGrantsPage } from '../../pages/org-management.tsx'
import { type OrgGrantsLoaderData } from '#universal/loader-data.ts'

function grant(
	id: string,
	canRevoke: boolean,
): OrgGrantsLoaderData['grants'][number] {
	return {
		id,
		resourceType: 'package',
		resourceId: 'pkg-1',
		resourceLabel: 'Demo Package',
		subjectType: 'user',
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
		orgWideRead: {
			subjects: [
				{ key: 'user:p-1', kind: 'user', label: '@casey', reads: [] },
				{
					key: 'team:t-1',
					kind: 'team',
					label: 'Support (@support)',
					reads: ['job:read'],
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
})

test('the read access form is hidden from viewers who cannot grant', async () => {
	const html = await renderGrants({
		ok: true,
		org,
		canManage: false,
		grants: [],
		orgWideRead: null,
	})
	expect(html).not.toContain('data-testid="org-wide-read-form"')
})
