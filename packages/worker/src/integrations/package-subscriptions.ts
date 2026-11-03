import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { findIntegrationCredentialId } from '#worker/integrations/credentials.ts'
import { readSignupOrgSlugOrNull } from '#worker/orgs/signup-org-slug.ts'
import { runQueueableDynamicWorkerWork } from '#worker/dynamic-worker-evaluation-budget.ts'
import {
	loadMatchingPackageSubscriptions,
	readPreExecutionPackageInvocationInfrastructureCode,
} from '#worker/package-invocations/admin-package-subscriptions.ts'
import { invokePackageSubscription } from '#worker/package-invocations/service.ts'
import {
	buildIntegrationAccountUrl,
	buildIntegrationReconnectUrl,
} from './account-identity.ts'
import type { IntegrationAuthFailedReason } from './token-refresh.ts'

export const integrationAuthFailedTopic = 'integration.auth.failed'
export const integrationAuthSucceededTopic = 'integration.auth.succeeded'

export const integrationAuthSucceededSources = [
	'refresh',
	'oauth_connect',
] as const

export type IntegrationAuthSucceededSource =
	(typeof integrationAuthSucceededSources)[number]

export type IntegrationAuthConnection = {
	name: string
	lane: 'user' | 'platform'
	account_label: string | null
	description: string | null
	provider: string | null
	platform_app_slug: string | null
	scopes: Array<string>
	connected_at: string | null
	token_refreshed_at: string | null
}

export type IntegrationAuthFailedSubscriptionEnvelope = {
	event: typeof integrationAuthFailedTopic
	event_id: string
	integration: IntegrationAuthConnection
	reason: IntegrationAuthFailedReason
	provider: {
		error: string | null
		error_description: string | null
		http_status: number | null
	}
	reconnect_url: string
	account_url: string
	occurred_at: string
}

export type IntegrationAuthSucceededSubscriptionEnvelope = {
	event: typeof integrationAuthSucceededTopic
	event_id: string
	integration: IntegrationAuthConnection
	source: IntegrationAuthSucceededSource
	account_url: string
	occurred_at: string
}

type IntegrationAuthTopic =
	| typeof integrationAuthFailedTopic
	| typeof integrationAuthSucceededTopic

export function buildIntegrationAuthFailedReconnectUrl(input: {
	baseUrl: string
	integrationName: string
	accountLabel?: string | null
}) {
	return buildIntegrationReconnectUrl({
		baseUrl: input.baseUrl,
		integrationName: input.integrationName,
		accountLabel: input.accountLabel,
	})
}

export function buildIntegrationAuthAccountUrl(input: {
	baseUrl: string
	orgSlug: string
	integrationName: string
}) {
	return buildIntegrationAccountUrl(input)
}

function buildSubscriptionIdempotencyKey(input: {
	topic: IntegrationAuthTopic
	eventId: string
	packageId: string
}) {
	const prefix =
		input.topic === integrationAuthFailedTopic
			? 'integration-auth-failed'
			: 'integration-auth-succeeded'
	return `${prefix}:${input.eventId}:${input.packageId}`
}

function buildFailedEventPayload(input: {
	baseUrl: string
	orgSlug: string
	eventId: string
	occurredAt: string
	integration: IntegrationAuthConnection
	reason: IntegrationAuthFailedReason
	provider: IntegrationAuthFailedSubscriptionEnvelope['provider']
}): IntegrationAuthFailedSubscriptionEnvelope {
	return {
		event: integrationAuthFailedTopic,
		event_id: input.eventId,
		integration: input.integration,
		reason: input.reason,
		provider: input.provider,
		reconnect_url: buildIntegrationAuthFailedReconnectUrl({
			baseUrl: input.baseUrl,
			integrationName: input.integration.name,
			accountLabel: input.integration.account_label,
		}),
		account_url: buildIntegrationAccountUrl({
			baseUrl: input.baseUrl,
			orgSlug: input.orgSlug,
			integrationName: input.integration.name,
		}),
		occurred_at: input.occurredAt,
	}
}

function buildSucceededEventPayload(input: {
	baseUrl: string
	orgSlug: string
	eventId: string
	occurredAt: string
	integration: IntegrationAuthConnection
	source: IntegrationAuthSucceededSource
}): IntegrationAuthSucceededSubscriptionEnvelope {
	return {
		event: integrationAuthSucceededTopic,
		event_id: input.eventId,
		integration: input.integration,
		source: input.source,
		account_url: buildIntegrationAuthAccountUrl({
			baseUrl: input.baseUrl,
			orgSlug: input.orgSlug,
			integrationName: input.integration.name,
		}),
		occurred_at: input.occurredAt,
	}
}

async function loadMatchingAuthSubscriptions(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>
	baseUrl: string
	userId: string
	topic: IntegrationAuthTopic
}) {
	try {
		return await loadMatchingPackageSubscriptions(input)
	} catch (error) {
		return { subscriptions: [], discoveryErrors: [error] }
	}
}

