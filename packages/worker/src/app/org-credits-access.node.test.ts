import { beforeEach, expect, test, vi } from 'vitest'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type AuthenticatedAppUser } from './authenticated-user.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { loadAuthorizedOrgCredits } from './org-credits-access.ts'

const mocks = vi.hoisted(() => ({
	authorize: vi.fn(),
	getOrg: vi.fn(),
	load: vi.fn(),
}))
vi.mock('#worker/authorization/authorize.ts', async (importOriginal) => ({
	...(await importOriginal<
		typeof import('#worker/authorization/authorize.ts')
	>()),
	authorize: mocks.authorize,
}))
vi.mock('#worker/orgs/repo.ts', () => ({ getOrgById: mocks.getOrg }))
vi.mock('#app/org-credits-data.ts', () => ({
	decodeCreditLedgerCursor: () => null,
	loadOrgCreditsData: mocks.load,
}))

const env = {} as Env
function viewer(orgId: string): AuthenticatedAppUser {
	const mcpUser = {
		userId: personIdFromStored('person-ada'),
		personalOrgId: ownerIdFromStored('personal-ada'),
		email: 'ada@example.com',
		displayName: 'Ada',
	}
	return {
		sessionUserId: '1',
		userId: 1,
		username: 'ada',
		email: mcpUser.email,
		emailVerified: true,
		emailVerificationDelivery: null,
		displayName: 'Ada',
		roles: ['user'],
		permissions: [],
		artifactOwnerIds: ['1'],
		mcpUser,
		request: deriveRequestContext({
			user: mcpUser,
			source: { kind: 'session' },
			orgBinding: {
				org: { id: ownerIdFromStored(orgId), slug: 'workspace' },
				role: 'owner',
			},
		}),
	}
}
beforeEach(() => {
	vi.resetAllMocks()
	mocks.getOrg.mockResolvedValue({
		slug: 'workspace',
		display_name: 'Workspace',
	})
	mocks.load.mockResolvedValue({ ok: true })
})

test('the stamped personal org, not the person id, determines personal billing presentation', async () => {
	for (const [orgId, personal] of [
		['personal-ada', true],
		['team-acme', false],
		['person-ada', false],
	] as const) {
		const user = viewer(orgId)
		await loadAuthorizedOrgCredits({ env, user })
		expect(mocks.authorize).toHaveBeenLastCalledWith(
			{ env, request: user.request },
			'billing:read',
		)
		expect(mocks.load).toHaveBeenLastCalledWith(
			expect.objectContaining({
				org: {
					id: orgId,
					slug: 'workspace',
					displayName: 'Workspace',
					personal,
				},
				viewerUserId: 'person-ada',
				canReadBilling: true,
			}),
		)
	}
})

test('a billing denial still limits the personal org to its viewer budget', async () => {
	mocks.authorize.mockRejectedValue(
		new AuthorizationError({
			code: 'missing_permission',
			permission: 'billing:read',
			orgId: ownerIdFromStored('personal-ada'),
			resource: null,
			message: 'Forbidden',
		}),
	)
	await loadAuthorizedOrgCredits({ env, user: viewer('personal-ada') })
	expect(mocks.load).toHaveBeenCalledWith(
		expect.objectContaining({
			canReadBilling: false,
			viewerUserId: 'person-ada',
			org: expect.objectContaining({ personal: true }),
		}),
	)
})

test('unexpected authorization failures and missing orgs never load ledger data', async () => {
	mocks.authorize.mockRejectedValueOnce(new Error('authorization unavailable'))
	await expect(
		loadAuthorizedOrgCredits({ env, user: viewer('personal-ada') }),
	).rejects.toThrow('authorization unavailable')
	expect(mocks.load).not.toHaveBeenCalled()
	mocks.getOrg.mockResolvedValue(null)
	expect(
		await loadAuthorizedOrgCredits({ env, user: viewer('personal-ada') }),
	).toBeNull()
	expect(mocks.load).not.toHaveBeenCalled()
})
