import { runQueueableDynamicWorkerWork } from '#worker/dynamic-worker-evaluation-budget.ts'
import { listAdminStableUserIds } from '#worker/identity/permissions-db.ts'
import { listPackageSubscriptions } from '#worker/package-registry/manifest.ts'
import {
	listSavedPackagesByIds,
	listSavedPackagesByUserId,
} from '#worker/package-registry/repo.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	readPreExecutionPackageInvocationInfrastructureCode,
	readRetryablePackageInvocationInfrastructureCode,
} from './infrastructure-codes.ts'
import {
	type LoadedManifestForSavedPackage,
	loadManifestsForSavedPackages,
	mapSettledInChunks,
} from './saved-package-manifest-discovery.ts'
import { invokePackageSubscription } from './service.ts'
import {
	fillPackageSubscriptionTopicMapFromWakeScan,
	readPackageSubscriptionTopicGeneration,
	tryReadPackageSubscriptionTopicMap,
} from './subscription-topic-cache.ts'

export {
	readPreExecutionPackageInvocationInfrastructureCode,
	readRetryablePackageInvocationInfrastructureCode,
	mapSettledInChunks,
}

export type LoadedPackageSubscription = {
	savedPackage: SavedPackageRecord
	subscription: ReturnType<typeof listPackageSubscriptions>[number]
}

function isMissingSavedPackagesTableError(error: unknown) {
	return (
		error instanceof Error &&
		error.message.toLowerCase().includes('no such table: saved_packages')
	)
}

function collectLoadedPackageSubscriptions(input: {
	topic: string
	savedPackages: ReadonlyArray<SavedPackageRecord>
	settled: ReadonlyArray<PromiseSettledResult<LoadedManifestForSavedPackage>>
	onFulfilled?: (loaded: LoadedManifestForSavedPackage) => void
}): {
	subscriptions: Array<LoadedPackageSubscription>
	discoveryErrors: Array<unknown>
} {
	const subscriptions: Array<LoadedPackageSubscription> = []
	const discoveryErrors: Array<unknown> = []
	for (const [index, result] of input.settled.entries()) {
		if (result.status === 'fulfilled') {
			input.onFulfilled?.(result.value)
			const subscription = listPackageSubscriptions(result.value.manifest).find(
				(candidate) => candidate.topic === input.topic,
			)
			if (subscription) {
				subscriptions.push({
					savedPackage: result.value.savedPackage,
					subscription,
				})
			}
			continue
		}
		const savedPackage = input.savedPackages[index]
		console.warn('admin-package-subscription-manifest-load-failed', {
			topic: input.topic,
			packageId: savedPackage?.id,
			sourceId: savedPackage?.sourceId,
			error: result.reason,
		})
		discoveryErrors.push(result.reason)
	}
	return { subscriptions, discoveryErrors }
}

/**
 * One user's saved packages that declare `topic`. Prefer the per-user KV
 * topic→package map (one get on hit); on miss, scan manifests once, fill KV,
 * then load only candidate packages. Missing `saved_packages` resolves empty;
 * per-package manifest load failures are collected, not thrown.
 */
export async function loadMatchingPackageSubscriptions(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>
	baseUrl: string
	userId: string
	topic: string
}) {
	const cached = await tryReadPackageSubscriptionTopicMap({
		env: input.env,
		userId: input.userId,
	}).catch(() => null)

	if (cached) {
		const packageIds = cached.byTopic[input.topic] ?? []
		if (packageIds.length === 0) {
			return { subscriptions: [], discoveryErrors: [] }
		}
		let savedPackages: Array<SavedPackageRecord>
		try {
			savedPackages = await listSavedPackagesByIds(input.env.APP_DB, {
				userId: input.userId,
				packageIds,
			})
		} catch (error) {
			if (isMissingSavedPackagesTableError(error)) {
				return { subscriptions: [], discoveryErrors: [] }
			}
			throw error
		}
		return await loadSubscriptionsForSavedPackages({
			...input,
			savedPackages,
		})
	}

	// Miss or no usable KV: scan every package once. When KV is available,
	// fill the map from that same scan so a second wake does not rescan.
	let savedPackages: Array<SavedPackageRecord>
	try {
		savedPackages = await listSavedPackagesByUserId(input.env.APP_DB, {
			userId: input.userId,
		})
	} catch (error) {
		if (isMissingSavedPackagesTableError(error)) {
			return { subscriptions: [], discoveryErrors: [] }
		}
		throw error
	}
	if (savedPackages.length === 0) {
		try {
			const generation = await readPackageSubscriptionTopicGeneration({
				env: input.env,
				userId: input.userId,
			})
			await fillPackageSubscriptionTopicMapFromWakeScan({
				env: input.env,
				userId: input.userId,
				generation,
				byTopic: {},
				manifestLoadFailures: 0,
			})
		} catch (error) {
			console.warn('package-subscription-topic-map-fill-failed', {
				userId: input.userId,
				error,
			})
		}
		return { subscriptions: [], discoveryErrors: [] }
	}

	const byTopic = new Map<string, Set<string>>()
	const generation = await readPackageSubscriptionTopicGeneration({
		env: input.env,
		userId: input.userId,
	}).catch(() => 0)
	const settled = await loadManifestsForSavedPackages({
		env: input.env,
		userId: input.userId,
		savedPackages,
	})
	const { subscriptions, discoveryErrors } = collectLoadedPackageSubscriptions({
		topic: input.topic,
		savedPackages,
		settled,
		onFulfilled: (loaded) => {
			for (const subscription of listPackageSubscriptions(loaded.manifest)) {
				const packageIds = byTopic.get(subscription.topic) ?? new Set<string>()
				packageIds.add(loaded.savedPackage.id)
				byTopic.set(subscription.topic, packageIds)
			}
		},
	})

	// Incomplete scans must not be cached: a temporary manifest failure would
	// drop that package from every later wake until the next publish.
	if (discoveryErrors.length === 0) {
		try {
			const serialized: Record<string, Array<string>> = {}
			for (const topic of [...byTopic.keys()].sort((left, right) =>
				left.localeCompare(right),
			)) {
				serialized[topic] = [...(byTopic.get(topic) ?? [])].sort(
					(left, right) => left.localeCompare(right),
				)
			}
			await fillPackageSubscriptionTopicMapFromWakeScan({
				env: input.env,
				userId: input.userId,
				generation,
				byTopic: serialized,
				manifestLoadFailures: 0,
			})
		} catch (error) {
			console.warn('package-subscription-topic-map-fill-failed', {
				userId: input.userId,
				error,
			})
		}
	}

	return { subscriptions, discoveryErrors }
}

