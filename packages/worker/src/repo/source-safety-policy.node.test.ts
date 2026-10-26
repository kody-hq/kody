import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { cloudflareOpaqueInternalErrorMessage } from '#worker/cloudflare-opaque-internal-error.ts'
import { type EntitySourceRow } from './types.ts'

const artifactsMock = vi.hoisted(() => ({
	resolveExistingArtifactSourceRepo: vi.fn(),
	resolveArtifactDefaultBranchHead: vi.fn(),
}))

vi.mock('./artifacts.ts', () => ({
	resolveExistingArtifactSourceRepo: (...args: Array<unknown>) =>
		artifactsMock.resolveExistingArtifactSourceRepo(...args),
	resolveArtifactDefaultBranchHead: (...args: Array<unknown>) =>
		artifactsMock.resolveArtifactDefaultBranchHead(...args),
}))

const {
	assertPublishedPackageSourceRepoHead,
	assertRestorablePackageSourceSnapshot,
	buildPublishedCommitHeadMismatchCallerMessage,
	buildSourceRecoveryProblemMessage,
	destructiveOverwriteConfirmationField,
	isArtifactsGitReadTimeoutMessage,
	isArtifactsOpaqueInternalRetryMessage,
	isArtifactsRepoLookupTimeoutMessage,
	isDestructiveOverwriteConfirmationMessage,
	isPrivateVisibilityChangeConfirmationMessage,
	isPublishedCommitHeadMismatchMessage,
	isSourceRecoveryOpaqueInternalErrorMessage,
	privateVisibilityChangeConfirmationField,
	assertPackagePrivateVisibilityChangeAllowed,
	assertPackageSourceOverwriteAllowed,
} = await import('./source-safety-policy.ts')

function packageSource(
	overrides: Partial<EntitySourceRow> = {},
): EntitySourceRow {
	return {
		id: 'source-1',
		user_id: ownerIdFromStored('user-1'),
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'repo-1',
		published_commit: 'commit-1',
		indexed_commit: 'commit-1',
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-06-06T00:00:00.000Z',
		updated_at: '2026-06-06T00:00:00.000Z',
		...overrides,
	}
}

function createEnvWithSnapshot(files: Record<string, string> | null) {
	return {
		BUNDLE_ARTIFACTS_KV: {
			async get(_key: string, type?: 'text' | 'json') {
				if (type !== 'json' || files == null) return null
				return {
					version: 1,
					sourceId: 'source-1',
					repoId: 'repo-1',
					entityKind: 'package',
					entityId: 'package-1',
					publishedCommit: 'commit-1',
					manifestPath: 'package.json',
					sourceRoot: '/',
					files,
					createdAt: '2026-06-06T00:00:00.000Z',
				}
			},
		},
	} as unknown as Env
}

function createEnvWithRawSnapshot(snapshot: unknown) {
	return {
		BUNDLE_ARTIFACTS_KV: {
			async get(_key: string, type?: 'text' | 'json') {
				return type === 'json' ? snapshot : null
			},
		},
	} as unknown as Env
}

test('published commit HEAD mismatch messages are detected for caller-error classification', () => {
	const mismatch = buildSourceRecoveryProblemMessage({
		source: packageSource({
			published_commit: 'commit-published',
			repo_id: 'package-1',
		}),
		operation: 'repoOpenSession',
		reason:
			'artifact source repo "package-1" default branch HEAD "commit-unpublished" does not match published commit "commit-published"',
	})
	expect(isPublishedCommitHeadMismatchMessage(mismatch)).toBe(true)
	expect(
		isPublishedCommitHeadMismatchMessage(
			buildSourceRecoveryProblemMessage({
				source: packageSource(),
				operation: 'repoOpenSession',
				reason: 'artifact source repo "package-1" was not found',
			}),
		),
	).toBe(false)
	expect(buildPublishedCommitHeadMismatchCallerMessage(mismatch)).toContain(
		'packagePublishExternalPush',
	)
})

