import { canonicalJsonStringify } from '@kody-internal/shared/canonical-json.ts'
import { listJsonSchemaSubsetValueErrors } from '@kody-internal/shared/json-schema-subset.ts'
import { toHex } from '@kody-internal/shared/hex.ts'
import { runQueueableDynamicWorkerWork } from '#worker/dynamic-worker-evaluation-budget.ts'
import { type createMcpCallerContext } from '#mcp/context.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	requestLineage,
	type EnablementRun,
	type RequestSource,
} from '#worker/request-context/request-context.ts'
import {
	planEnablementRuns,
	type EnablementAudience,
} from '#worker/enablements/run-gate.ts'
import { fanOutPackageEventToMcpSubscriptions } from '#mcp/events/fan-out.ts'
import {
	type PackageEventDispatchInput,
	type PackageEventTools,
} from '#mcp/run-kody-registry.ts'
import { type RunRecordContext } from '#worker/run-records/types.ts'
import { type EffectivePermissions } from '#worker/authorization/authorize.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { isInboundEmailApprovalTopic } from '#universal/credential-contracts.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { listPackageEmittedEvents } from '#worker/package-registry/manifest.ts'
import { type PackageEventsDispatchQueueMessage } from '#worker/package-events/dispatch-queue-producer.ts'
import {
	buildPackageSubscriptionArtifactName,
	normalizePackageSubscriptionTopic,
} from '#worker/package-runtime/subscription-artifacts.ts'
import {
	isTrustedSyntheticSubscriptionDispatch,
	stripUntrustedSubscriptionEnvelopeFields,
	type TrustedSyntheticSubscriptionDispatch,
} from './subscription-envelope.ts'
import { readPreExecutionPackageInvocationInfrastructureCode } from './infrastructure-codes.ts'
import {
	internalEmailSubscriptionTokenId,
	internalPackageEventSubscriptionTokenId,
	maxPackageRuntimeInvokeDepth,
	normalizeNullableString,
	syntheticPackageSubscriptionSource,
	type LoadedPackageEventSubscription,
	type PackageInvocationResponse,
	type PackageRuntimeContext,
	type PackageRuntimeToolFactories,
} from './common.ts'
import { invokeSavedPackageModule } from './idempotent-module-invocation.ts'
import { buildJsonErrorResponse } from './responses.ts'
import { loadMatchingPackageSubscriptions } from './admin-package-subscriptions.ts'

/**
 * Package event payloads ride inside a Queue message (128 KiB limit), so
 * the payload itself is capped well below that to leave envelope headroom.
 */
export const maxPackageEventPayloadBytes = 64 * 1024

function parsePackageEventDispatchInput(rawInput: PackageEventDispatchInput) {
	const input =
		rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
			? rawInput
			: {}
	const topic =
		typeof input.topic === 'string'
			? normalizePackageSubscriptionTopic(input.topic)
			: ''
	if (!topic) {
		throw new Error('events.dispatch requires a non-empty topic.')
	}
	const idempotencyKey =
		typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : ''
	if (!idempotencyKey) {
		throw new Error('events.dispatch requires a non-empty idempotencyKey.')
	}
	const rawPayload = input.payload ?? {}
	if (
		!rawPayload ||
		typeof rawPayload !== 'object' ||
		Array.isArray(rawPayload)
	) {
		throw new Error(
			'events.dispatch payload must be a JSON object when provided.',
		)
	}
	const payload = stripUntrustedSubscriptionEnvelopeFields(
		rawPayload as Record<string, unknown>,
	)
	return {
		topic,
		idempotencyKey,
		payload: payload as Record<string, unknown>,
	}
}

async function buildPackageEventSubscriptionIdempotencyKey(input: {
	sourcePackageId: string
	subscriberPackageId: string
	topic: string
	idempotencyKey: string
}) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(canonicalJsonStringify(input)),
	)
	return [
		'pkgevent',
		input.sourcePackageId,
		input.subscriberPackageId,
		input.topic,
		toHex(new Uint8Array(digest)).slice(0, 24),
	].join(':')
}

