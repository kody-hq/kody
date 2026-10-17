import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createAccountRepoIconHandler } from './account-repo-icon.ts'
import type * as IdentityIconResponse from './identity-icon-response.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	getUserRepoById: vi.fn(),
	getEntitySourceByEntity: vi.fn(),
	serveIdentityIcon: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/repo/user-repos.ts', () => ({
	getUserRepoById: (...args: Array<unknown>) => mocks.getUserRepoById(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceByEntity: (...args: Array<unknown>) =>
		mocks.getEntitySourceByEntity(...args),
}))

vi.mock('./identity-icon-response.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof IdentityIconResponse>()
	return {
		...actual,
		identityIconNotFound: () => new Response('Not found', { status: 404 }),
		serveIdentityIcon: (...args: Array<unknown>) =>
			mocks.serveIdentityIcon(...args),
	}
})

const source = {
	id: 'source-1',
	user_id: ownerIdFromStored('user-1'),
	entity_kind: 'repo' as const,
	entity_id: 'repo-1',
	repo_id: 'repo-1',
	published_commit: 'pub-1',
	indexed_commit: 'idx-1',
}

function callHandler(iconCommit = 'idx-1') {
	const handler = createAccountRepoIconHandler({ APP_DB: {} } as Env)
	return handler({
		request: new Request(
			`https://example.com/account/repos/repo-1/icon/${iconCommit}`,
		),
		params: { repoId: 'repo-1', iconCommit },
		url: new URL(`https://example.com/account/repos/repo-1/icon/${iconCommit}`),
	} as never)
}

test('repo identity icon serves the indexed commit for the owner', async () => {
	mocks.readAuthenticatedAppUser.mockResolvedValue({
		mcpUser: { userId: ownerIdFromStored('user-1') },
	})
	mocks.getUserRepoById.mockResolvedValue({
		id: 'repo-1',
		userId: ownerIdFromStored('user-1'),
		name: 'notes',
	})
	mocks.getEntitySourceByEntity.mockResolvedValue(source)
	mocks.serveIdentityIcon.mockResolvedValue(
		new Response('icon', { status: 200 }),
	)

	const response = await callHandler()
	expect(response.status).toBe(200)
	expect(mocks.serveIdentityIcon).toHaveBeenCalledWith(
		expect.objectContaining({
			repoId: 'repo-1',
			iconCommit: 'idx-1',
			includePackageAppIcon: false,
			leafName: 'notes',
			cacheControl: 'private, max-age=31536000, immutable',
		}),
	)
})

test('repo identity icon rejects guests and stale commits', async () => {
	mocks.readAuthenticatedAppUser.mockResolvedValue(null)
	expect((await callHandler()).status).toBe(404)

	mocks.readAuthenticatedAppUser.mockResolvedValue({
		mcpUser: { userId: ownerIdFromStored('user-1') },
	})
	mocks.getUserRepoById.mockResolvedValue({
		id: 'repo-1',
		userId: ownerIdFromStored('user-1'),
		name: 'notes',
	})
	mocks.getEntitySourceByEntity.mockResolvedValue(source)
	expect((await callHandler('old-commit')).status).toBe(404)
})
