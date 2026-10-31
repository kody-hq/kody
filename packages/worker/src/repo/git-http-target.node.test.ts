import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'

const loadOrgBindingForOrg = vi.fn()
const findPublicOwnerIdentityByHandle = vi.fn()
const resolvePackagePageUrl = vi.fn()
const viewerCanReadSavedPackage = vi.fn()
const getEntitySourceByEntity = vi.fn()
const getUserRepoByName = vi.fn()
const computeEffectivePermissions = vi.fn()

vi.mock('#worker/orgs/repo.ts', () => ({
	loadOrgBindingForOrg: (...args: Array<unknown>) =>
		loadOrgBindingForOrg(...args),
}))

vi.mock('#worker/identity/user-lookup.ts', () => ({
	findPublicOwnerIdentityByHandle: (...args: Array<unknown>) =>
		findPublicOwnerIdentityByHandle(...args),
}))

vi.mock('#worker/community/package-url.ts', () => ({
	resolvePackagePageUrl: (...args: Array<unknown>) =>
		resolvePackagePageUrl(...args),
}))

vi.mock('#worker/app/package-viewer-access.ts', () => ({
	viewerCanReadSavedPackage: (...args: Array<unknown>) =>
		viewerCanReadSavedPackage(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceByEntity: (...args: Array<unknown>) =>
		getEntitySourceByEntity(...args),
}))

vi.mock('#worker/repo/user-repos.ts', () => ({
	getUserRepoByName: (...args: Array<unknown>) => getUserRepoByName(...args),
}))

vi.mock('#worker/authorization/authorize.ts', async () => {
	const actual = await vi.importActual<
		typeof import('#worker/authorization/authorize.ts')
	>('#worker/authorization/authorize.ts')
	return {
		...actual,
		computeEffectivePermissions: (...args: Array<unknown>) =>
			computeEffectivePermissions(...args),
	}
})

const { parseGitCredentialRepoPath, resolveGitHttpTargetAccess } =
	await import('./git-http-target.ts')

const viewerUserId = personIdFromStored('viewer-person')
const resourceOwnerId = ownerIdFromStored('kody-org-owner')
const packageId = 'pkg-cross-org-1'
const sourceId = 'source-cross-org-1'
const repoId = 'artifact-repo-cross-org-1'

function resetMocks() {
	loadOrgBindingForOrg.mockReset()
	findPublicOwnerIdentityByHandle.mockReset()
	resolvePackagePageUrl.mockReset()
	viewerCanReadSavedPackage.mockReset()
	getEntitySourceByEntity.mockReset()
	getUserRepoByName.mockReset()
	computeEffectivePermissions.mockReset()
}

function seedCrossOrgPackage(input?: {
	ownerHandle?: string
	repoName?: string
}) {
	const ownerHandle = input?.ownerHandle ?? 'kody'
	const repoName = input?.repoName ?? 'issue-triage'
	findPublicOwnerIdentityByHandle.mockResolvedValue({
		handle: ownerHandle,
		ownerId: resourceOwnerId,
	})
	resolvePackagePageUrl.mockResolvedValue({
		kind: 'package',
		username: ownerHandle,
		kodyId: repoName,
		userId: resourceOwnerId,
		savedPackage: {
			id: packageId,
			user_id: resourceOwnerId,
			kody_id: repoName,
			name: `@${ownerHandle}/${repoName}`,
		},
		listingId: null,
		listingKodyId: null,
	})
	loadOrgBindingForOrg.mockResolvedValue({
		org: { id: resourceOwnerId, slug: ownerHandle },
		role: 'owner',
	})
	computeEffectivePermissions.mockResolvedValue({
		orgId: resourceOwnerId,
		isOwner: true,
		permissions: new Set(['package:read', 'package:write']),
		resourcePermissions: new Map(),
		credentialScopes: new Set(['package:read', 'package:write']),
	})
	viewerCanReadSavedPackage.mockResolvedValue(true)
	getEntitySourceByEntity.mockResolvedValue({
		id: sourceId,
		user_id: resourceOwnerId,
		entity_kind: 'package',
		entity_id: packageId,
		repo_id: repoId,
	})
	getUserRepoByName.mockResolvedValue(null)
}

test('parseGitCredentialRepoPath accepts @owner/name.git shapes', () => {
	expect(parseGitCredentialRepoPath('/@kent/cloudflare.git')).toEqual({
		ownerHandle: 'kent',
		repoName: 'cloudflare',
	})
	expect(parseGitCredentialRepoPath('kent/cloudflare.git/info/refs')).toEqual({
		ownerHandle: 'kent',
		repoName: 'cloudflare',
	})
})

test('parseGitCredentialRepoPath returns null for invalid percent-encoding', () => {
	expect(parseGitCredentialRepoPath('/@kent/%E0%A4%A.git')).toBeNull()
})

test('resolveGitHttpTargetAccess authorizes by resource-owner membership across orgs', async () => {
	resetMocks()
	seedCrossOrgPackage()

	const access = await resolveGitHttpTargetAccess({
		env: { APP_DB: {} } as Env,
		viewer: { userId: viewerUserId, username: 'viewer' },
		ownerHandle: 'kody',
		repoName: 'issue-triage',
		scopes: ['package:read', 'package:write'],
		needWrite: false,
	})

	expect(access).toMatchObject({
		ownerHandle: 'kody',
		repoName: 'issue-triage',
		resourceKind: 'package',
		resourceId: packageId,
		resourceOrgId: resourceOwnerId,
		sourceId,
		repoId,
		canRead: true,
		canWrite: true,
	})

	// Git HTTPS has no ?org= / login-org: authz must bind to the *resource*
	// owner's org (here @kody), not the viewer's personal org.
	expect(loadOrgBindingForOrg).toHaveBeenCalledWith(
		expect.anything(),
		viewerUserId,
		resourceOwnerId,
	)
	expect(loadOrgBindingForOrg).not.toHaveBeenCalledWith(
		expect.anything(),
		viewerUserId,
		viewerUserId,
	)
})

test('resolveGitHttpTargetAccess returns null when the viewer is not in the resource org', async () => {
	resetMocks()
	seedCrossOrgPackage()
	loadOrgBindingForOrg.mockResolvedValue(null)
	computeEffectivePermissions.mockResolvedValue(null)
	viewerCanReadSavedPackage.mockResolvedValue(false)

	const access = await resolveGitHttpTargetAccess({
		env: { APP_DB: {} } as Env,
		viewer: { userId: viewerUserId, username: 'viewer' },
		ownerHandle: 'kody',
		repoName: 'issue-triage',
		scopes: ['package:read', 'package:write'],
		needWrite: false,
	})

	expect(access).toBeNull()
	expect(loadOrgBindingForOrg).toHaveBeenCalledWith(
		expect.anything(),
		viewerUserId,
		resourceOwnerId,
	)
})

test('resolveGitHttpTargetAccess still resolves cross-org package write when membership allows', async () => {
	resetMocks()
	seedCrossOrgPackage({ repoName: 'clef' })

	const access = await resolveGitHttpTargetAccess({
		env: { APP_DB: {} } as Env,
		viewer: { userId: viewerUserId, username: 'viewer' },
		ownerHandle: 'kody',
		repoName: 'clef',
		scopes: ['package:read', 'package:write'],
		needWrite: true,
	})

	expect(access).toMatchObject({
		ownerHandle: 'kody',
		repoName: 'clef',
		canRead: true,
		canWrite: true,
		resourceOrgId: resourceOwnerId,
	})
	expect(loadOrgBindingForOrg).toHaveBeenCalledWith(
		expect.anything(),
		viewerUserId,
		resourceOwnerId,
	)
})