function readInvocationError(response: PackageInvocationResponse) {
	const errorRecord =
		(response.body['error'] as Record<string, unknown> | undefined) ?? {}
	return {
		code: String(errorRecord['code'] ?? 'package_subscription_failed'),
		message: String(
			errorRecord['message'] ??
				`Package subscription failed with HTTP ${response.status}.`,
		),
	}
}

/**
 * Filter semantics for package-emitted topics: every declared filter key
 * must be present in the event payload with a canonically-equal JSON value.
 * Subscriptions without filters receive every event on the topic.
 */
export function packageEventFiltersMatchPayload(input: {
	filters: Record<string, unknown> | null
	payload: Record<string, unknown>
}) {
	if (!input.filters) return true
	return Object.entries(input.filters).every(
		([key, expected]) =>
			key in input.payload &&
			canonicalJsonStringify(input.payload[key]) ===
				canonicalJsonStringify(expected),
	)
}

async function loadMatchingPackageEventSubscriptions(input: {
	env: Env
	baseUrl: string
	userId: string
	topic: string
	payload: Record<string, unknown>
}) {
	const { subscriptions, discoveryErrors } =
		await loadMatchingPackageSubscriptions({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			topic: input.topic,
		})
	if (discoveryErrors.length > 0) {
		throw new Error(
			`Failed to load package manifest for package event dispatch: ${String(discoveryErrors[0])}`,
			{ cause: discoveryErrors[0] },
		)
	}
	return subscriptions.filter(
		(entry): entry is LoadedPackageEventSubscription =>
			packageEventFiltersMatchPayload({
				filters: entry.subscription.filters,
				payload: input.payload,
			}),
	)
}

export type PackageEventDeliveryResult = {
	topic: string
	source: { type: 'package'; packageId: string; kodyId: string }
	idempotencyKey: string
	subscribers: Array<{
		packageId: string
		kodyId: string
		handler: string
		status: 'completed' | 'replayed' | 'failed'
		error?: { code: string; message: string }
	}>
	delivered: number
	failed: number
}

/**
 * Queue-consumer side of package event dispatch: resolve the emitting
 * user's matching subscriptions and invoke each handler with exactly-once
 * idempotency. Throws when subscriber discovery fails or an invocation
 * fails before user code ran (both retryable via Queue redelivery); user
 * handler failures are terminal and reported in the returned summary (the
 * idempotency ledger would replay a stored failure on retry anyway).
 */