test('Artifacts repo-lookup timeouts are distinct from git HEAD read timeouts', async () => {
	const timeout = new Error('The operation timed out.')
	timeout.name = 'TimeoutError'
	artifactsMock.resolveExistingArtifactSourceRepo.mockReset()
	artifactsMock.resolveArtifactDefaultBranchHead.mockReset()
	artifactsMock.resolveExistingArtifactSourceRepo.mockRejectedValue(timeout)

	const lookupRejected = await assertPublishedPackageSourceRepoHead({
		env: {} as Env,
		source: packageSource(),
		operation: 'packageGetGitRemote',
	}).then(
		() => null,
		(error: unknown) => error,
	)
	expect(lookupRejected).toBeInstanceOf(Error)
	const lookupError = lookupRejected as Error
	expect(isArtifactsRepoLookupTimeoutMessage(lookupError.message)).toBe(true)
	expect(lookupError.message).not.toContain('git remote')
	expect(lookupError.message).not.toContain('packageSave')
	expect(lookupError.cause).toBe(timeout)

	artifactsMock.resolveExistingArtifactSourceRepo.mockResolvedValue({
		info: vi.fn(),
		createToken: vi.fn(),
	})
	artifactsMock.resolveArtifactDefaultBranchHead.mockRejectedValue(timeout)
	const gitRejected = await assertPublishedPackageSourceRepoHead({
		env: {} as Env,
		source: packageSource(),
		operation: 'packageGetGitRemote',
	}).then(
		() => null,
		(error: unknown) => error,
	)
	expect(gitRejected).toBeInstanceOf(Error)
	const gitError = gitRejected as Error
	expect(isArtifactsGitReadTimeoutMessage(gitError.message)).toBe(true)
	expect(gitError.message).toContain('packageSave')
	expect(isArtifactsRepoLookupTimeoutMessage(gitError.message)).toBe(false)
	expect(gitError.cause).toBe(timeout)
})

test('opaque Cloudflare Artifacts internals become retry messages, not source-recovery wraps', async () => {
	const opaque = new Error(cloudflareOpaqueInternalErrorMessage)
	artifactsMock.resolveExistingArtifactSourceRepo.mockReset()
	artifactsMock.resolveArtifactDefaultBranchHead.mockReset()
	artifactsMock.resolveExistingArtifactSourceRepo.mockResolvedValue({
		info: vi.fn(),
		createToken: vi.fn(),
	})
	artifactsMock.resolveArtifactDefaultBranchHead.mockRejectedValue(opaque)

	const rejected = await assertPublishedPackageSourceRepoHead({
		env: {} as Env,
		source: packageSource({
			id: '3b0c33c6-20b2-447f-98b1-fd165f8fabfe',
			published_commit: '90b7cf67f0d3e29ea49eeccbf0710915cb6f9527',
		}),
		operation: 'packageGetGitRemote',
	}).then(
		() => null,
		(error: unknown) => error,
	)
	expect(rejected).toBeInstanceOf(Error)
	const error = rejected as Error
	expect(isArtifactsOpaqueInternalRetryMessage(error.message)).toBe(true)
	expect(error.message).toContain('Retry the call.')
	expect(error.message).toContain(cloudflareOpaqueInternalErrorMessage)
	expect(error.message).not.toContain(
		'stopped by the production package source safety policy',
	)
	expect(error.cause).toBe(opaque)

	const nativeArtifactsError = {
		name: 'ArtifactsError',
		code: 'INTERNAL_ERROR',
		message: 'An unexpected internal error occurred.',
	}
	artifactsMock.resolveExistingArtifactSourceRepo.mockRejectedValue(
		nativeArtifactsError,
	)
	const nativeRejected = await assertPublishedPackageSourceRepoHead({
		env: {} as Env,
		source: packageSource(),
		operation: 'packageGetGitRemote',
	}).then(
		() => null,
		(error: unknown) => error,
	)
	expect(nativeRejected).toBeInstanceOf(Error)
	const nativeError = nativeRejected as Error
	expect(isArtifactsOpaqueInternalRetryMessage(nativeError.message)).toBe(true)
	expect(nativeError.message).toContain(
		'An unexpected internal error occurred.',
	)
	expect(nativeError.message).not.toContain(
		'stopped by the production package source safety policy',
	)
	expect(nativeError.cause).toBe(nativeArtifactsError)

	const wrap = buildSourceRecoveryProblemMessage({
		source: packageSource(),
		operation: 'packageGetGitRemote',
		reason: cloudflareOpaqueInternalErrorMessage,
	})
	expect(isSourceRecoveryOpaqueInternalErrorMessage(wrap)).toBe(true)
	expect(
		isSourceRecoveryOpaqueInternalErrorMessage(
			buildSourceRecoveryProblemMessage({
				source: packageSource(),
				operation: 'packageGetGitRemote',
				reason: 'no published source snapshot was found',
			}),
		),
	).toBe(false)
})

