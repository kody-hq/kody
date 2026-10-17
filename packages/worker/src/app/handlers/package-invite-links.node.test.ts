import { beforeEach, expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
	scope: vi.fn(),
	create: vi.fn(),
	revoke: vi.fn(),
	list: vi.fn(),
}))
vi.mock('#app/handlers/package-collaborators.ts', () => ({
	loadCollaboratorsScope: mocks.scope,
}))
vi.mock('#worker/orgs/org-audit.ts', () => ({
	orgAuditWriterFromRequest: () => ({}),
}))
vi.mock('#worker/orgs/invite-links.ts', async (original) => ({
	...(await original<Record<string, unknown>>()),
	createOrgInviteLink: mocks.create,
	revokeOrgInviteLink: mocks.revoke,
	listActiveOrgInviteLinks: mocks.list,
	generateInviteLinkToken: () => 'one-time-token',
	hashInviteLinkToken: async () => 'token-hash',
}))
import {
	createPackageInviteLink,
	revokePackageInviteLink,
} from './package-invite-links.ts'
const input = {
	env: { APP_DB: {} },
	request: new Request('https://kody.test'),
	user: {
		mcpUser: { userId: 'actor' },
		request: new Request('https://kody.test'),
	},
	username: 'team',
	kodyId: 'package',
	preset: 'use',
} as unknown as Parameters<typeof createPackageInviteLink>[0]
beforeEach(() => {
	vi.resetAllMocks()
	mocks.scope.mockResolvedValue({
		kind: 'ready',
		scope: { org: { id: 'org' }, savedPackage: { id: 'package' } },
	})
	mocks.create.mockResolvedValue({ id: 'link', expiresAt: null, maxUses: 1 })
	mocks.list.mockRejectedValue(new Error('List read unavailable'))
})
test('accepted creation returns its one-time link without a postwrite list read', async () => {
	const result = await createPackageInviteLink(input)
	expect(result.data).toMatchObject({
		ok: true,
		inviteLink: {
			id: 'link',
			preset: 'use',
			url: expect.stringContaining('one-time-token'),
		},
	})
	expect(result.data).not.toHaveProperty('links')
	expect(mocks.list).not.toHaveBeenCalled()
	expect(mocks.create).toHaveBeenCalledWith(
		expect.objectContaining({
			orgId: 'org',
			createdByUserId: 'actor',
			tokenHash: 'token-hash',
			target: {
				kind: 'resource',
				resourceType: 'package',
				resourceId: 'package',
				preset: 'use',
			},
		}),
	)
})
test('revoke stays scoped to the authorized package and does not reload a page', async () => {
	const result = await revokePackageInviteLink({ ...input, linkId: 'link' })
	expect(result.data).toEqual({ ok: true, linkId: 'link' })
	expect(mocks.revoke).toHaveBeenCalledWith(
		expect.objectContaining({
			orgId: 'org',
			linkId: 'link',
			scope: {
				kind: 'resource',
				resourceType: 'package',
				resourceId: 'package',
			},
		}),
	)
	expect(mocks.list).not.toHaveBeenCalled()
})
test.each(['not_found', 'forbidden'])(
	'both writes reject %s package access',
	async (kind) => {
		mocks.scope.mockResolvedValue({ kind })
		expect((await createPackageInviteLink(input)).status).toBe(
			kind === 'forbidden' ? 403 : 404,
		)
		expect(
			(await revokePackageInviteLink({ ...input, linkId: 'link' })).status,
		).toBe(kind === 'forbidden' ? 403 : 404)
		expect(mocks.create).not.toHaveBeenCalled()
		expect(mocks.revoke).not.toHaveBeenCalled()
	},
)