async function loadSubscriptionsForSavedPackages(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>
	baseUrl: string
	userId: string
	topic: string
	savedPackages: Array<SavedPackageRecord>
}) {
	if (input.savedPackages.length === 0) {
		return { subscriptions: [], discoveryErrors: [] }
	}
	const settled = await loadManifestsForSavedPackages({
		env: input.env,
		userId: input.userId,
		savedPackages: input.savedPackages,
	})
	return collectLoadedPackageSubscriptions({
		topic: input.topic,
		savedPackages: input.savedPackages,
		settled,
	})
}

/**
 * Fans an event out only to packages whose owners hold the admin role at
 * dispatch time. Failures warn and skip by default; opt-in retry flags reject
 * after all successfully discovered sibling attempts finish.
 */
export async function dispatchAdminPackageSubscriptionEvent(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>
	baseUrl: string
	topic: string
	getParams: () => Record<string, unknown> | Promise<Record<string, unknown>>
	source: string
	buildIdempotencyKey: (savedPackage: SavedPackageRecord) => string
	actorTokenId?: string
	retryDiscoveryFailures?: boolean
	retryInvocationInfrastructureFailures?: boolean
	retryOnlyPreExecutionInfrastructureFailures?: boolean
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const adminUserIds = await listAdminStableUserIds(input.env.APP_DB)
	if (adminUserIds.length === 0) {
		return []
	}
	const discovered = await mapSettledInChunks(
		adminUserIds,
		async (userId) =>
			await loadMatchingPackageSubscriptions({
				env: input.env,
				baseUrl: input.baseUrl,
				userId,
				topic: input.topic,
			}),
	)
	const subscriptions: Array<LoadedPackageSubscription> = []
	const discoveryErrors: Array<unknown> = []
	for (const [index, result] of discovered.entries()) {
		if (result.status === 'fulfilled') {
			subscriptions.push(...result.value.subscriptions)
			discoveryErrors.push(...result.value.discoveryErrors)
			continue
		}
		console.warn('admin-package-subscription-discovery-failed', {
			topic: input.topic,
			userId: adminUserIds[index],
			error: result.reason,
		})
		discoveryErrors.push(result.reason)
	}
	if (subscriptions.length === 0) {
		if (input.retryDiscoveryFailures && discoveryErrors.length > 0) {
			throw new Error('Admin package subscription discovery failed.', {
				cause: discoveryErrors[0],
			})
		}
		return []
	}
	const params = await input.getParams()
	const invoked = await runQueueableDynamicWorkerWork(
		async () =>
			await mapSettledInChunks(subscriptions, async ({ savedPackage }) => {
				const response = await invokePackageSubscription({
					env: input.env as Env,
					baseUrl: input.baseUrl,
					savedPackage,
					topic: input.topic,
					params,
					idempotencyKey: input.buildIdempotencyKey(savedPackage),
					source: input.source,
					actorTokenId: input.actorTokenId,
					request: { kind: 'platform-event', sourceId: input.source },
					waitUntil: input.waitUntil,
				})
				if (response.status < 200 || response.status >= 400) {
					console.warn('admin-package-subscription-handler-failed', {
						topic: input.topic,
						packageId: savedPackage.id,
						status: response.status,
					})
				}
				return {
					response,
					retryableInfrastructureCode:
						input.retryInvocationInfrastructureFailures
							? input.retryOnlyPreExecutionInfrastructureFailures
								? readPreExecutionPackageInvocationInfrastructureCode(response)
								: readRetryablePackageInvocationInfrastructureCode(response)
							: null,
				}
			}),
	)
	const invocationInfrastructureErrors: Array<unknown> = []
	const responses = invoked.map((result, index) => {
		if (result.status === 'fulfilled') {
			if (result.value.retryableInfrastructureCode) {
				invocationInfrastructureErrors.push(
					new Error(
						`Retryable package invocation infrastructure response: ${result.value.retryableInfrastructureCode}.`,
					),
				)
			}
			return result.value.response
		}
		console.warn('admin-package-subscription-invocation-failed', {
			topic: input.topic,
			packageId: subscriptions[index]?.savedPackage.id,
			error: result.reason,
		})
		if (input.retryInvocationInfrastructureFailures) {
			invocationInfrastructureErrors.push(result.reason)
		}
		return null
	})
	if (input.retryDiscoveryFailures && discoveryErrors.length > 0) {
		throw new Error('Admin package subscription discovery failed.', {
			cause: discoveryErrors[0],
		})
	}
	if (invocationInfrastructureErrors.length > 0) {
		throw new Error(
			'Admin package subscription dispatch encountered retryable package invocation infrastructure errors.',
			{ cause: invocationInfrastructureErrors[0] },
		)
	}
	return responses
}
