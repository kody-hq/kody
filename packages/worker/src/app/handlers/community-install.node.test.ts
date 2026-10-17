import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { CommunityActionError } from '#worker/community/errors.ts'
import { durableObjectIsolateMemoryResetMessage } from '#worker/sentry-options.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { installWebsiteCommunityPackage } from './community-install.ts'
import type * as CloudflareWorkers from 'cloudflare:workers'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	getCommunityListingById: vi.fn(),
	installCommunityListing: vi.fn(),
	getPackageScopeByUserId: vi.fn(),
	waitUntil: vi.fn(),
}))

vi.mock('cloudflare:workers', async (importOriginal) => {
	const actual = await importOriginal<typeof CloudflareWorkers>()
	return {
		...actual,
		waitUntil: (...args: Array<unknown>) => mockModule.waitUntil(...args),
	}
})

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingById: (...args: Array<unknown>) =>
		mockModule.getCommunityListingById(...args),
}))

vi.mock('#worker/community/install.ts', () => ({
	installCommunityListing: (...args: Array<unknown>) =>
		mockModule.installCommunityListing(...args),
}))

vi.mock('#worker/package-registry/user-scope.ts', () => ({
	getPackageScopeByUserId: (...args: Array<unknown>) =>
		mockModule.getPackageScopeByUserId(...args),
}))

const env = { APP_DB: {} as D1Database } as Env
const personalOwnerId = ownerIdFromStored('stable-user-b')
function listing(id: string, name: string) {
	return { id, name, trusted: false, pinnedCommit: 'commit-1' }
}

function installed(kodyId: string, overrides: Record<string, unknown> = {}) {
	const suffix = kodyId === 'demo' ? '1' : 'official'
	return {
		status: 'installed',
		forkId: `fork-${suffix}`,
		packageId: `package-${suffix}`,
		sourceId: `source-${suffix}`,
		targetKodyId: kodyId,
		targetName: `@userb/${kodyId}`,
		originCommit: 'commit-1',
		...overrides,
	}
}

