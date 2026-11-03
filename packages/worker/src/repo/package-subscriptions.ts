import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { runQueueableDynamicWorkerWork } from '#worker/dynamic-worker-evaluation-budget.ts'
import {
	loadMatchingPackageSubscriptions,
	readPreExecutionPackageInvocationInfrastructureCode,
} from '#worker/package-invocations/admin-package-subscriptions.ts'
import { invokePackageSubscription } from '#worker/package-invocations/service.ts'
import { recordFollowDefaultBranchPush } from '#worker/follow/push-ingress.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import {
	applyArtifactSourcePushToHeadCache,
	isDeletedArtifactRefCommit,
	readCachedArtifactSourceBranch,
} from './artifact-head-cache.ts'
import { refreshIdentityIconForSource } from './identity-icon.ts'
import {
	getArtifactsNamespace,
	resolveArtifactSourceHead,
} from './artifacts.ts'
import {
	type CloudflareArtifactsRepoEvent,
	type RepoSubscriptionTopic,
	isKodyPublishedBranchRef,
	isPublishGitNotesRef,
	isSessionArtifactRepoName,
	isSessionBranchRef,
	parseCloudflareArtifactsRepoEvent,
	repoCreatedTopic,
	repoDeletedTopic,
	repoPushedTopic,
	topicForArtifactsRepoEvent,
} from './artifacts-events.ts'
import { getEntitySourceByRepoId } from './entity-sources.ts'
import type { EntitySourceRow } from './types.ts'
import { getUserRepoById } from './user-repos.ts'

export type RepoSubscriptionEntity = {
	source_id: string
	repo_id: string
	entity_kind: EntitySourceRow['entity_kind']
	entity_id: string
	name: string | null
	kody_id: string | null
}

export type RepoPushedSubscriptionEnvelope = {
	event: typeof repoPushedTopic
	repo: RepoSubscriptionEntity
	push: {
		ref: string
		before: string
		after: string
		total_commits_count: number
		commits_truncated: boolean
		commits: Array<{
			id: string
			message: string
			message_truncated: boolean
			timestamp: string
			author: { name: string; email: string }
			committer: { name: string; email: string }
			parents: Array<string>
		}>
	}
	artifacts: {
		namespace: string
		event_timestamp: string
		event_subscription_id: string
	}
}

export type RepoLifecycleSubscriptionEnvelope = {
	event: typeof repoCreatedTopic | typeof repoDeletedTopic
	repo: RepoSubscriptionEntity
	artifacts: {
		namespace: string
		event_timestamp: string
		event_subscription_id: string
		default_branch: string
		description: string | null
		cloudflare_repo_id: string
	}
}

async function resolveRepoSubscriptionEntity(input: {
	env: Pick<Env, 'APP_DB'>
	source: EntitySourceRow
}): Promise<RepoSubscriptionEntity> {
	let name: string | null = null
	let kodyId: string | null = null
	switch (input.source.entity_kind) {
		case 'repo': {
			const userRepo = await getUserRepoById(input.env.APP_DB, {
				userId: input.source.user_id,
				repoId: input.source.entity_id,
			})
			name = userRepo?.name ?? null
			break
		}
		case 'package': {
			const savedPackage = await getSavedPackageById(input.env.APP_DB, {
				userId: input.source.user_id,
				packageId: input.source.entity_id,
			})
			name = savedPackage?.name ?? null
			kodyId = savedPackage?.kodyId ?? null
			break
		}
		default: {
			const exhaustive: never = input.source.entity_kind
			throw new Error(`Unsupported entity kind: ${exhaustive}`)
		}
	}
	return {
		source_id: input.source.id,
		repo_id: input.source.repo_id,
		entity_kind: input.source.entity_kind,
		entity_id: input.source.entity_id,
		name,
		kody_id: kodyId,
	}
}

function buildRepoPushedPayload(input: {
	repo: RepoSubscriptionEntity
	event: Extract<
		CloudflareArtifactsRepoEvent,
		{ type: 'cf.artifacts.repo.pushed' }
	>
}): RepoPushedSubscriptionEnvelope {
	return {
		event: repoPushedTopic,
		repo: input.repo,
		push: {
			ref: input.event.payload.ref,
			before: input.event.payload.before,
			after: input.event.payload.after,
			total_commits_count: input.event.payload.totalCommitsCount,
			commits_truncated: input.event.payload.commitsTruncated,
			commits: input.event.payload.commits.map((commit) => ({
				id: commit.id,
				message: commit.message,
				message_truncated: commit.messageTruncated,
				timestamp: commit.timestamp,
				author: commit.author,
				committer: commit.committer,
				parents: commit.parents,
			})),
		},
		artifacts: {
			namespace: input.event.source.namespace,
			event_timestamp: input.event.metadata.eventTimestamp,
			event_subscription_id: input.event.metadata.eventSubscriptionId,
		},
	}
}

