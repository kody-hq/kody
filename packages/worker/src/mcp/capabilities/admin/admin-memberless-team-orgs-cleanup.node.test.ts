import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { adminMemberlessTeamOrgsCleanupCapability } from './admin-memberless-team-orgs-cleanup.ts'

const mocks = vi.hoisted(() => ({
	cleanupMemberlessTeamOrgs: vi.fn(),
}))

vi.mock('#worker/orgs/memberless-team-orgs.ts', () => ({
	cleanupMemberlessTeamOrgs: mocks.cleanupMemberlessTeamOrgs,
	memberlessTeamOrgCleanupDefaultLimit: 25,
	memberlessTeamOrgCleanupMaxLimit: 100,
}))

function createContext(roles: Array<string>) {
	const db = {
		prepare: () => ({
			bind: () => ({
				first: async () => ({
					id: 1,
					email: 'actor@example.com',
					username: 'actor',
				}),
			}),
		}),
	}
	return {
		env: { APP_DB: db as unknown as D1Database } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored('actor-1'),
				username: 'actor',
				email: 'actor@example.com',
				displayName: 'Actor',
				roles,
			},
		}),
	}
}

test('memberless team org cleanup needs the admin role, lists by default, and purges only when asked', async () => {
	await expect(
		adminMemberlessTeamOrgsCleanupCapability.handler(
			{ dryRun: false },
			createContext(['user']),
		),
	).rejects.toThrow('lacks required role "admin"')
	expect(mocks.cleanupMemberlessTeamOrgs).not.toHaveBeenCalled()

	const org = {
		orgId: 'org-1',
		slug: 'team-one',
		createdAt: '2026-11-01T00:00:00.000Z',
		creatorDeleted: true,
		packageCount: 2,
	}
	mocks.cleanupMemberlessTeamOrgs.mockResolvedValue({
		dryRun: true,
		total: 1,
		orgs: [org],
		purgedOrgIds: [],
		failures: [],
	})
	expect(
		await adminMemberlessTeamOrgsCleanupCapability.handler(
			{},
			createContext(['admin']),
		),
	).toEqual({
		dryRun: true,
		total: 1,
		orgs: [
			{
				org_id: 'org-1',
				slug: 'team-one',
				created_at: '2026-11-01T00:00:00.000Z',
				creator_deleted: true,
				package_count: 2,
			},
		],
		purged_org_ids: [],
		failures: [],
	})
	expect(mocks.cleanupMemberlessTeamOrgs).toHaveBeenLastCalledWith(
		expect.objectContaining({ dryRun: undefined }),
	)

	mocks.cleanupMemberlessTeamOrgs.mockResolvedValue({
		dryRun: false,
		total: 1,
		orgs: [org],
		purgedOrgIds: ['org-1'],
		failures: [],
	})
	const applied = await adminMemberlessTeamOrgsCleanupCapability.handler(
		{ dryRun: false, org_ids: ['org-1'] },
		createContext(['admin']),
	)
	expect(applied.purged_org_ids).toEqual(['org-1'])
	expect(mocks.cleanupMemberlessTeamOrgs).toHaveBeenLastCalledWith(
		expect.objectContaining({
			dryRun: false,
			orgIds: ['org-1'],
			actorUserId: 'actor-1',
		}),
	)
})