test('community install POST enforces gates and maps install outcomes', async () => {
	const post = async (body: unknown = { acknowledged: true }) => {
		const response = await installWebsiteCommunityPackage({
			env,
			user: await mockModule.readAuthenticatedAppUser(),
			request: new Request(
				'https://example.com/community/listing-1/install.json',
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				},
			),
			listingId: 'listing-1',
			body,
			url: new URL('https://example.com/community/listing-1/install.json'),
		} as never)
		return {
			status: response.status,
			payload: response.data as Record<string, unknown>,
		}
	}

	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		email: 'userb@example.com',
		mcpUser: {
			userId: personIdFromStored('stable-user-b'),
			email: 'userb@example.com',
		},
	})
	mockModule.getPackageScopeByUserId.mockResolvedValue('userb')
	mockModule.getCommunityListingById.mockResolvedValue(null)
	expect((await post({})).status).toBe(404)

	mockModule.getCommunityListingById.mockResolvedValue(
		listing('listing-1', '@someone/demo'),
	)
	const unacknowledged = await post({})
	expect(unacknowledged.status).toBe(409)
	expect(unacknowledged.payload).toMatchObject({
		ok: false,
		requiresAcknowledgement: true,
	})
	expect(mockModule.installCommunityListing).not.toHaveBeenCalled()

	// `@kody/*` listings are ordinary community packages from the `@kody` org.
	mockModule.getCommunityListingById.mockResolvedValue(
		listing('listing-kody', '@kody/notion-mcp'),
	)
	const kodyOrgListing = await post({})
	expect(kodyOrgListing.status).toBe(409)
	expect(kodyOrgListing.payload).toMatchObject({
		ok: false,
		requiresAcknowledgement: true,
	})
	expect(mockModule.installCommunityListing).not.toHaveBeenCalled()

	mockModule.getCommunityListingById.mockResolvedValue(
		listing('listing-1', '@someone/demo'),
	)
	expect((await post({ acknowledged: 'yes' })).status).toBe(400)
	expect(mockModule.installCommunityListing).not.toHaveBeenCalled()

	mockModule.installCommunityListing.mockResolvedValue(installed('demo'))
	const success = await post()
	expect(success.status).toBe(200)
	expect(success.payload).toMatchObject({
		ok: true,
		status: 'installed',
		packageId: 'package-1',
		sourceId: 'source-1',
		targetName: '@userb/demo',
		agentPrompt: expect.stringContaining('@userb/demo'),
	})
	expect(mockModule.installCommunityListing).toHaveBeenCalledWith(
		expect.objectContaining({
			env,
			userId: personalOwnerId,
			userEmail: 'userb@example.com',
			expectedPackageScope: 'userb',
			listingId: 'listing-1',
			// The acknowledgement is bound to the commit the listing pinned
			// when the handler checked acknowledgement.
			expectedPinnedCommit: 'commit-1',
			// cloudflare:workers waitUntil — defers search-index / retriever
			// projection work off the install response critical path.
			waitUntil: expect.any(Function),
		}),
	)

	mockModule.installCommunityListing.mockResolvedValue(
		installed('demo', {
			status: 'adaptation_required',
			failedChecks: [{ kind: 'bundle', ok: false, message: 'unresolved' }],
			crossScopeReferences: [
				{ file: 'src/index.ts', specifier: 'kody:@usera/' },
			],
		}),
	)
	const adaptation = await post()
	expect(adaptation.status).toBe(200)
	expect(adaptation.payload).toMatchObject({
		ok: true,
		status: 'adaptation_required',
		sourceId: 'source-1',
		failedChecks: [{ kind: 'bundle', message: 'unresolved' }],
		agentPrompt: expect.stringContaining('source-1'),
	})

	mockModule.installCommunityListing.mockRejectedValue(
		new CommunityActionError(
			'You already have a saved package named "demo". Pass a different package name leaf to fork this listing.',
		),
	)
	const userFacingError = await post()
	expect(userFacingError.status).toBe(400)
	expect(userFacingError.payload).toMatchObject({
		ok: false,
		error: expect.stringContaining('already have a saved package'),
	})

	consoleError.mockImplementation(() => {})
	mockModule.installCommunityListing.mockRejectedValue(
		new Error('artifacts unavailable'),
	)
	expect(await post()).toEqual({
		status: 500,
		payload: {
			ok: false,
			error: 'Internal error. Retry later or report it if it persists.',
		},
	})
	expect(consoleError).toHaveBeenCalled()

	const artifactsClone = Object.assign(
		new Error('HTTP Error: 500 Internal Server Error'),
		{
			code: 'HttpError',
			name: 'HttpError',
			data: {
				statusCode: 500,
				statusMessage: 'Internal Server Error',
				response: '',
			},
		},
	)
	mockModule.installCommunityListing.mockRejectedValue(
		new Error(
			'Artifacts git clone failed for https://example.test/repo.git: HTTP Error: 500 Internal Server Error',
			{ cause: artifactsClone },
		),
	)
	expect(await post()).toEqual({
		status: 503,
		payload: {
			ok: false,
			error: expect.stringMatching(
				/^The package source could not be read after retries \(HTTP 5xx\)\. Report id: /,
			),
		},
	})

	mockModule.installCommunityListing.mockRejectedValue(
		new Error(durableObjectIsolateMemoryResetMessage),
	)
	expect(await post()).toEqual({
		status: 503,
		payload: {
			ok: false,
			error: expect.stringMatching(/too large to finish forking/),
		},
	})
	expect(consoleError).toHaveBeenCalledWith(
		'Community install failed:',
		expect.objectContaining({
			error: expect.stringMatching(/memory limit/),
			userMessage: expect.stringMatching(/too large to finish forking/),
		}),
	)
})

test('community install uses the personal org despite a leftover team cookie or explicit URL org', async () => {
	const personalOrgId = ownerIdFromStored('org-personal-user-b')
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		email: 'userb@example.com',
		mcpUser: {
			userId: personIdFromStored('stable-user-b'),
			personalOrgId,
			email: 'userb@example.com',
		},
	})
	mockModule.getPackageScopeByUserId.mockResolvedValue('userb')
	mockModule.getCommunityListingById.mockResolvedValue(
		listing('listing-1', '@someone/demo'),
	)
	mockModule.installCommunityListing.mockResolvedValue(installed('demo'))
	const result = await installWebsiteCommunityPackage({
		env,
		user: await mockModule.readAuthenticatedAppUser(),
		request: new Request('https://example.com/_serverFn/install?org=acme', {
			method: 'POST',
			headers: { Cookie: 'kody_last_org=acme' },
		}),
		listingId: 'listing-1',
		body: { acknowledged: true },
	})
	expect(result.status).toBe(200)
	expect(mockModule.getPackageScopeByUserId).toHaveBeenCalledWith(
		env.APP_DB,
		personalOrgId,
	)
	expect(mockModule.installCommunityListing).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: personalOrgId,
			expectedPackageScope: 'userb',
		}),
	)
})
