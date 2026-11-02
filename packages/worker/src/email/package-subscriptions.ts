import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	checkPermission,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { runQueueableDynamicWorkerWork } from '#worker/dynamic-worker-evaluation-budget.ts'
import { resolveBackgroundMcpUser } from '#worker/identity/background-mcp-user.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import {
	dispatchAdminPackageSubscriptionEvent,
	loadMatchingPackageSubscriptions,
	readPreExecutionPackageInvocationInfrastructureCode,
} from '#worker/package-invocations/admin-package-subscriptions.ts'
import { invokePackageSubscription } from '#worker/package-invocations/service.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	deriveRequestContext,
	type RequestSource,
} from '#worker/request-context/request-context.ts'
import { type CloudflareEmailDeliveryEvent } from './delivery-events.ts'
import { normalizeHeaderMailbox } from './address.ts'
import { resolveInboundEmailAuthVerdict } from './auth-verdict.ts'
import {
	authenticatesFromAddress,
	classifyInboundEmailSender,
} from './inbound-sender.ts'
import { listInternalEmailAttachmentsForMessage } from './mailbox-internal-read.ts'
import { listSystemEmailAttachments } from './system-email-graph-store.ts'
import { type EmailAttachmentRecord, type EmailMessageRecord } from './types.ts'

export const inboundEmailReceiptTopic = 'email.message.received'
export const inboundEmailQuarantinedTopic = 'email.message.quarantined'
const systemInboundEmailReceiptTopic = 'email.system-message.received'
export const emailDeliveryUpdatedTopic = 'email.message.delivery.updated'

type EmailReceiptSubscriptionEnvelope = {
	event:
		| typeof inboundEmailReceiptTopic
		| typeof inboundEmailQuarantinedTopic
		| typeof systemInboundEmailReceiptTopic
	message: {
		id: string
		inbox_id: string | null
		from_address: string | null
		envelope_from: string | null
		to_addresses: Array<string>
		cc_addresses: Array<string>
		reply_to_addresses: Array<string>
		subject: string | null
		message_id_header: string | null
		in_reply_to_header: string | null
		references: Array<string>
		processing_status: EmailMessageRecord['processingStatus']
		classification: EmailMessageRecord['classification']
		classification_reason: string | null
		received_at: string | null
		created_at: string
	}
	attachments: Array<{
		id: string
		filename: string | null
		content_type: string | null
		content_id: string | null
		disposition: string | null
		size: number
		storage_kind: string
		storage_key: string | null
		created_at: string
	}>
}

type SystemEmailReceiptSubscriptionEnvelope =
	EmailReceiptSubscriptionEnvelope & {
		event: typeof systemInboundEmailReceiptTopic
		/** Admin-interface link for the stored system message. */
		admin_url: string
	}

function stringArray(values: ReadonlyArray<unknown>) {
	return values.filter((value): value is string => typeof value === 'string')
}

function toRuntimeAttachmentMetadata(attachment: EmailAttachmentRecord) {
	return {
		id: attachment.id,
		filename: attachment.filename,
		content_type: attachment.contentType,
		content_id: attachment.contentId,
		disposition: attachment.disposition,
		size: attachment.size,
		storage_kind: attachment.storageKind,
		storage_key: attachment.storageKey,
		created_at: attachment.createdAt,
	}
}

export function buildEmailReceiptSubscriptionEnvelope(input: {
	event: EmailReceiptSubscriptionEnvelope['event']
	message: EmailMessageRecord
	attachments: Array<EmailAttachmentRecord>
}) {
	return {
		event: input.event,
		message: {
			id: input.message.id,
			inbox_id: input.message.inboxId,
			from_address: input.message.fromAddress,
			envelope_from: input.message.envelopeFrom,
			to_addresses: stringArray(input.message.toAddresses),
			cc_addresses: stringArray(input.message.ccAddresses),
			reply_to_addresses: stringArray(input.message.replyToAddresses),
			subject: input.message.subject,
			message_id_header: input.message.messageIdHeader,
			in_reply_to_header: input.message.inReplyToHeader,
			references: stringArray(input.message.references),
			processing_status: input.message.processingStatus,
			classification: input.message.classification,
			classification_reason: input.message.classificationReason,
			received_at: input.message.receivedAt,
			created_at: input.message.createdAt,
		},
		attachments: input.attachments.map(toRuntimeAttachmentMetadata),
	} satisfies EmailReceiptSubscriptionEnvelope
}

function buildSubscriptionIdempotencyKey(input: {
	messageId: string
	packageId: string
	topic: string
}) {
	return `email:${input.messageId}:${input.packageId}:${input.topic}`
}

async function loadMatchingEmailSubscriptions(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>
	baseUrl: string
	userId: OwnerId
	topic: string
}) {
	return await loadMatchingPackageSubscriptions(input)
}

