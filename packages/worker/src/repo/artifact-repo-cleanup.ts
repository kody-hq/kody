import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	getArtifactsBinding,
	hasArtifactsAccess,
	type ArtifactDeleteRepoResult,
} from './artifacts.ts'
import { deleteArtifactsRepoPushSubscription } from './artifacts-push-subscriptions.ts'
import {
	deleteArtifactsPushSubscriptionBySourceId,
	getArtifactsPushSubscriptionBySourceId,
} from './artifacts-push-subscription-store.ts'
import {
	getEntitySourceByIdForUser,
	listEntitySourcesByUser,
} from './entity-sources.ts'
import {
	listRepoSessionsBySource,
	listRepoSessionsByUser,
} from './repo-sessions.ts'
import type { EntitySourceRow } from './types.ts'

function logArtifactRepoDeleted(input: {
	userId: OwnerId
	repoName: string
	result: ArtifactDeleteRepoResult
}) {
	console.info(
		JSON.stringify({
			message: input.result.alreadyDeleted
				? 'artifact repo already absent during cleanup'
				: 'artifact repo deleted',
			userId: input.userId,
			repoName: input.repoName,
			repoId: input.result.id,
		}),
	)
}

export async function deleteUserScopedArtifactRepo(input: {
	env: Env
	userId: OwnerId
	repoName: string
	warnings?: Array<string>
	/**
	 * Cloudflare Artifacts REST delete can return before `get` observes
	 * `not_found`. Community fork fallback needs the dest gone before
	 * `ensureEntitySource` recreates an empty repo with bootstrapAccess.
	 */
	waitUntilAbsent?: boolean
	waitUntilAbsentAttempts?: number
	waitUntilAbsentDelayMs?: number
}): Promise<boolean> {
	const repoName = input.repoName.trim()
	if (!repoName) return false
	if (!hasArtifactsAccess(input.env)) {
		return false
	}
	try {
		const binding = getArtifactsBinding(input.env)
		const result = await binding.delete(repoName)
		logArtifactRepoDeleted({
			userId: input.userId,
			repoName,
			result,
		})
		if (input.waitUntilAbsent) {
			const maxAttempts = input.waitUntilAbsentAttempts ?? 10
			const delayMs = input.waitUntilAbsentDelayMs ?? 50
			for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
				const observed = await binding.get(repoName)
				if (observed.status === 'not_found') break
				if (attempt === maxAttempts) {
					const message = `Artifact repo "${repoName}" still present after delete (${observed.status}).`
					input.warnings?.push(message)
					console.warn(
						JSON.stringify({
							message: 'artifact repo delete not yet absent',
							userId: input.userId,
							repoName,
							status: observed.status,
						}),
					)
					return false
				}
				await new Promise((resolve) => setTimeout(resolve, delayMs))
			}
		}
		return true
	} catch (error) {
		const message = getErrorMessage(error)
		input.warnings?.push(
			`Artifact repo delete failed for ${repoName}: ${message}`,
		)
		console.warn(
			JSON.stringify({
				message: 'artifact repo delete failed',
				userId: input.userId,
				repoName,
				error: message,
			}),
		)
		return false
	}
}

function collectUniqueRepoNames(
	repoNames: ReadonlyArray<string | null | undefined>,
) {
	const unique = new Set<string>()
	for (const repoName of repoNames) {
		const trimmed = repoName?.trim()
		if (trimmed) unique.add(trimmed)
	}
	return Array.from(unique)
}

async function deletePushSubscriptionForSource(input: {
	env: Env
	userId: OwnerId
	source: EntitySourceRow
	warnings?: Array<string>
}) {
	const stored = await getArtifactsPushSubscriptionBySourceId(
		input.env.APP_DB,
		input.source.id,
	)
	if (!stored?.subscription_id) return
	try {
		await deleteArtifactsRepoPushSubscription({
			env: input.env,
			subscriptionId: stored.subscription_id,
			repoName: input.source.repo_id,
		})
	} catch (error) {
		const message = getErrorMessage(error)
		input.warnings?.push(
			`Artifacts push event subscription delete failed for ${input.source.repo_id}: ${message}`,
		)
		console.warn(
			JSON.stringify({
				message: 'artifacts push event subscription delete failed',
				userId: input.userId,
				repoName: input.source.repo_id,
				subscriptionId: stored.subscription_id,
				error: message,
			}),
		)
	}
	await deleteArtifactsPushSubscriptionBySourceId(input.env.APP_DB, {
		sourceId: input.source.id,
		userId: input.userId,
	}).catch((error) => {
		console.warn(
			JSON.stringify({
				message: 'failed to clear artifacts push subscription row',
				userId: input.userId,
				sourceId: input.source.id,
				error: getErrorMessage(error),
			}),
		)
	})
}

