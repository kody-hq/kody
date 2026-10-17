import type * as InviteLinks from '#worker/orgs/invite-links.ts'
import { expect, test, vi } from 'vitest'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
const mocks = vi.hoisted(() => ({
	read: vi.fn(async () => {
		throw new Error('Teams unavailable')
	}),
	create: vi.fn(async () => ({ id: 'link-1', expiresAt: null, maxUses: null })),
	revoke: vi.fn(async () => undefined),
}))
vi.mock('#app/handlers/org-teams.ts', () => ({
	loadOrgTeamsData: mocks.read,
	personalOrgTeamWriteResponse: () => {
		throw new Error('Personal org denied')
	},
}))
vi.mock('#app/org-management-access.ts', () => ({
	resolveOrgManagementAccess: async () => ({
		ok: true,
		org: { id: 'org-a', slug: 'team-a', personal: false },
	}),
	orgHasPermission: async () => true,
}))
vi.mock('#worker/orgs/org-audit.ts', () => ({
	orgAuditWriterFromRequest: () => undefined,
}))
vi.mock('#worker/orgs/invite-links.ts', async (original) => ({
	...(await original<typeof InviteLinks>()),
	createOrgInviteLink: mocks.create,
	revokeOrgInviteLink: mocks.revoke,
}))
const { createTeamInviteLink, revokeTeamInviteLink } =
	await import('./org-teams-invite-links.ts')
const context = {
	env: { APP_DB: {} } as Env,
	request: new Request('https://kody.test/_serverFn/invite'),
	user: {
		mcpUser: { userId: 'person-a' },
		request: {},
	} as AuthenticatedAppUser,
	orgSlug: 'team-a',
}
test('team link creation returns its one-time URL even when the teams read is unavailable', async () => {
	const result = await createTeamInviteLink({ ...context, teamId: 'team-1' })
	expect(result.status).toBe(200)
	expect(result.data).toMatchObject({
		ok: true,
		inviteLink: {
			id: 'link-1',
			teamId: 'team-1',
			url: expect.stringContaining('/join/'),
		},
	})
	expect(result.data).not.toHaveProperty('teams')
	expect(mocks.read).not.toHaveBeenCalled()
	expect(mocks.create).toHaveBeenCalledWith(
		expect.objectContaining({
			orgId: 'org-a',
			target: { kind: 'team', teamId: 'team-1' },
			tokenHash: expect.any(String),
		}),
	)
})
test('team link revocation uses the team scope and does not reload the page', async () => {
	const result = await revokeTeamInviteLink({ ...context, linkId: 'link-1' })
	expect(result.data).toEqual({ ok: true, revokedLinkId: 'link-1' })
	expect(mocks.revoke).toHaveBeenCalledWith(
		expect.objectContaining({
			orgId: 'org-a',
			linkId: 'link-1',
			scope: { kind: 'team' },
		}),
	)
	expect(mocks.read).not.toHaveBeenCalled()
})