/**
 * A member sender runs only the packages they may execute in the mailbox
 * org. The actor is that member, and the org is the inbox — a team org has
 * no users row, so the mailbox id is not a person to resolve. External
 * inbox-owner mail skips this gate; which of those packages run is the
 * per-sender enablement rule.
 */
async function subscriptionsRunnableBySender<
	T extends { savedPackage: SavedPackageRecord },
>(input: {
	env: Pick<Env, 'APP_DB'>
	orgId: OwnerId
	request: Extract<RequestSource, { kind: 'inbound-email' }>
	subscriptions: Array<T>
}): Promise<Array<T>> {
	const { sender } = input.request
	switch (sender.kind) {
		case 'inbox-owner':
			return input.subscriptions
		case 'member': {
			const personId = sender.actor.userId
			const orgBinding = await loadOrgBindingForOrg(
				input.env.APP_DB,
				personId,
				input.orgId,
			)
			// Classified as a member, then lost the mailbox org before dispatch.
			if (!orgBinding) return []
			const request = deriveRequestContext({
				user: await resolveBackgroundMcpUser(input.env.APP_DB, personId),
				source: input.request,
				orgBinding,
			})
			const access = await computeEffectivePermissions({
				env: input.env as Env,
				request,
			})
			return input.subscriptions.filter(
				({ savedPackage }) =>
					checkPermission(
						access,
						'package:execute',
						packageResource({
							id: savedPackage.id,
							userId: savedPackage.userId,
							label: savedPackage.name,
						}),
					).allowed,
			)
		}
		default: {
			const exhaustive: never = sender
			throw new Error(`Unhandled inbound email sender: ${String(exhaustive)}`)
		}
	}
}

