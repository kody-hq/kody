import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getSavedPackageByIdInAnyOrg: vi.fn(),
	loadAccountPackageApprovePublishData: vi.fn(),
	loadPackagePage: vi.fn(),
	readAuthenticatedAppUser: vi.fn(),

	requireAuthenticatedPageUser: vi.fn(),
}))

vi.mock('#app/account-package-publish-lock.ts', () => ({
	loadAccountPackageApprovePublishData: (...args: Array<unknown>) =>
		mockModule.loadAccountPackageApprovePublishData(...args),
}))
vi.mock('#app/package-page.ts', () => ({
	loadPackagePage: (...args: Array<unknown>) =>
		mockModule.loadPackagePage(...args),
}))
vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))
vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: (...args: Array<unknown>) =>
		mockModule.requireAuthenticatedPageUser(...args),
}))
vi.mock('#app/package-viewer-access.ts', () => ({
	viewerCanManageSavedPackage: vi.fn(async () => true),
	viewerCanReadSavedPackage: vi.fn(async () => true),
}))

vi.mock('#worker/orgs/repo.ts', () => ({
	loadOrgBindingForOrg: vi.fn(async () => ({
		org: { id: ownerIdFromStored('user-1'), slug: 'kentcdodds' },
		role: 'owner' as const,
	})),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageByIdInAnyOrg: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByIdInAnyOrg(...args),
}))

const { loadPublishReview } =
	await import('../../../start/server/package-review.ts')
const { loadAccountPackageAlias } =
	await import('../../../start/server/package-alias.ts')

const native = vi.hoisted(() => ({
	env: {} as Env,
	request: new Request('https://example.com/login'),
	setResponseHeader: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerOnlyFn: <T>(fn: T) => fn,
	createServerFn: () => {
		let validate = (data: unknown) => data
		const builder = {
			validator: (fn: typeof validate) => {
				validate = fn
				return builder
			},
			handler:
				(fn: (input: { data: unknown }) => unknown) =>
				(input: { data: unknown }) =>
					fn({ data: validate(input.data) }),
		}
		return builder
	},
}))
vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	get env() {
		return native.env
	},
}))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => native.request,
	setResponseHeader: native.setResponseHeader,
}))
vi.mock('#app/env.ts', () => ({ getEnv: () => native.env }))

const user = {
	username: 'kentcdodds',
	email: 'kent@example.com',
	mcpUser: { userId: ownerIdFromStored('user-1') },
}

test('legacy package approval links redirect and the canonical owner URL renders', async () => {
	mockModule.requireAuthenticatedPageUser.mockResolvedValue(user)
	mockModule.getSavedPackageByIdInAnyOrg.mockResolvedValue({
		id: 'pkg-1',
		userId: ownerIdFromStored('user-1'),
		kodyId: 'github-triage',
	})
	native.env = {
		APP_DB: {},
		COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef0123456789',
	} as Env
	await expect(
		loadAccountPackageAlias({
			data: {
				packageId: 'pkg-1',
				approval: 'publish',
				search: '?commit=abc1234',
			},
		}),
	).rejects.toMatchObject({
		status: 302,
		options: {
			href: '/@kentcdodds/github-triage/approve-publish?commit=abc1234',
		},
	})

	const ownerPackage = {
		id: 'pkg-1',
		kodyId: 'github-triage',
		name: '@kentcdodds/github-triage',
	}
	const requestApproval = () =>
		loadPublishReview({
			data: {
				username: 'kentcdodds',
				kodyId: 'github-triage',
				commit: 'abc1234',
			},
		})
	mockModule.loadAccountPackageApprovePublishData.mockResolvedValue({
		ok: true,
		package: ownerPackage,
	})

	mockModule.loadPackagePage.mockResolvedValue({
		kind: 'page',
		viewerIsOwner: true,
		viewerCanManage: false,
		ownerPackage,
	})
	await expect(requestApproval()).rejects.toMatchObject({ isNotFound: true })
	expect(mockModule.loadAccountPackageApprovePublishData).not.toHaveBeenCalled()

	mockModule.loadPackagePage.mockResolvedValue({
		kind: 'page',
		viewerIsOwner: true,
		viewerCanManage: true,
		ownerPackage,
	})
	const canonical = await requestApproval()
	expect(canonical.payload.ok).toBe(true)
	expect(mockModule.loadAccountPackageApprovePublishData).toHaveBeenCalledWith({
		env: expect.any(Object),
		request: expect.any(Request),
		user,
		packageId: 'pkg-1',
		commit: 'abc1234',
	})
})