function buildRepoLifecyclePayload(input: {
	topic: typeof repoCreatedTopic | typeof repoDeletedTopic
	repo: RepoSubscriptionEntity
	event: Extract<
		CloudflareArtifactsRepoEvent,
		{ type: 'cf.artifacts.repo.created' | 'cf.artifacts.repo.deleted' }
	>
}): RepoLifecycleSubscriptionEnvelope {
	return {
		event: input.topic,
		repo: input.repo,
		artifacts: {
			namespace: input.event.source.namespace,
			event_timestamp: input.event.metadata.eventTimestamp,
			event_subscription_id: input.event.metadata.eventSubscriptionId,
			default_branch: input.event.payload.defaultBranch,
			description: input.event.payload.description ?? null,
			cloudflare_repo_id: input.event.payload.repoId,
		},
	}
}

function buildSubscriptionIdempotencyKey(input: {
	topic: RepoSubscriptionTopic
	repoId: string
	packageId: string
	event: CloudflareArtifactsRepoEvent
}) {
	switch (input.topic) {
		case repoPushedTopic: {
			if (input.event.type !== 'cf.artifacts.repo.pushed') {
				throw new Error('repo.pushed idempotency requires a pushed event')
			}
			// Omit source.type so account-level and leftover repo-scoped
			// publications of the same push collapse to one invocation.
			return `repo-push:${input.repoId}:${input.event.payload.after}:${input.event.payload.ref}:${input.packageId}`
		}
		case repoCreatedTopic:
		case repoDeletedTopic:
			return `repo-lifecycle:${input.topic}:${input.repoId}:${input.event.metadata.eventTimestamp}:${input.packageId}`
		default: {
			const exhaustive: never = input.topic
			throw new Error(`Unsupported repo subscription topic: ${exhaustive}`)
		}
	}
}

async function loadMatchingRepoSubscriptions(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>
	baseUrl: string
	userId: string
	topic: RepoSubscriptionTopic
}) {
	try {
		return await loadMatchingPackageSubscriptions(input)
	} catch (error) {
		return { subscriptions: [], discoveryErrors: [error] }
	}
}

function buildEventParams(input: {
	topic: RepoSubscriptionTopic
	repo: RepoSubscriptionEntity
	providerEvent: CloudflareArtifactsRepoEvent
}) {
	switch (input.topic) {
		case repoPushedTopic: {
			if (input.providerEvent.type !== 'cf.artifacts.repo.pushed') {
				throw new Error('repo.pushed payload requires a pushed event')
			}
			return buildRepoPushedPayload({
				repo: input.repo,
				event: input.providerEvent,
			})
		}
		case repoCreatedTopic:
		case repoDeletedTopic: {
			if (
				input.providerEvent.type !== 'cf.artifacts.repo.created' &&
				input.providerEvent.type !== 'cf.artifacts.repo.deleted'
			) {
				throw new Error('repo lifecycle payload requires a lifecycle event')
			}
			return buildRepoLifecyclePayload({
				topic: input.topic,
				repo: input.repo,
				event: input.providerEvent,
			})
		}
		default: {
			const exhaustive: never = input.topic
			throw new Error(`Unsupported repo subscription topic: ${exhaustive}`)
		}
	}
}

