import { createElement } from 'react'
import { expect, test } from 'vitest'
import { PackageCollaboratorsRoute } from './pages/package-collaborators.tsx'
import { PackageCollaboratorInvites } from './pages/package-collaborators-invites.tsx'
import { renderStartPage } from './test-support/render-start-page.ts'
import { type PackageCollaboratorsLoaderData } from '#universal/package-collaborators.ts'

test('outside collaborators stay removable but cannot be edited or invited from the tab', async () => {
	const payload: Extract<PackageCollaboratorsLoaderData, { ok: true }> = {
		ok: true,
		shell: {
			username: 'acme',
			kodyId: 'demo',
			name: 'Demo',
			description: '',
			isPrivate: true,
			isListed: false,
			listingId: null,
			defaultBranch: null,
			publishedCommit: null,
			ownerProfilePublic: true,
			viewerCanManage: true,
		},
		view: {
			ok: true,
			package: { id: 'pkg', kodyId: 'demo', name: 'Demo' },
			org: { slug: 'acme', personal: false },
			options: { teams: [], members: [] },
			invites: [],
			collaborators: [
				{
					grantId: 'grant-outside',
					subjectType: 'user',
					subjectId: 'person-outside',
					kind: 'outside',
					label: '@guest',
					username: 'guest',
					displayName: null,
					avatarUrl: null,
					teamSlug: null,
					teamMemberCount: null,
					preset: 'use',
					permissions: ['package:read'],
					createdAt: '2026-10-14',
				},
			],
		},
	}
	const html = await renderStartPage(
		createElement(PackageCollaboratorsRoute, { payload, actorKey: 'owner' }),
		'/@acme/demo/collaborators',
	)
	expect(html).toContain('Outside collaborator')
	expect(html).toContain('Remove')
	expect(html).not.toContain('aria-label="Access for @guest"')
	expect(html).not.toContain('package-collaborators-invite')
	expect(html).not.toContain('Pending invites')
})

test('personal package invites show access choices and pending recipients without exposing handoff tokens', async () => {
	const html = await renderStartPage(
		createElement(PackageCollaboratorInvites, {
			view: {
				ok: true,
				package: { id: 'pkg', kodyId: 'demo', name: 'Demo' },
				org: { slug: 'owner', personal: true },
				collaborators: [],
				options: { teams: [], members: [] },
				invites: [
					{
						id: 'invite-one',
						inviteeEmail: 'friend@example.com',
						inviteeUsername: null,
						preset: 'contribute',
						expiresAt: '2026-10-31T00:00:00.000Z',
						createdAt: '2026-10-15T00:00:00.000Z',
					},
				],
			},
			busyKey: null,
			postChange: async () => null,
		}),
	)
	expect(html).toContain('Email or username')
	expect(html).toContain('They cannot change it.')
	expect(html).toContain('friend@example.com')
	expect(html).toContain('Contribute')
	expect(html).toContain('Revoke')
	expect(html).toContain('href="/account/organizations/new"')
	expect(html).not.toContain('package-collaborators-invite-ready')
	expect(html).not.toContain('package-collaborators-prompt')
})