export async function deliverPackageEventWithToolFactories(input: {
	env: Env
	baseUrl: string
	message: PackageEventsDispatchQueueMessage
	toolFactories: PackageRuntimeToolFactories
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<PackageEventDeliveryResult> {
	const message = input.message
	// MCP fan-out is independent of package-subscriber discovery: a broken
	// package manifest must not hold webhook delivery hostage (queue retries
	// and inline dispatch both reach this path).
	const fanOutMcp = async () => {
		try {
			await fanOutPackageEventToMcpSubscriptions({
				env: input.env,
				baseUrl: input.baseUrl,
				message,
			})
		} catch (error) {
			console.error('mcp-events-fan-out-failed', {
				topic: message.topic,
				sourcePackageId: message.source.packageId,
				error,
			})
		}
	}

	let subscriptions: Awaited<
		ReturnType<typeof loadMatchingPackageEventSubscriptions>
	>
	try {
		subscriptions = await loadMatchingPackageEventSubscriptions({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: message.userId,
			topic: message.topic,
			payload: message.payload,
		})
	} catch (discoveryError) {
		await fanOutMcp()
		throw discoveryError
	}

	const envelope = stripUntrustedSubscriptionEnvelopeFields({
		event: message.topic,
		source: {
			type: 'package',
			package_id: message.source.packageId,
			kody_id: message.source.kodyId,
		},
		idempotency_key: message.idempotencyKey,
		payload: message.payload,
	}) as Record<string, unknown>
	const subscribers: PackageEventDeliveryResult['subscribers'] = []
	const retryableInfrastructureErrors: Array<Error> = []
	await runQueueableDynamicWorkerWork(async () => {
		for (const { savedPackage, subscription } of subscriptions) {
			const response = await invokePackageSubscriptionWithToolFactories({
				env: input.env,
				baseUrl: input.baseUrl,
				savedPackage,
				topic: message.topic,
				params: envelope,
				idempotencyKey: await buildPackageEventSubscriptionIdempotencyKey({
					sourcePackageId: message.source.packageId,
					subscriberPackageId: savedPackage.id,
					topic: message.topic,
					idempotencyKey: message.idempotencyKey,
				}),
				source: `package:${message.source.kodyId}`,
				actorTokenId: `${internalPackageEventSubscriptionTokenId}:${message.source.packageId}`,
				request: packageEventRequestSource(message),
				runtimeInvokeDepth: message.invokeDepth,
				resourceEventDepth: message.resourceEventDepth,
				toolFactories: input.toolFactories,
				waitUntil: input.waitUntil,
			})
			const retryableCode =
				readPreExecutionPackageInvocationInfrastructureCode(response)
			if (retryableCode) {
				retryableInfrastructureErrors.push(
					new Error(
						`Retryable package invocation infrastructure response: ${retryableCode}.`,
					),
				)
			}
			const replayed =
				(response.body['idempotency'] as { replayed?: unknown } | undefined)
					?.replayed === true
			const status =
				response.status >= 200 && response.status < 400
					? replayed
						? 'replayed'
						: 'completed'
					: 'failed'
			subscribers.push({
				packageId: savedPackage.id,
				kodyId: savedPackage.kodyId,
				handler: subscription.handler,
				status,
				...(status === 'failed'
					? { error: readInvocationError(response) }
					: {}),
			})
		}
	})
	// Runs before the incomplete-dispatch throw so MCP subscribers are not
	// held hostage by a package subscriber's infrastructure retry; a queue
	// redelivery re-sends with the same eventId for receiver dedupe.
	await fanOutMcp()
	if (retryableInfrastructureErrors.length > 0) {
		throw new Error('Package event dispatch was incomplete.', {
			cause: retryableInfrastructureErrors[0],
		})
	}
	const failed = subscribers.filter(
		(subscriber) => subscriber.status === 'failed',
	).length
	return {
		topic: message.topic,
		source: {
			type: 'package',
			packageId: message.source.packageId,
			kodyId: message.source.kodyId,
		},
		idempotencyKey: message.idempotencyKey,
		subscribers,
		delivered: subscribers.length - failed,
		failed,
	}
}

/**
 * Messages enqueued before they carried lineage have no person behind them.
 * They reach every enablement of the topic, like a platform event, and each
 * runs as its own enabler.
 */
function packageEventRequestSource(
	message: PackageEventsDispatchQueueMessage,
): RequestSource {
	return message.lineage
		? { kind: 'inherited', lineage: message.lineage }
		: {
				kind: 'platform-event',
				sourceId: `${internalPackageEventSubscriptionTokenId}:${message.source.packageId}`,
			}
}

export function createPackageEventToolsWithToolFactories(input: {
	env: Env
	baseUrl: string
	callerContext: ReturnType<typeof createMcpCallerContext>
	packageContext: PackageRuntimeContext | null
	parentRunRecord?: RunRecordContext | null
	packageInvokeDepth?: number
	toolFactories: PackageRuntimeToolFactories
	waitUntil?: (promise: Promise<unknown>) => void
}): PackageEventTools {
	return {
		dispatch: async (rawInput) => {
			const user = input.callerContext.user
			if (!user?.userId) {
				throw new Error('events.dispatch requires an authenticated user.')
			}
			if (!input.packageContext) {
				throw new Error('events.dispatch requires a package runtime context.')
			}
			const packageContext = input.packageContext
			const packageInvokeDepth = input.packageInvokeDepth ?? 0
			if (packageInvokeDepth >= maxPackageRuntimeInvokeDepth) {
				throw new Error(
					`events.dispatch exceeded the maximum nested invocation depth (${maxPackageRuntimeInvokeDepth}).`,
				)
			}
			const request = parsePackageEventDispatchInput(rawInput)
			const sourceId = packageContext.sourceId?.trim()
			if (!sourceId) {
				throw new Error('events.dispatch requires a published package source.')
			}
			const packageOwnerId = ownerIdFromCaller(input.callerContext)
			const sourceManifest = await loadPackageManifestBySourceId({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: packageOwnerId,
				sourceId,
			})
			const declaredEvent = listPackageEmittedEvents(
				sourceManifest.manifest,
			).find((event) => event.topic === request.topic)
			if (!declaredEvent) {
				throw new Error(
					`Package "${packageContext.kodyId}" does not declare emitted event "${request.topic}" in package.json#kody.emits.`,
				)
			}
			if (declaredEvent.payloadSchema) {
				const errors = listJsonSchemaSubsetValueErrors(
					declaredEvent.payloadSchema,
					request.payload,
				)
				if (errors.length > 0) {
					throw new Error(
						`events.dispatch payload does not match the declared payloadSchema for "${request.topic}":\n${errors.join('\n')}`,
					)
				}
			}
			const payloadBytes = new TextEncoder().encode(
				canonicalJsonStringify(request.payload),
			).byteLength
			if (payloadBytes > maxPackageEventPayloadBytes) {
				throw new Error(
					`events.dispatch payload is ${payloadBytes} bytes; the maximum is ${maxPackageEventPayloadBytes} bytes. Store large data in packageStorage() and emit a reference instead.`,
				)
			}
			const message: PackageEventsDispatchQueueMessage = {
				userId: packageOwnerId,
				topic: request.topic,
				idempotencyKey: request.idempotencyKey,
				payload: request.payload,
				source: {
					packageId: packageContext.packageId,
					kodyId: packageContext.kodyId,
				},
				invokeDepth: packageInvokeDepth + 1,
				...(declaredEvent.mcp ? { mcp: true as const } : {}),
				emittedAt: new Date().toISOString(),
				...(input.callerContext.request
					? { lineage: requestLineage(input.callerContext.request) }
					: {}),
				...(input.callerContext.resourceEventDepth
					? { resourceEventDepth: input.callerContext.resourceEventDepth }
					: {}),
			}
			const queue = (input.env as Partial<Env>).PACKAGE_EVENTS_DISPATCH_QUEUE
			let enqueued = false
			if (queue) {
				try {
					await queue.send(message)
					enqueued = true
				} catch (error) {
					console.error('package-events-dispatch-enqueue-failed', {
						topic: message.topic,
						sourcePackageId: message.source.packageId,
						error,
					})
				}
			}
			if (!enqueued) {
				// No Queue binding (local dev / preview) or enqueue failure:
				// deliver inline with the same consumer code path so events
				// still reach subscribers. Delivery failures are logged, never
				// surfaced to the emitter — matching queued semantics.
				const inlineDelivery = deliverPackageEventWithToolFactories({
					env: input.env,
					baseUrl: input.baseUrl,
					message,
					toolFactories: input.toolFactories,
					waitUntil: input.waitUntil,
				}).catch((error) => {
					console.error('package-events-inline-delivery-failed', {
						topic: message.topic,
						sourcePackageId: message.source.packageId,
						error,
					})
				})
				if (input.waitUntil) {
					input.waitUntil(inlineDelivery)
				} else {
					await inlineDelivery
				}
			}
			return {
				topic: request.topic,
				source: {
					type: 'package',
					packageId: packageContext.packageId,
					kodyId: packageContext.kodyId,
				},
				idempotencyKey: request.idempotencyKey,
				status: enqueued ? 'enqueued' : 'delivered_inline',
			}
		},
	}
}

export type SubscriptionInvocationInput = {
	env: Env
	baseUrl: string
	savedPackage: SavedPackageRecord
	topic: string
	params?: Record<string, unknown>
	idempotencyKey: string
	source?: string | null
	trustedSyntheticDispatch?: TrustedSyntheticSubscriptionDispatch
	actorTokenId?: string
	request: RequestSource
	/** What an org-wide event is about, for the enablement audience rule. */
	audience?: EnablementAudience | null
	/**
	 * Inbound From, for per-sender enablement matching. Address, domain, and
	 * `any_authenticated` also need `inboundFromAuthenticated`.
	 */
	inboundFromAddress?: string | null
	inboundFromAuthenticated?: boolean
	runtimeInvokeDepth?: number
	/** Resource change event chain depth the handler run carries on. */
	resourceEventDepth?: number
	/**
	 * Personalize the event per enabler, from that enabler's access checked
	 * for this delivery (for example, include the actor only for people who
	 * can read the audit log). Defaults to `params` for every run.
	 */
	paramsForRun?: (run: {
		access: EffectivePermissions | null
	}) => Record<string, unknown>
	toolFactories: PackageRuntimeToolFactories
	waitUntil?: (promise: Promise<unknown>) => void
}

/**
 * Who a subscription event may reach:
 * `{ onlyEnablerId: id }` narrows to one person, `{ onlyEnablerId: null }`
 * does not narrow, and `null` reaches nobody.
 *
 * - An event raised by a run (and the smoke test) reaches only the run's
 *   person, and nobody when the run had no person.
 * - Inbound email does not narrow by enabler. Per-sender enablement rows
 *   decide which runs fire. A member sender still limits the package list
 *   to packages they can execute, before this gate.
 * - Platform topics reach every enablement, narrowed by the audience rule.
 */
function subscriptionEnablerScope(
	request: RequestSource,
): { onlyEnablerId: string | null } | null {
	switch (request.kind) {
		case 'inherited': {
			const actorId = request.lineage.actor?.userId
			return actorId ? { onlyEnablerId: actorId } : null
		}
		case 'inbound-email':
			return { onlyEnablerId: null }
		case 'schedule':
		case 'webhook': {
			const enablerId = request.enablement?.enabler.userId
			return enablerId ? { onlyEnablerId: enablerId } : null
		}
		case 'platform-event':
			return {
				onlyEnablerId: request.enablement?.enabler.userId ?? null,
			}
		case 'session':
		case 'mcp-oauth':
		case 'cli':
		case 'api-token':
		case 'package-app':
		case 'execution-context-run':
			return null
		default: {
			const exhaustive: never = request
			throw new Error(`Unhandled request source: ${String(exhaustive)}`)
		}
	}
}

/** The request source one enablement's run of a subscription uses. */
function subscriptionEnablementSource(input: {
	request: RequestSource
	sourceId: string
	run: EnablementRun
}): RequestSource {
	if (input.request.kind === 'inbound-email') {
		return { ...input.request, enablement: input.run }
	}
	return {
		kind: 'platform-event',
		sourceId: input.sourceId,
		enablement: input.run,
	}
}

function isSuccessfulInvocation(response: PackageInvocationResponse) {
	return response.status >= 200 && response.status < 400
}

/**
 * Invoke one package subscription handler. It runs once per on enablement in
 * scope, each as its enabler with its own
 * idempotency key; with none, the event is dropped (the smoke test gets a
 * 409 telling the caller to turn the subscription on for themselves).
 * Returns the first failed run's response, else the last run's.
 */
export async function invokePackageSubscriptionWithToolFactories(
	input: SubscriptionInvocationInput,
): Promise<PackageInvocationResponse> {
	const topic = normalizePackageSubscriptionTopic(input.topic)
	const idempotencyKey = input.idempotencyKey.trim()
	if (!idempotencyKey) {
		return buildJsonErrorResponse({
			status: 400,
			code: 'missing_idempotency_key',
			message:
				'Package subscription invocations require a non-empty idempotencyKey.',
		})
	}
	const synthetic = isTrustedSyntheticSubscriptionDispatch(
		input.trustedSyntheticDispatch,
	)
	const orgId = input.savedPackage.userId
	const scope = subscriptionEnablerScope(input.request)
	const plan = await planEnablementRuns({
		env: input.env,
		orgId,
		packageId: input.savedPackage.id,
		trigger: {
			kind: 'subscription',
			instanceId: input.savedPackage.id,
			triggerName: topic,
		},
		onlyEnablerId: scope?.onlyEnablerId,
		...(input.request.kind === 'inbound-email'
			? {
					inboundSender: {
						sender: input.request.sender,
						fromAddress: input.inboundFromAddress ?? null,
						authenticated: input.inboundFromAuthenticated === true,
					},
				}
			: {}),
		audience: input.audience,
	})
	const runs = scope ? plan.runs : []
	if (runs.length === 0) {
		if (synthetic) {
			return buildJsonErrorResponse({
				status: 409,
				code: 'enablement_not_on',
				message: isInboundEmailApprovalTopic(topic)
					? `You have no on enablement of subscription "${topic}" on package "${input.savedPackage.kodyId}" for this sender. Approve one from the inbox; enablementEnable cannot turn email on.`
					: `You have no on enablement of subscription "${topic}" on package "${input.savedPackage.kodyId}". Turn it on for yourself with enablementEnable, then dispatch again.`,
				idempotencyKey,
			})
		}
		return {
			status: 202,
			body: {
				ok: true,
				skipped: { reason: 'no_enablement_on', enablements: plan.skipped },
			},
		}
	}
	const sourceId = input.actorTokenId ?? internalEmailSubscriptionTokenId
	let selected: PackageInvocationResponse | null = null
	for (const run of runs) {
		const response = await invokeSubscriptionOnce(
			input.paramsForRun
				? {
						...input,
						params: input.paramsForRun({
							access: plan.access?.get(run.id) ?? null,
						}),
					}
				: input,
			subscriptionEnablementSource({ request: input.request, sourceId, run }),
			`${idempotencyKey}:enablement:${run.id}`,
		)
		if (!selected || isSuccessfulInvocation(selected)) selected = response
	}
	if (!selected) throw new Error('Expected at least one enablement run.')
	return selected
}

async function invokeSubscriptionOnce(
	input: SubscriptionInvocationInput,
	request: RequestSource,
	idempotencyKey: string,
) {
	const topic = normalizePackageSubscriptionTopic(input.topic)
	const synthetic = isTrustedSyntheticSubscriptionDispatch(
		input.trustedSyntheticDispatch,
	)
	const requestedSource = normalizeNullableString(input.source)
	const source = synthetic
		? syntheticPackageSubscriptionSource
		: requestedSource === syntheticPackageSubscriptionSource
			? 'email'
			: (requestedSource ?? 'email')
	const params = synthetic
		? input.params
		: stripUntrustedSubscriptionEnvelopeFields(input.params)
	return await invokeSavedPackageModule({
		env: input.env,
		baseUrl: input.baseUrl,
		actor: {
			sourceId: input.actorTokenId ?? internalEmailSubscriptionTokenId,
			orgId: input.savedPackage.userId,
			request,
			...(input.resourceEventDepth
				? { resourceEventDepth: input.resourceEventDepth }
				: {}),
		},
		savedPackage: input.savedPackage,
		invocationName: buildPackageSubscriptionArtifactName(topic),
		moduleSelector: {
			kind: 'subscription',
			topic,
		},
		params,
		idempotencyKey,
		source,
		topic,
		notFoundCode: 'subscription_not_found',
		executionTarget: { kind: 'subscription', name: topic },
		runtimeInvokeDepth: input.runtimeInvokeDepth ?? 0,
		toolFactories: input.toolFactories,
		waitUntil: input.waitUntil,
	})
}
