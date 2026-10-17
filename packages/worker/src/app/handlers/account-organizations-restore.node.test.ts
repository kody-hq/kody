import { expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	lookup: vi.fn(),
	restore: vi.fn(),
	create: vi.fn(),
}))
vi.mock('#worker/orgs/soft-delete.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	loadRestorableOrganizationBySlugForPerson: state.lookup,
	restoreOrg: state.restore,
}))
vi.mock('#worker/orgs/create-organization.ts', () => ({
	createOrganization: state.create,
}))
vi.mock('#worker/authorization/authorize.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	authorize: vi.fn(),
}))
vi.mock('#worker/orgs/org-audit.ts', () => ({
	orgAuditWriterFromRequest: () => ({}),
}))
import {
	restoreWebsiteOrganization,
	createWebsiteOrganization,
} from './account-organizations.ts'
const env = { APP_DB: {} } as Env
const user = {
	username: 'owner',
	mcpUser: { userId: 'actor-owner' },
	request: {},
} as unknown as Parameters<typeof restoreWebsiteOrganization>[0]['user']
test('website restore resolves a reserved handle against the signed-in Owner before restoring that org', async () => {
	state.lookup.mockResolvedValueOnce(null)
	await expect(
		restoreWebsiteOrganization({ env, user, orgSlug: 'private-team' }),
	).rejects.toThrow('not available to restore')
	expect(state.restore).not.toHaveBeenCalled()
	state.lookup.mockResolvedValueOnce({
		orgId: 'deleted-team',
		slug: 'reserved-team',
	})
	expect(
		await restoreWebsiteOrganization({ env, user, orgSlug: 'Reserved-Team' }),
	).toEqual({ slug: 'reserved-team' })
	expect(state.lookup).toHaveBeenLastCalledWith({
		db: env.APP_DB,
		actorUserId: 'actor-owner',
		slug: 'reserved-team',
	})
	expect(state.restore).toHaveBeenLastCalledWith({
		env,
		orgId: 'deleted-team',
		actorUserId: 'actor-owner',
		actorUsername: 'owner',
	})
})
test('restore races fail safely and creation offers restore only for an authorized reserved handle', async () => {
	state.lookup.mockResolvedValueOnce({
		orgId: 'deleted-team',
		slug: 'reserved-team',
	})
	state.restore.mockRejectedValueOnce(new Error('org_restore_race'))
	await expect(
		restoreWebsiteOrganization({ env, user, orgSlug: 'reserved-team' }),
	).rejects.toThrow('already restored')
	state.create.mockResolvedValueOnce({
		ok: false,
		error: 'Restore this organization instead.',
		restorableSlug: 'reserved-team',
	})
	expect(
		await createWebsiteOrganization({
			env,
			user,
			slug: 'reserved-team',
			displayName: 'Team',
		}),
	).toEqual({
		ok: false,
		error: 'Restore this organization instead.',
		restorableSlug: 'reserved-team',
	})
	state.create.mockResolvedValueOnce({
		ok: false,
		error: 'That name is taken.',
	})
	await expect(
		createWebsiteOrganization({
			env,
			user,
			slug: 'other-team',
			displayName: 'Team',
		}),
	).rejects.toThrow('That name is taken.')
})
