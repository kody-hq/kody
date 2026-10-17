import { beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	target: {} as Record<string, unknown>,
	headers: vi.fn(),
	status: vi.fn(),
	auth: vi.fn(),
	resolve: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let validate = (data: unknown) => data
		const builder = {
			validator(next: { parse: (data: unknown) => unknown }) {
				validate = next.parse
				return builder
			},
			handler(run: (input: { data: unknown }) => Promise<unknown>) {
				return async (input: { data: unknown }) =>
					run({ data: validate(input.data) })
			},
		}
		return builder
	},
}))
vi.mock('@tanstack/react-router', () => ({
	redirect: (options: unknown) => ({ redirect: options }),
	notFound: () => ({ notFound: true }),
}))
vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => new Request('https://kody.test/_serverFn/read'),
	setResponseHeader: state.headers,
	setResponseStatus: state.status,
}))
vi.mock('../../src/app/env.ts', () => ({ getEnv: () => ({}) }))
vi.mock('../../src/app/auth-session.ts', () => ({
	setAuthSessionSecret: vi.fn(),
}))
vi.mock('../../src/app/community-package-route.ts', () => ({
	resolveCommunityFilesRoute: state.resolve,
}))
vi.mock('../../src/app/package-files-data.ts', () => ({
	loadAccessiblePackageFilesData: vi.fn(),
	loadListingFilesData: vi.fn(),
}))
vi.mock('../../src/app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: state.auth,
}))
vi.mock('../../src/package-registry/repo.ts', () => ({
	getSavedPackageByIdInAnyOrg: async () => ({
		id: 'pkg',
		userId: 'org-id',
		kodyId: 'digest',
	}),
}))
vi.mock('../../src/app/package-viewer-access.ts', () => ({
	viewerCanReadSavedPackage: async () => true,
}))
vi.mock('../../src/orgs/repo.ts', () => ({
	loadOrgBindingForOrg: async () => ({ org: { slug: 'acme' } }),
}))
vi.mock('./document-head.ts', () => ({ loadDocumentHead: vi.fn() }))
import { loadPackageFiles } from './package-files.ts'
beforeEach(() => {
	vi.clearAllMocks()
	state.resolve.mockImplementation(async () => state.target)
	state.auth.mockResolvedValue({
		username: 'person',
		mcpUser: { userId: 'person-id' },
	})
})
test('public canonical redirect preserves query and fragment and permanent status', async () => {
	state.target = {
		kind: 'redirect',
		to: '/@acme/digest/tree/main/README.md',
		shared: true,
	}
	await expect(
		loadPackageFiles({
			data: {
				resource: {
					kind: 'package-files',
					username: 'acme',
					kodyId: 'digest',
					relativePath: 'README.md',
				},
				location: '/@acme/digest/files/README.md?view=source#L4',
			},
		}),
	).rejects.toEqual({
		redirect: {
			href: 'https://kody.test/@acme/digest/tree/main/README.md?view=source#L4',
			statusCode: 301,
		},
	})
	expect(state.headers).toHaveBeenCalledWith(
		'Cache-Control',
		'public, max-age=3600',
	)
})
test('private file login resumes the exact requested location', async () => {
	state.target = { kind: 'unauthorized' }
	const pathname = '/@acme/digest/tree/main/README.md?view=source#L4'
	await expect(
		loadPackageFiles({
			data: {
				resource: {
					kind: 'package-tree',
					username: 'acme',
					kodyId: 'digest',
					ref: 'main',
					relativePath: 'README.md',
				},
				location: pathname,
			},
		}),
	).rejects.toEqual({
		redirect: {
			href: `/login?redirectTo=${encodeURIComponent(pathname)}`,
			statusCode: 302,
		},
	})
})
test('account file alias preserves suffix and resolves the package organization', async () => {
	const pathname = '/account/packages/pkg/files/README.md?view=source#L4'
	await expect(
		loadPackageFiles({
			data: {
				resource: {
					kind: 'account-files',
					packageId: 'pkg',
					relativePath: 'README.md',
				},
				location: pathname,
			},
		}),
	).rejects.toMatchObject({
		redirect: {
			href: expect.stringMatching(
				/^\/@acme\/digest\/tree\/[^/]+\/README\.md\?view=source#L4$/,
			),
			statusCode: 302,
		},
	})
	expect(state.auth).toHaveBeenCalledWith(
		expect.any(Request),
		expect.anything(),
		{ redirectTo: pathname },
	)
	expect(state.headers).toHaveBeenCalledWith(
		'Cache-Control',
		'private, no-store',
	)
})
test.each(['//evil.test/files', '/\\evil.test/files', '/%5cevil.test/files'])(
	'rejects unsafe file location %s',
	async (pathname) => {
		await expect(
			loadPackageFiles({
				data: {
					resource: {
						kind: 'package-tree',
						username: 'acme',
						kodyId: 'digest',
						ref: 'main',
						relativePath: 'README.md',
					},
					location: pathname,
				},
			}),
		).rejects.toThrow()
		expect(state.auth).not.toHaveBeenCalled()
	},
)

test('signed-in file denial stays403 instead of redirecting to login', async () => {
	state.target = {
		kind: 'no_access',
		username: 'owner',
		kodyId: 'private',
		packageName: '@owner/private',
		viewerUsername: 'visitor',
	}
	const result = await loadPackageFiles({
		data: {
			resource: {
				kind: 'package-tree',
				username: 'owner',
				kodyId: 'private',
				ref: 'main',
				relativePath: 'README.md',
			},
			location: '/@owner/private/tree/main/README.md',
		},
	})
	expect(result).toMatchObject({
		kind: 'no_access',
		data: null,
		viewerUsername: 'visitor',
	})
	expect(state.status).toHaveBeenCalledWith(403)
	expect(state.headers).toHaveBeenCalledWith(
		'Cache-Control',
		'private, no-store',
	)
})

test('resource selection comes from native params, not the navigation URL', async () => {
	state.target = { kind: 'invalid-path' }
	const resource = {
		kind: 'package-tree' as const,
		username: 'owner',
		kodyId: 'private',
		ref: 'main',
		relativePath: 'README.md',
	}
	await expect(
		loadPackageFiles({
			data: {
				resource,
				location: '/community/other/files/README.md',
				queryRef: 'ignored',
			},
		}),
	).rejects.toEqual({ notFound: true })
	expect(state.resolve).toHaveBeenCalledWith(
		expect.objectContaining({
			resource,
			pathname: '/community/other/files/README.md',
			request: expect.any(Request),
		}),
	)
	const request = state.resolve.mock.calls[0]?.[0].request as Request
	expect(new URL(request.url).pathname).toBe('/_serverFn/read')
})