async function deleteReposForEntitySource(input: {
	env: Env
	userId: OwnerId
	source: EntitySourceRow
	warnings?: Array<string>
}) {
	if (input.source.user_id !== input.userId) {
		input.warnings?.push(
			`Skipped artifact repo cleanup for source ${input.source.id}: user scope mismatch.`,
		)
		return 0
	}
	await deletePushSubscriptionForSource({
		env: input.env,
		userId: input.userId,
		source: input.source,
		warnings: input.warnings,
	})
	const sessions = await listRepoSessionsBySource(input.env, {
		userId: input.userId,
		sourceId: input.source.id,
	})
	const repoNames = collectUniqueRepoNames([
		input.source.repo_id,
		...sessions.map((session) => session.source_repo_id),
	])
	let deleted = 0
	for (const repoName of repoNames) {
		if (
			await deleteUserScopedArtifactRepo({
				env: input.env,
				userId: input.userId,
				repoName,
				warnings: input.warnings,
			})
		) {
			deleted += 1
		}
	}
	return deleted
}

export async function cleanupArtifactReposForPackage(input: {
	env: Env
	userId: OwnerId
	sourceId: string
	warnings?: Array<string>
}) {
	const source = await getEntitySourceByIdForUser(input.env.APP_DB, {
		id: input.sourceId,
		userId: input.userId,
	})
	if (!source) return 0
	if (source.user_id !== input.userId) {
		input.warnings?.push(
			`Skipped artifact repo cleanup for package source ${input.sourceId}: user scope mismatch.`,
		)
		return 0
	}
	if (!hasArtifactsAccess(input.env)) {
		const sessions = await listRepoSessionsBySource(input.env, {
			userId: input.userId,
			sourceId: source.id,
		})
		const repoCount = collectUniqueRepoNames([
			source.repo_id,
			...sessions.map((session) => session.source_repo_id),
		]).length
		if (repoCount > 0) {
			input.warnings?.push(
				`Cloudflare Artifacts access was unavailable; ${repoCount} artifact repo(s) for the deleted package were not removed and must be cleaned up manually.`,
			)
		}
		return 0
	}
	return deleteReposForEntitySource({
		env: input.env,
		userId: input.userId,
		source,
		warnings: input.warnings,
	})
}

export async function cleanupArtifactReposForSource(input: {
	env: Env
	userId: OwnerId
	sourceId: string
	warnings?: Array<string>
}): Promise<{
	deleted: number
	artifactAccessUnavailable: boolean
}> {
	const source = await getEntitySourceByIdForUser(input.env.APP_DB, {
		id: input.sourceId,
		userId: input.userId,
	})
	if (!source) return { deleted: 0, artifactAccessUnavailable: false }
	if (source.user_id !== input.userId) {
		input.warnings?.push(
			`Skipped artifact repo cleanup for source ${input.sourceId}: user scope mismatch.`,
		)
		return { deleted: 0, artifactAccessUnavailable: false }
	}
	if (!hasArtifactsAccess(input.env)) {
		const sessions = await listRepoSessionsBySource(input.env, {
			userId: input.userId,
			sourceId: source.id,
		})
		const repoCount = collectUniqueRepoNames([
			source.repo_id,
			...sessions.map((session) => session.source_repo_id),
		]).length
		if (repoCount > 0) {
			input.warnings?.push(
				`Cloudflare Artifacts access was unavailable; ${repoCount} artifact repo(s) for source ${source.id} were not removed and must be cleaned up manually.`,
			)
		}
		return { deleted: 0, artifactAccessUnavailable: true }
	}
	return {
		deleted: await deleteReposForEntitySource({
			env: input.env,
			userId: input.userId,
			source,
			warnings: input.warnings,
		}),
		artifactAccessUnavailable: false,
	}
}

export async function cleanupAllUserArtifactRepos(input: {
	env: Env
	userId: OwnerId
	warnings: Array<string>
}) {
	if (!hasArtifactsAccess(input.env)) {
		if ((await countUserArtifactRepoReferences(input.env, input.userId)) > 0) {
			input.warnings.push(
				'Cloudflare Artifacts access was unavailable; artifact repos referenced by the deleted user were not removed and must be cleaned up manually.',
			)
		}
		return 0
	}

	const [sources, sessions] = await Promise.all([
		listEntitySourcesByUser(input.env.APP_DB, input.userId),
		listRepoSessionsByUser(input.env, input.userId),
	])
	for (const source of sources) {
		await deletePushSubscriptionForSource({
			env: input.env,
			userId: input.userId,
			source,
			warnings: input.warnings,
		})
	}
	const repoNames = collectUniqueRepoNames([
		...sources.map((source) => source.repo_id),
		...sessions.map((session) => session.source_repo_id),
	])
	let deleted = 0
	for (const repoName of repoNames) {
		if (
			await deleteUserScopedArtifactRepo({
				env: input.env,
				userId: input.userId,
				repoName,
				warnings: input.warnings,
			})
		) {
			deleted += 1
		}
	}
	return deleted
}

async function countUserArtifactRepoReferences(env: Env, userId: OwnerId) {
	const [sources, sessions] = await Promise.all([
		listEntitySourcesByUser(env.APP_DB, userId),
		listRepoSessionsByUser(env, userId),
	])
	return collectUniqueRepoNames([
		...sources.map((source) => source.repo_id),
		...sessions.map((session) => session.source_repo_id),
	]).length
}
