import type { AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { personalUsageSlug } from './account-usage.ts'
import { personalOrgUsageRedirectUrl } from './org-usage.ts'

const mockModule = vi.hoisted(() => ({
	requireAuthenticatedPageUser: vi.fn<() => Promise<unknown>>(),
	getOrgById: vi.fn<(db: unknown, id: string) => Promise<unknown>>(),
}))

vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: () => mockModule.requireAuthenticatedPageUser(),
}))

vi.mock('#worker/orgs/repo.ts', () => ({
	getOrgById: (db: unknown, id: string) => mockModule.getOrgById(db, id),
}))

const env = { APP_DB: {} } as Env

beforeEach(() => {
	vi.clearAllMocks()
	mockModule.requireAuthenticatedPageUser.mockResolvedValue({
		userId: 7,
		username: 'ada',
		mcpUser: { userId: ownerIdFromStored('stable-7') },
	})
	mockModule.getOrgById.mockResolvedValue({ slug: 'ada' })
})

async function getUsage(search = '') {
	const request = new Request(`https://kody.codes/account/usage${search}`)
	const user =
		(await mockModule.requireAuthenticatedPageUser()) as AuthenticatedAppUser
	return personalOrgUsageRedirectUrl({
		requestUrl: request.url,
		slug: await personalUsageSlug(env, user),
	})
}

test('legacy /account/usage redirects to the personal org usage page', async () => {
	const response = await getUsage()
	expect(response).toBe('https://kody.codes/@ada/-/usage')
	expect(mockModule.getOrgById).toHaveBeenCalledWith(env.APP_DB, 'stable-7')
})

test('the redirect keeps Stripe return and notice query params', async () => {
	const response = await getUsage('?topup=success&session_id=cs_123')
	expect(response).toBe(
		'https://kody.codes/@ada/-/usage?topup=success&session_id=cs_123',
	)
})

test('missing signup org slug falls back to the username', async () => {
	mockModule.getOrgById.mockResolvedValueOnce(null)
	const response = await getUsage('?credits=added')
	expect(response).toBe('https://kody.codes/@ada/-/usage?credits=added')
})