test('package source overwrite and private-visibility changes require explicit confirmation', async () => {
	const overwriteMessage = await assertPackageSourceOverwriteAllowed({
		env: createEnvWithSnapshot({ 'package.json': '{}' }),
		userId: ownerIdFromStored('user-1'),
		source: packageSource(),
		operation: 'packageSave',
	}).then(
		() => '',
		(error: Error) => error.message,
	)
	expect(overwriteMessage).toContain(destructiveOverwriteConfirmationField)
	expect(isDestructiveOverwriteConfirmationMessage(overwriteMessage)).toBe(true)
	expect(
		isDestructiveOverwriteConfirmationMessage(
			'packageSave stopped by the production package source safety policy.',
		),
	).toBe(false)

	let visibilityMessage = ''
	try {
		assertPackagePrivateVisibilityChangeAllowed({
			beforeContent: '{"name":"@x/y","private":true}',
			afterContent: '{"name":"@x/y","private":false}',
			isNewPackage: false,
			operation: 'packageSave',
		})
	} catch (error) {
		visibilityMessage = (error as Error).message
	}
	expect(visibilityMessage).toContain(privateVisibilityChangeConfirmationField)
	expect(isPrivateVisibilityChangeConfirmationMessage(visibilityMessage)).toBe(
		true,
	)
	expect(
		isPrivateVisibilityChangeConfirmationMessage(
			'packageSave would overwrite existing package source "source-1".',
		),
	).toBe(false)

	expect(() =>
		assertPackagePrivateVisibilityChangeAllowed({
			beforeContent: '{"name":"@x/y","private":true}',
			afterContent: '{"name":"@x/y"}',
			isNewPackage: false,
			operation: 'packageSave',
		}),
	).not.toThrow()
})

test('restorable package source snapshot verification rejects corrupt snapshots and accepts manifest-bearing backups', async () => {
	const assertRestorable = (env: Env, operation: string) =>
		assertRestorablePackageSourceSnapshot({
			env,
			userId: ownerIdFromStored('user-1'),
			source: packageSource(),
			operation,
		})
	const forcePublish = 'packagePublishExternalPush force publish'
	const rejected: Array<[Env, string]> = [
		[
			createEnvWithSnapshot(null),
			'Stop and report this source recovery problem',
		],
		[
			createEnvWithSnapshot({ 'src/index.ts': 'export {}' }),
			'missing manifest "package.json"',
		],
		[
			createEnvWithRawSnapshot({
				version: 1,
				sourceId: 'source-1',
				publishedCommit: 'commit-1',
				files: null,
			}),
			'the published source snapshot is missing or malformed',
		],
	]
	for (const [env, message] of rejected) {
		await expect(assertRestorable(env, forcePublish)).rejects.toThrow(message)
	}

	await expect(
		assertRestorable(
			createEnvWithSnapshot({
				'package.json': '{"name":"@user/demo"}',
				'src/index.ts': 'export {}',
			}),
			'packageGetGitRemote write access',
		),
	).resolves.toEqual({
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
		fileCount: 2,
	})
})
