import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	resolveOwnedUserRepo: vi.fn(),
	resolveArtifactSourceHead: vi.fn(),
	resolveExistingArtifactSourceRepo: vi.fn(),
	computeEffectivePermissions: vi.fn(),
}))

vi.mock('./resolve-user-repo.ts', () => ({
	resolveOwnedUserRepo: (...args: Array<unknown>) =>
		mockModule.resolveOwnedUserRepo(...args),
}))

vi.mock('#worker/repo/artifacts.ts', async () => {
	const actual = await vi.importActual('#worker/repo/artifacts.ts')
	return {
		...(actual as object),
		resolveArtifactSourceHead: (...args: Array<unknown>) =>
			mockModule.resolveArtifactSourceHead(...args),
		resolveExistingArtifactSourceRepo: (...args: Array<unknown>) =>
			mockModule.resolveExistingArtifactSourceRepo(...args),
	}
})

vi.mock('#worker/authorization/authorize.ts', async () => {
	const actual = await vi.importActual<
		typeof import('#worker/authorization/authorize.ts')
	>('#worker/authorization/authorize.ts')
	return {
		...actual,
		computeEffectivePermissions: (...args: Array<unknown>) =>
			mockModule.computeEffectivePermissions(...args),
		// authorizeOrgWide closes over the real computeEffectivePermissions;
		// rebind it so tests control EffectivePermissions.
		authorizeOrgWide: async (
			_ctx: { env: Env; request: unknown },
			permission: OrgPermission,
		) => {
			const access = await mockModule.computeEffectivePermissions()
			const decision = actual.checkOrgWide(access, permission)
			if (!decision.allowed) throw decision.error
		},
	}
})

const { repoGetGitRemoteCapability } = await import('./repo-get-git-remote.ts')

function resetMocks() {
	for (const fn of Object.values(mockModule)) fn.mockReset()
}

function callerContextWithScopes(scopes: Array<OrgPermission> | null) {
	const callerContext = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://heykody.dev',
		user: {
			userId: personIdFromStored('user-1'),
			email: 'user-1@example.com',
			displayName: 'user-1',
		},
	})
	if (!scopes || !callerContext.request) return callerContext
	return {
		...callerContext,
		request: {
			...callerContext.request,
			credential: { ...callerContext.request.credential, scopes },
		},
	}
}

function orgWideAccess(permissions: Array<OrgPermission>) {
	return {
		orgId: ownerIdFromStored('user-1'),
		isOwner: false,
		permissions: new Set(permissions),
		resourcePermissions: new Map(),
		credentialScopes: null,
	}
}

/** Org-wide read plus a write grant on some other package — not write on repos. */
function orgReadPlusPackageWriteGrant() {
	return {
		orgId: ownerIdFromStored('user-1'),
		isOwner: false,
		permissions: new Set<OrgPermission>(['package:read']),
		resourcePermissions: new Map([
			[`package:pkg-other`, new Set<OrgPermission>(['package:write'])],
		]),
		credentialScopes: null,
	}
}

function mockRepoRemote() {
	const createToken = vi.fn(async (scope: 'read' | 'write', ttl: number) => ({
		id: 'token-1',
		plaintext: `art_v1_${scope}_token?expires=${Math.floor(Date.now() / 1000) + ttl}`,
		scope,
		expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
	}))
	const remote =
		'https://acct.artifacts.cloudflare.net/git/default/repo-notes.git'
	mockModule.resolveOwnedUserRepo.mockResolvedValue({
		userRepo: {
			id: 'repo-1',
			userId: ownerIdFromStored('user-1'),
			name: 'notes',
			description: null,
			isPrivate: true,
			createdAt: '2026-05-04T00:00:00.000Z',
			updatedAt: '2026-05-04T00:00:00.000Z',
		},
		source: {
			id: 'source-1',
			user_id: 'user-1',
			entity_kind: 'repo',
			entity_id: 'repo-1',
			repo_id: 'repo-notes',
			published_commit: null,
			indexed_commit: null,
			manifest_path: null,
			source_root: '/',
			last_external_check_at: null,
			external_check_until: null,
			created_at: '2026-05-04T00:00:00.000Z',
			updated_at: '2026-05-04T00:00:00.000Z',
		},
	})
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		oid: 'commit-1',
	})
	mockModule.resolveExistingArtifactSourceRepo.mockResolvedValue({
		info: vi.fn(async () => ({ remote, defaultBranch: 'main' })),
		createToken,
	})
	return { createToken, remote }
}

async function getRemote(
	args: Record<string, unknown>,
	{
		access,
		scopes = null,
	}: {
		access: ReturnType<typeof orgWideAccess>
		scopes?: Array<OrgPermission> | null
	},
) {
	mockModule.computeEffectivePermissions.mockResolvedValue(access)
	return repoGetGitRemoteCapability.handler(args, {
		env: { APP_DB: {} } as unknown as Env,
		callerContext: callerContextWithScopes(scopes),
	})
}

test('repoGetGitRemote defaults to write for org-wide package:write', async () => {
	resetMocks()
	const { createToken } = mockRepoRemote()
	await expect(
		getRemote(
			{ name: 'notes' },
			{ access: orgWideAccess(['package:read', 'package:write']) },
		),
	).resolves.toMatchObject({
		scope: 'write',
		name: 'notes',
	})
	expect(createToken).toHaveBeenCalledWith('write', 14_400)
})

test('repoGetGitRemote defaults to read for org-wide package:read only', async () => {
	resetMocks()
	const { createToken } = mockRepoRemote()
	await expect(
		getRemote({ name: 'notes' }, { access: orgWideAccess(['package:read']) }),
	).resolves.toMatchObject({ scope: 'read' })
	expect(createToken).toHaveBeenCalledWith('read', 14_400)
})

test('repoGetGitRemote does not treat a single-package write grant as write on plain repos', async () => {
	resetMocks()
	const { createToken } = mockRepoRemote()
	await expect(
		getRemote({ name: 'notes' }, { access: orgReadPlusPackageWriteGrant() }),
	).resolves.toMatchObject({ scope: 'read' })
	expect(createToken).toHaveBeenCalledWith('read', 14_400)

	createToken.mockClear()
	await expect(
		getRemote(
			{ name: 'notes', scope: 'write' },
			{ access: orgReadPlusPackageWriteGrant() },
		),
	).rejects.toMatchObject({
		code: 'missing_permission',
		permission: 'package:write',
		message: expect.stringMatching(
			/You have read access to repo notes, not write[\s\S]*across this org[\s\S]*single-package grant/,
		),
	})
	expect(createToken).not.toHaveBeenCalled()
})

test('repoGetGitRemote honors explicit scope and denies write without org-wide write', async () => {
	resetMocks()
	const { createToken } = mockRepoRemote()
	await expect(
		getRemote(
			{ name: 'notes', scope: 'read' },
			{ access: orgWideAccess(['package:read', 'package:write']) },
		),
	).resolves.toMatchObject({ scope: 'read' })
	expect(createToken).toHaveBeenCalledWith('read', 14_400)

	createToken.mockClear()
	await expect(
		getRemote(
			{ name: 'notes', scope: 'write' },
			{ access: orgWideAccess(['package:read']) },
		),
	).rejects.toMatchObject({
		code: 'missing_permission',
		permission: 'package:write',
		message: expect.stringMatching(
			/You have read access to repo notes, not write[\s\S]*scope: 'read'[\s\S]*across this org/,
		),
	})
	expect(createToken).not.toHaveBeenCalled()
})
