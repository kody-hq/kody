import { routes } from '#universal/routes.ts'
import { getSavedPackageById } from './repo.ts'
import { type SavedPackageRecord } from './types.ts'

/**
 * Full SHA-1 object id. Artifacts git and isomorphic-git resolve only a
 * 40-hex oid (`GitRefManager.resolve` returns length-40 hex as an object id
 * and looks up every other value as a ref, including `origin/<value>`).
 * SHA-256 object ids (64 hex) are not a supported repo format here.
 */
const gitCommitShaPattern = /^[0-9a-f]{40}$/i

export const fullGitCommitShaRequiredMessage =
	'Use the full commit SHA (40 characters)'

export class PackagePublishLockedError extends Error {
	readonly packageId: string
	readonly packageName: string
	readonly pendingCommit: string
	readonly currentPublishedCommit: string | null

	constructor(input: {
		packageId: string
		packageName: string
		pendingCommit: string
		currentPublishedCommit: string | null
	}) {
		super(`Package "${input.packageName}" is locked and requires approval.`)
		this.name = 'PackagePublishLockedError'
		this.packageId = input.packageId
		this.packageName = input.packageName
		this.pendingCommit = input.pendingCommit
		this.currentPublishedCommit = input.currentPublishedCommit
	}
}

export function isPackagePublishLockedError(
	error: unknown,
): error is PackagePublishLockedError {
	return error instanceof PackagePublishLockedError
}

export function isSavedPackageLocked(
	lockedAt: string | null | undefined,
): boolean {
	return typeof lockedAt === 'string' && lockedAt.trim().length > 0
}

export function isGitCommitSha(value: string): boolean {
	return gitCommitShaPattern.test(value.trim())
}

export function buildPackagePublishApprovalPath(input: {
	username: string
	kodyId: string
	commit: string
}): string {
	const url = new URL(
		routes.communityPackageApprovePublish.href({
			username: input.username,
			kodyId: input.kodyId,
		}),
		'https://kody.invalid',
	)
	url.searchParams.set('commit', input.commit)
	return `${url.pathname}${url.search}`
}

export function buildPackagePublishApprovalUrl(input: {
	baseUrl: string
	username: string
	kodyId: string
	commit: string
}): string {
	const url = new URL(
		buildPackagePublishApprovalPath({
			username: input.username,
			kodyId: input.kodyId,
			commit: input.commit,
		}),
		input.baseUrl,
	)
	return url.toString()
}

export function buildPackageUnlockPath(input: {
	username: string
	kodyId: string
}): string {
	return routes.communityPackageSettings.href(input)
}

export function buildPackageUnlockUrl(input: {
	baseUrl: string
	username: string
	kodyId: string
}): string {
	return new URL(
		buildPackageUnlockPath({
			username: input.username,
			kodyId: input.kodyId,
		}),
		input.baseUrl,
	).toString()
}

export function createPackageUnlockRequiredMessage(unlockUrl: string): string {
	return `Agents cannot unlock packages. Send the owner to ${unlockUrl} to unlock publishes.`
}

export function createPackagePublishLockedMessage(input: {
	packageName: string
	approvalUrl: string
}): string {
	return `Package "${input.packageName}" is locked. Publishes require approval at ${input.approvalUrl}.`
}

export function createPackagePublishLockedError(input: {
	savedPackage: Pick<SavedPackageRecord, 'id' | 'name' | 'lockedAt'>
	pendingCommit: string
	currentPublishedCommit: string | null
}): PackagePublishLockedError {
	return new PackagePublishLockedError({
		packageId: input.savedPackage.id,
		packageName: input.savedPackage.name,
		pendingCommit: input.pendingCommit,
		currentPublishedCommit: input.currentPublishedCommit,
	})
}

export async function loadLockedSavedPackage(input: {
	db: D1Database
	userId: string
	packageId: string
}): Promise<SavedPackageRecord | null> {
	const savedPackage = await getSavedPackageById(input.db, {
		userId: input.userId,
		packageId: input.packageId,
	})
	if (!savedPackage || !isSavedPackageLocked(savedPackage.lockedAt)) {
		return null
	}
	return savedPackage
}