export async function dispatchInboundEmailSubscriptionEvents(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL' | 'MAILBOX'>
	userId: OwnerId
	message: EmailMessageRecord
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const sender = await classifyInboundEmailSender({
		db: input.env.APP_DB,
		orgId: input.userId,
		message: input.message,
	})
	if (sender.kind === 'unverified') {
		console.warn('inbound-email-sender-unverified', {
			orgId: input.userId,
			inboxId: input.message.inboxId,
			messageId: input.message.id,
			reason: sender.reason,
			outcome: 'no package subscriptions ran',
		})
		return []
	}
	const request = {
		kind: 'inbound-email',
		sourceId: input.message.inboxId ?? input.message.id,
		sender,
	} satisfies RequestSource
	const baseUrl = getAppBaseUrl({
		env: input.env,
	})
	const attachments = await listInternalEmailAttachmentsForMessage({
		env: input.env,
		ownerId: input.userId,
		messageId: input.message.id,
	})
	const topic =
		input.message.classification === 'quarantined'
			? inboundEmailQuarantinedTopic
			: inboundEmailReceiptTopic
	const { subscriptions, discoveryErrors } =
		await loadMatchingEmailSubscriptions({
			env: input.env,
			baseUrl,
			userId: input.userId,
			topic,
		})
	const fromAddress = input.message.fromAddress
		? normalizeHeaderMailbox(input.message.fromAddress)
		: null
	const inboundFromAuthenticated = fromAddress
		? authenticatesFromAddress({
				verdict: resolveInboundEmailAuthVerdict(input.message.authResults),
				fromAddress,
				envelopeFrom: input.message.envelopeFrom,
			})
		: false
	const runnable = await subscriptionsRunnableBySender({
		env: input.env,
		orgId: input.userId,
		request,
		subscriptions,
	})
	const eventPayload = buildEmailReceiptSubscriptionEnvelope({
		event: topic,
		message: input.message,
		attachments,
	})
	const settled = await runQueueableDynamicWorkerWork(
		async () =>
			await Promise.allSettled(
				runnable.map(async ({ savedPackage }) => {
					const response = await invokePackageSubscription({
						env: input.env as Env,
						baseUrl,
						savedPackage,
						topic,
						params: eventPayload as Record<string, unknown>,
						idempotencyKey: buildSubscriptionIdempotencyKey({
							messageId: input.message.id,
							packageId: savedPackage.id,
							topic,
						}),
						source: 'email',
						request,
						inboundFromAddress: input.message.fromAddress,
						inboundFromAuthenticated,
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
	const invocationError = settled.find(
		(result): result is PromiseRejectedResult => result.status === 'rejected',
	)
	if (discoveryErrors.length > 0 || invocationError) {
		throw new Error(
			'Inbound email package subscription dispatch was incomplete.',
			{
				cause: discoveryErrors[0] ?? invocationError?.reason,
			},
		)
	}
	return settled.map((result) =>
		result.status === 'fulfilled' ? result.value : null,
	)
}

export async function dispatchEmailDeliverySubscriptionEvents(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	message: EmailMessageRecord
	providerEvent: CloudflareEmailDeliveryEvent
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const baseUrl = getAppBaseUrl({ env: input.env })
	const { subscriptions, discoveryErrors } =
		await loadMatchingEmailSubscriptions({
			env: input.env,
			baseUrl,
			userId: input.message.userId,
			topic: emailDeliveryUpdatedTopic,
		})
	const payload = {
		event: emailDeliveryUpdatedTopic,
		message: {
			id: input.message.id,
			inbox_id: input.message.inboxId,
			thread_id: input.message.threadId,
			from_address: input.message.fromAddress,
			to_addresses: stringArray(input.message.toAddresses),
			subject: input.message.subject,
			processing_status: input.message.processingStatus,
			provider_message_id: input.message.providerMessageId,
			delivery_status: input.message.deliveryStatus,
			delivery_status_at: input.message.deliveryStatusAt,
			sent_at: input.message.sentAt,
			created_at: input.message.createdAt,
		},
		delivery: {
			event_id: input.providerEvent.payload.eventId,
			status: input.providerEvent.payload.delivery.status,
			terminal: input.providerEvent.payload.terminal,
			sender: input.providerEvent.payload.sender,
			recipient: input.providerEvent.payload.recipient,
			delivery: input.providerEvent.payload.delivery,
			bounce: input.providerEvent.payload.bounce ?? null,
			failure: input.providerEvent.payload.failure ?? null,
			rejection: input.providerEvent.payload.rejection ?? null,
			complaint: input.providerEvent.payload.complaint ?? null,
			occurred_at: input.providerEvent.metadata.eventTimestamp,
		},
	}
	const results = await runQueueableDynamicWorkerWork(
		async () =>
			await Promise.all(
				subscriptions.map(async ({ savedPackage }) => {
					const response = await invokePackageSubscription({
						env: input.env as Env,
						baseUrl,
						savedPackage,
						topic: emailDeliveryUpdatedTopic,
						params: payload,
						idempotencyKey: `email-delivery:${input.providerEvent.payload.eventId}:${savedPackage.id}`,
						source: 'email',
						request: { kind: 'platform-event', sourceId: 'email' },
						waitUntil: input.waitUntil,
					})
					return {
						response,
						retryableCode:
							readPreExecutionPackageInvocationInfrastructureCode(response),
					}
				}),
			),
	)
	const retryableResult = results.find((result) => result.retryableCode)
	if (discoveryErrors.length > 0 || retryableResult) {
		throw new Error('Email delivery subscription dispatch was incomplete.', {
			cause:
				discoveryErrors[0] ??
				new Error(
					`Retryable package invocation infrastructure response: ${retryableResult?.retryableCode}.`,
				),
		})
	}
	return results.map((result) => result.response)
}

/**
 * Fan a stored system-inbox message (`system:email` owner) out to packages
 * saved by users who hold the admin role at dispatch time. The payload is the
 * same metadata-first envelope as `email.message.received` on a dedicated
 * `email.system-message.received` topic, plus an `admin_url` link to the
 * message in the admin interface — handlers run as the admin package owner,
 * not the system owner, so they read full contents through the admin UI/API
 * rather than the user-scoped email helpers.
 */
export async function dispatchSystemInboundEmailSubscriptionEvents(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	message: EmailMessageRecord
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const baseUrl = getAppBaseUrl({
		env: input.env,
	})
	return await dispatchAdminPackageSubscriptionEvent({
		env: input.env,
		baseUrl,
		topic: systemInboundEmailReceiptTopic,
		async getParams() {
			const attachments = await listSystemEmailAttachments({
				db: input.env.APP_DB,
				messageId: input.message.id,
			})
			const eventPayload = {
				...buildEmailReceiptSubscriptionEnvelope({
					event: systemInboundEmailReceiptTopic,
					message: input.message,
					attachments,
				}),
				event: systemInboundEmailReceiptTopic,
				admin_url: `${baseUrl}/admin/system-email?messageId=${encodeURIComponent(
					input.message.id,
				)}`,
			} satisfies SystemEmailReceiptSubscriptionEnvelope
			return eventPayload as Record<string, unknown>
		},
		source: 'email',
		retryDiscoveryFailures: true,
		retryInvocationInfrastructureFailures: true,
		retryOnlyPreExecutionInfrastructureFailures: true,
		buildIdempotencyKey: (savedPackage) =>
			buildSubscriptionIdempotencyKey({
				messageId: input.message.id,
				packageId: savedPackage.id,
				topic: systemInboundEmailReceiptTopic,
			}),
		waitUntil: input.waitUntil,
	})
}