export async function dispatchRepoSubscriptionEvents(input: {
	env: Env
	providerEvent: CloudflareArtifactsRepoEvent
	source: EntitySourceRow
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const topic = topicForArtifactsRepoEvent(input.providerEvent)
	const baseUrl = getAppBaseUrl({ env: input.env })
	const repo = await resolveRepoSubscriptionEntity({
		env: input.env,
		source: input.source,
	})
	const eventPayload = buildEventParams({
		topic,
		repo,
		providerEvent: input.providerEvent,
	})

	const { subscriptions, discoveryErrors } =
		await loadMatchingRepoSubscriptions({
			env: input.env,
			baseUrl,
			userId: input.source.user_id,
			topic,
		})

	const settled = await runQueueableDynamicWorkerWork(
		async () =>
			await Promise.allSettled(
				subscriptions.map(async ({ savedPackage }) => {
					const response = await invokePackageSubscription({
						env: input.env,
						baseUrl,
						savedPackage,
						topic,
						params: eventPayload as unknown as Record<string, unknown>,
						idempotencyKey: buildSubscriptionIdempotencyKey({
							topic,
							repoId: input.source.repo_id,
							packageId: savedPackage.id,
							event: input.providerEvent,
						}),
						source: 'repo',
						request: { kind: 'platform-event', sourceId: 'repo' },
						waitUntil: input.waitUntil,
					})
					const retryableCode =
						readPreExecutionPackageInvocationInfrastructureCode(response)
					if (retryableCode) {
						throw new Error(
							`Retryable package invocation infrastructure response: ${retryableCode}.`,
						)
					}
					return response
				}),
			),
	)

	for (const result of settled) {
		if (result.status === 'rejected') {
			console.error('repo-subscription-invoke-failed', {
				topic,
				repoId: input.source.repo_id,
				error: result.reason,
			})
		}
	}
	if (discoveryErrors.length > 0) {
		throw new Error('Repo package subscription discovery was incomplete.', {
			cause: discoveryErrors[0],
		})
	}
	const invocationError = settled.find(
		(result): result is PromiseRejectedResult => result.status === 'rejected',
	)
	if (invocationError) {
		throw new Error('Repo package subscription dispatch was incomplete.', {
			cause: invocationError.reason,
		})
	}
	return settled.map((result) =>
		result.status === 'fulfilled' ? result.value : null,
	)
}

export type ProcessArtifactsRepoEventResult =
	| { outcome: 'invalid'; providerEvent: null }
	| { outcome: 'ignored'; providerEvent: CloudflareArtifactsRepoEvent }
	| {
			outcome: 'unmatched'
			providerEvent: CloudflareArtifactsRepoEvent
	  }
	| {
			outcome: 'dispatched'
			providerEvent: CloudflareArtifactsRepoEvent
			source: EntitySourceRow
	  }

export async function processCloudflareArtifactsRepoEvent(input: {
	env: Env
	body: unknown
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<ProcessArtifactsRepoEventResult> {
	const providerEvent = parseCloudflareArtifactsRepoEvent(input.body)
	if (!providerEvent) {
		return { outcome: 'invalid', providerEvent: null }
	}

	const expectedNamespace = getArtifactsNamespace(input.env)
	if (providerEvent.source.namespace !== expectedNamespace) {
		return { outcome: 'ignored', providerEvent }
	}
	if (isSessionArtifactRepoName(providerEvent.source.repoName)) {
		return { outcome: 'ignored', providerEvent }
	}
	if (
		providerEvent.type === 'cf.artifacts.repo.pushed' &&
		(isSessionBranchRef(providerEvent.payload.ref) ||
			isKodyPublishedBranchRef(providerEvent.payload.ref) ||
			isPublishGitNotesRef(providerEvent.payload.ref))
	) {
		return { outcome: 'ignored', providerEvent }
	}

	if (providerEvent.type === 'cf.artifacts.repo.pushed') {
		await applyArtifactSourcePushToHeadCache({
			env: input.env,
			repoId: providerEvent.source.repoName,
			ref: providerEvent.payload.ref,
			after: providerEvent.payload.after,
		})
	}

	const source = await getEntitySourceByRepoId(
		input.env.APP_DB,
		providerEvent.source.repoName,
	)
	if (!source) {
		return { outcome: 'unmatched', providerEvent }
	}

	if (providerEvent.type === 'cf.artifacts.repo.pushed') {
		const after = providerEvent.payload.after
		const deleted = isDeletedArtifactRefCommit(after)
		let defaultBranch: string | null = null
		let headCommit: string | null = null
		let headResolved = false
		try {
			// Live HEAD, not the KV cache: applyArtifactSourcePushToHeadCache
			// already wrote payload.after into that entry for viewed repos.
			const head = await resolveArtifactSourceHead(input.env, source.repo_id)
			headResolved = true
			const branch = head.branch.trim()
			defaultBranch = branch.length > 0 ? branch : null
			headCommit = head.commit
		} catch (error) {
			console.error('identity-icon-push-refresh-failed', source.repo_id, error)
			try {
				defaultBranch = await readCachedArtifactSourceBranch(
					input.env,
					source.repo_id,
				)
			} catch (fallbackError) {
				console.error(
					'follow-default-branch-lookup-failed',
					source.repo_id,
					fallbackError,
				)
			}
			if (!defaultBranch) {
				console.error(
					'follow-push-skipped-unknown-default-branch',
					source.repo_id,
				)
			}
		}
		const onDefaultBranch =
			defaultBranch !== null &&
			providerEvent.payload.ref === `refs/heads/${defaultBranch}` &&
			!deleted
		const onDefaultBranchTip =
			onDefaultBranch && headResolved && headCommit === after
		if (onDefaultBranchTip && source.entity_kind === 'repo') {
			try {
				await refreshIdentityIconForSource({
					env: input.env,
					source,
					iconCommit: after,
					indexLiveHead: true,
				})
			} catch (error) {
				console.error(
					'identity-icon-push-refresh-failed',
					source.repo_id,
					error,
				)
			}
		}
		// Every non-delete push of the default branch is recorded, including
		// a force-push or raced webhook whose `after` is no longer live HEAD.
		// Icon refresh stays tip-only and its failure does not skip recording.
		if (onDefaultBranch) {
			try {
				await recordFollowDefaultBranchPush({
					env: input.env,
					source,
					event: providerEvent,
				})
			} catch (error) {
				console.error('follow-push-ingress-failed', source.repo_id, error)
			}
		}
	}

	await dispatchRepoSubscriptionEvents({
		env: input.env,
		providerEvent,
		source,
		waitUntil: input.waitUntil,
	})
	return { outcome: 'dispatched', providerEvent, source }
}