async function dispatchIntegrationAuthSubscriptionEvents(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	userId: string
	eventId: string
	topic: IntegrationAuthTopic
	eventPayload: Record<string, unknown>
	integrationName: string
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const baseUrl = getAppBaseUrl({ env: input.env })
	const credentialId = await findIntegrationCredentialId({
		env: input.env,
		userId: ownerIdFromStored(input.userId),
		name: input.integrationName,
	})
	const { subscriptions, discoveryErrors } =
		await loadMatchingAuthSubscriptions({
			env: input.env,
			baseUrl,
			userId: input.userId,
			topic: input.topic,
		})
	const settled = await runQueueableDynamicWorkerWork(
		async () =>
			await Promise.allSettled(
				subscriptions.map(async ({ savedPackage }) => {
					const response = await invokePackageSubscription({
						env: input.env as Env,
						baseUrl,
						savedPackage,
						topic: input.topic,
						params: input.eventPayload,
						idempotencyKey: buildSubscriptionIdempotencyKey({
							topic: input.topic,
							eventId: input.eventId,
							packageId: savedPackage.id,
						}),
						source: 'integrations',
						request: { kind: 'platform-event', sourceId: 'integrations' },
						audience: {
							resource: credentialId
								? { type: 'credential', id: credentialId }
								: null,
						},
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
			console.warn(`${input.topic} package subscription invoke failed`, {
				eventId: input.eventId,
				integrationName: input.integrationName,
				error: result.reason,
			})
		}
	}
	if (discoveryErrors.length > 0) {
		console.warn(`${input.topic} package subscription discovery incomplete`, {
			eventId: input.eventId,
			integrationName: input.integrationName,
			errorCount: discoveryErrors.length,
			error: discoveryErrors[0],
		})
	}
	return settled.map((result) =>
		result.status === 'fulfilled' ? result.value : null,
	)
}

/**
 * Fan a reconnectable OAuth refresh failure out to the owning user's packages
 * that declare `integration.auth.failed`. Best-effort: discovery and invocation
 * infrastructure failures are logged, never thrown — the refresh caller must
 * still receive the original error. Sibling handler terminal failures are
 * isolated via `Promise.allSettled`.
 *
 * Every classified caller-error emits. Sequential attempts are not coalesced;
 * concurrent in-flight refreshes of the same connection share one attempt.
 * Notifier packages decide how often to ping, typically by pairing this topic
 * with `integration.auth.succeeded` and storing last-known health.
 */
export async function dispatchIntegrationAuthFailedSubscriptionEvents(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	userId: string
	eventId: string
	occurredAt: string
	integration: IntegrationAuthConnection
	orgSlug?: string
	reason: IntegrationAuthFailedReason
	provider: IntegrationAuthFailedSubscriptionEnvelope['provider']
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const orgSlug = await readSignupOrgSlugOrNull(
		input.env.APP_DB,
		input.userId,
		input.orgSlug,
	)
	if (!orgSlug) {
		return []
	}
	const baseUrl = getAppBaseUrl({ env: input.env })
	return dispatchIntegrationAuthSubscriptionEvents({
		env: input.env,
		userId: input.userId,
		eventId: input.eventId,
		topic: integrationAuthFailedTopic,
		eventPayload: buildFailedEventPayload({
			baseUrl,
			orgSlug,
			eventId: input.eventId,
			occurredAt: input.occurredAt,
			integration: input.integration,
			reason: input.reason,
			provider: input.provider,
		}) as Record<string, unknown>,
		integrationName: input.integration.name,
		waitUntil: input.waitUntil,
	})
}

/**
 * Fan a successful OAuth grant (host-side refresh or `/connect/oauth` persist)
 * out to the owning user's packages that declare `integration.auth.succeeded`.
 * Best-effort: discovery and invocation infrastructure failures are logged,
 * never thrown. Sequential successful refreshes and connect persists each
 * emit; concurrent in-flight refreshes of the same connection share one
 * attempt. Notifier packages edge-detect working ↔ failed in their own
 * storage.
 */
export async function dispatchIntegrationAuthSucceededSubscriptionEvents(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	userId: string
	eventId: string
	occurredAt: string
	integration: IntegrationAuthConnection
	source: IntegrationAuthSucceededSource
	orgSlug?: string
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const orgSlug = await readSignupOrgSlugOrNull(
		input.env.APP_DB,
		input.userId,
		input.orgSlug,
	)
	if (!orgSlug) {
		return []
	}
	const baseUrl = getAppBaseUrl({ env: input.env })
	return dispatchIntegrationAuthSubscriptionEvents({
		env: input.env,
		userId: input.userId,
		eventId: input.eventId,
		topic: integrationAuthSucceededTopic,
		eventPayload: buildSucceededEventPayload({
			baseUrl,
			orgSlug,
			eventId: input.eventId,
			occurredAt: input.occurredAt,
			integration: input.integration,
			source: input.source,
		}) as Record<string, unknown>,
		integrationName: input.integration.name,
		waitUntil: input.waitUntil,
	})
}
