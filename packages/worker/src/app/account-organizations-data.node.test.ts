import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { runWithRequestContext } from '#worker/request-context.ts'
import { loadAccountOrganizationSnapshot } from './account-organizations-data.ts'

const mocks = vi.hoisted(() => ({
	listOrganizationsForPerson: vi.fn(),
	listPendingInvitesForPerson: vi.fn(),
	listPendingInviteLinksForPerson: vi.fn(),
	listRestorableOrganizationsForPerson: vi.fn(),
}))

vi.mock('#worker/orgs/repo.ts', () => ({
	listOrganizationsForPerson: (...args: Array<unknown>) =>
		mocks.listOrganizationsForPerson(...args),
	listPendingInvitesForPerson: (...args: Array<unknown>) =>
		mocks.listPendingInvitesForPerson(...args),
}))

vi.mock('#worker/orgs/invite-link-pending.ts', () => ({
	listPendingInviteLinksForPerson: (...args: Array<unknown>) =>
		mocks.listPendingInviteLinksForPerson(...args),
}))

vi.mock('#worker/orgs/soft-delete.ts', () => ({
	listRestorableOrganizationsForPerson: (...args: Array<unknown>) =>
		mocks.listRestorableOrganizationsForPerson(...args),
}))

test('the shell and the Organizations page share one organization and invite read', async () => {
	mocks.listOrganizationsForPerson.mockResolvedValue([
		{
			slug: 'kent',
			displayName: 'Kent',
			role: 'owner',
			personal: true,
			avatarKey: null,
		},
	])
	mocks.listPendingInvitesForPerson.mockResolvedValue([])
	mocks.listPendingInviteLinksForPerson.mockResolvedValue([])
	mocks.listRestorableOrganizationsForPerson.mockResolvedValue([
		{
			slug: 'acme',
			displayName: 'Acme',
			deletedAt: '2026-11-01T00:00:00.000Z',
		},
	])
	const env = { APP_DB: {} } as unknown as Env
	const user = {
		email: 'kent@example.com',
		emailVerified: true,
		username: 'kent',
		mcpUser: { userId: ownerIdFromStored('owner-1') },
	} as unknown as Parameters<typeof loadAccountOrganizationSnapshot>[1]

	const [shell, page] = await runWithRequestContext(
		new Request('https://kody.test/account/organizations'),
		() =>
			Promise.all([
				loadAccountOrganizationSnapshot(env, user),
				loadAccountOrganizationSnapshot(env, user, {
					includeRestorable: true,
				}),
			]),
	)

	expect(mocks.listOrganizationsForPerson).toHaveBeenCalledTimes(1)
	expect(mocks.listPendingInvitesForPerson).toHaveBeenCalledTimes(1)
	expect(mocks.listPendingInviteLinksForPerson).toHaveBeenCalledTimes(1)
	expect(mocks.listRestorableOrganizationsForPerson).toHaveBeenCalledTimes(1)
	expect(shell.restorableOrganizations).toEqual([])
	expect(page.restorableOrganizations.map((org) => org.slug)).toEqual(['acme'])
	expect(page.organizations).toEqual(shell.organizations)
})
