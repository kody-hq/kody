import { z } from 'zod'
import { utf8ByteLength } from '@kody-internal/shared/backup-restore-safety.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { authorize, packageResource } from '#worker/authorization/authorize.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { requireInteractiveMcpCaller } from '#mcp/capabilities/meta/require-interactive-caller.ts'
import { inheritRequest } from '#worker/request-context/request-context.ts'
import {
	buildEmailReceiptSubscriptionEnvelope,
	inboundEmailReceiptTopic,
	inboundEmailQuarantinedTopic,
} from '#worker/email/package-subscriptions.ts'
import {
	getInternalEmailMessageById,
	listInternalEmailAttachmentsForMessage,
} from '#worker/email/mailbox-internal-read.ts'
import { readPreExecutionPackageInvocationInfrastructureCode } from '#worker/package-invocations/infrastructure-codes.ts'
import { invokePackageSubscription } from '#worker/package-invocations/service.ts'
import {
	buildFreshSyntheticSubscriptionIdempotencyKey,
	buildPackageSubscriptionNotFoundMessage,
	internalSyntheticSubscriptionTokenId,
	packageSubscriptionDispatchCapabilityName,
	stripUntrustedSubscriptionEnvelopeFields,
	trustedSyntheticSubscriptionDispatch,
} from '#worker/package-invocations/subscription-envelope.ts'
import { listPackageSubscriptions } from '#worker/package-registry/manifest.ts'
import { resolvePackageOwnerContext } from '#worker/package-registry/package-owner.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import {
	findOwnedSavedPackage,
	packageIdentityCountMessage,
	packageIdentityInputShape,
} from './owned-package-lookup.ts'

const maxSyntheticSubscriptionResultBytes = 102_400

const packageRuntimeCallerErrorMessage = `${packageSubscriptionDispatchCapabilityName} is unavailable from package runtime contexts. It is the interactive-MCP post-publish subscription smoke test. Compose another package with a static kody:@scope/pkg/export import.`

function requireExactlyOneDispatchInput(input: {
	email_message_id?: string
	params?: Record<string, unknown>
}) {
	const count =
		(input.email_message_id !== undefined ? 1 : 0) +
		(input.params !== undefined ? 1 : 0)
	if (count !== 1) {
		throw new McpCallerError(
			`Provide exactly one of \`email_message_id\` (replay a stored inbound email) or \`params\` (synthetic envelope) to ${packageSubscriptionDispatchCapabilityName}.`,
		)
	}
}

function readInvocationError(response: {
	status: number
	body: Record<string, unknown>
}) {
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

function boundSyntheticSubscriptionResult(result: unknown) {
	const serialized = JSON.stringify(result)
	if (
		serialized === undefined ||
		utf8ByteLength(serialized) <= maxSyntheticSubscriptionResultBytes
	) {
		return result
	}
	return {
		truncated: true,
		message: `Subscription result exceeded ${maxSyntheticSubscriptionResultBytes} bytes and was omitted. Inspect the subscription run for details.`,
	}
}

export const packageSubscriptionDispatchCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: packageSubscriptionDispatchCapabilityName,
		contextRuns: 'deny',
		orgPermission: 'package:execute',
		description:
			'Interactive-MCP post-publish smoke test for one declared package.json#kody.subscriptions handler on an owner-scoped saved package. Real-surface run with real side effects; does not wait for a production event and is unavailable from package jobs, subscriptions, webhooks, or other package runtimes. Package composition is a static kody:@scope/pkg/export import (plus kody.dependencies), not this capability. Pass params for a fixture envelope or email_message_id to replay stored inbound mail. The platform marks the run synthetic.',
		keywords: [
			'package',
			'subscription',
			'subscriptions',
			'dispatch',
			'synthetic',
			'replay',
			'email.message.received',
			'integration.auth.failed',
			'integration.auth.succeeded',
			'mcp.server.disconnected',
			'mcp.server.reconnected',
			'test',
			'smoke',
			'post-publish',
			'verification',
			'interactive',
			'simulate',
			'probe',
			'debug',
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z
			.object({
				...packageIdentityInputShape,
				topic: z
					.string()
					.min(1)
					.describe(
						'Exact subscription topic declared in package.json#kody.subscriptions.',
					),
				email_message_id: z
					.string()
					.min(1)
					.optional()
					.describe(
						'Replay a stored inbound email by id. Builds the same metadata-first receipt envelope as real email dispatch, then marks it synthetic with replay_of.',
					),
				params: z
					.record(z.string(), z.unknown())
					.optional()
					.describe(
						'Custom subscription envelope object. Caller-supplied synthetic/replay_of fields are ignored; the platform adds synthetic: true.',
					),
			})
			.superRefine((value, ctx) => {
				if (
					(value.package_id !== undefined ? 1 : 0) +
						(value.kody_id !== undefined ? 1 : 0) !==
					1
				) {
					ctx.addIssue({
						code: 'custom',
						message: packageIdentityCountMessage,
					})
				}
				const dispatchModeCount =
					(value.email_message_id !== undefined ? 1 : 0) +
					(value.params !== undefined ? 1 : 0)
				if (dispatchModeCount !== 1) {
					ctx.addIssue({
						code: 'custom',
						message: 'Provide exactly one of `email_message_id` or `params`.',
					})
				}
			}),
		outputSchema: z.object({
			package_id: z.string(),
			kody_id: z.string().describe('Package name leaf (same value as `slug`).'),
			slug: z.string().describe('Package name leaf (same value as `kody_id`).'),
			topic: z.string(),
			idempotency_key: z.string(),
			source: z.literal('synthetic'),
			synthetic: z.literal(true),
			replay_of: z.string().nullable(),
			status: z.number().int(),
			replayed: z.boolean(),
			result: z.unknown().optional(),
			error: z
				.object({
					code: z.string(),
					message: z.string(),
				})
				.optional(),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			requireInteractiveMcpCaller(
				ctx.callerContext,
				packageRuntimeCallerErrorMessage,
			)
			requireExactlyOneDispatchInput(args)
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user,
				request: requireMcpRequest(ctx.callerContext),
			})
			const { savedPackage } = await findOwnedSavedPackage({
				db: ctx.env.APP_DB,
				userId: owner.ownerUserId,
				ownerScope: owner.ownerScope,
				args,
			})
			if (!savedPackage) {
				const missingId = args.package_id ?? args.kody_id
				throw new McpCallerError(`Saved package "${missingId}" was not found.`)
			}
			await authorize(
				{ env: ctx.env, request: ctx.callerContext.request },
				'package:execute',
				packageResource(savedPackage),
			)
			const loaded = await loadPackageManifestBySourceId({
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				userId: owner.ownerUserId,
				sourceId: savedPackage.sourceId,
			})
			const topic = args.topic.trim()
			const declared = listPackageSubscriptions(loaded.manifest).find(
				(subscription) => subscription.topic === topic,
			)
			if (!declared) {
				throw new McpCallerError(
					buildPackageSubscriptionNotFoundMessage({
						kodyId: savedPackage.kodyId,
						topic,
					}),
				)
			}
			let params: Record<string, unknown>
			let replayOf: string | null = null
			const idempotencyKey = buildFreshSyntheticSubscriptionIdempotencyKey()
			if (args.email_message_id !== undefined) {
				const message = await getInternalEmailMessageById({
					env: ctx.env,
					ownerId: owner.ownerUserId,
					messageId: args.email_message_id,
				})
				if (!message) {
					throw new McpCallerError(
						`Email message not found: ${args.email_message_id}`,
					)
				}
				const expectedTopic =
					message.classification === 'quarantined'
						? inboundEmailQuarantinedTopic
						: inboundEmailReceiptTopic
				if (topic !== expectedTopic) {
					throw new McpCallerError(
						`Email message "${args.email_message_id}" would dispatch on topic "${expectedTopic}", not "${topic}".`,
					)
				}
				const attachments = await listInternalEmailAttachmentsForMessage({
					env: ctx.env,
					ownerId: owner.ownerUserId,
					messageId: message.id,
				})
				params = {
					...buildEmailReceiptSubscriptionEnvelope({
						event: expectedTopic,
						message,
						attachments,
					}),
					synthetic: true,
					replay_of: args.email_message_id,
				}
				replayOf = args.email_message_id
			} else {
				const strippedParams = stripUntrustedSubscriptionEnvelopeFields(
					args.params ?? {},
				)
				params = {
					...strippedParams,
					synthetic: true,
				}
			}
			const response = await invokePackageSubscription({
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				savedPackage,
				topic,
				params,
				idempotencyKey,
				trustedSyntheticDispatch: trustedSyntheticSubscriptionDispatch,
				actorTokenId: internalSyntheticSubscriptionTokenId,
				request: inheritRequest(requireMcpRequest(ctx.callerContext)),
			})
			const retryableCode =
				readPreExecutionPackageInvocationInfrastructureCode(response)
			if (retryableCode) {
				throw new Error(
					`Retryable package invocation infrastructure response: ${retryableCode}.`,
				)
			}
			const replayed =
				(response.body['idempotency'] as { replayed?: unknown } | undefined)
					?.replayed === true
			const succeeded = response.status >= 200 && response.status < 400
			const body = response.body as Record<string, unknown>
			return {
				package_id: savedPackage.id,
				kody_id: savedPackage.kodyId,
				slug: savedPackage.kodyId,
				topic,
				idempotency_key: idempotencyKey,
				source: 'synthetic' as const,
				synthetic: true as const,
				replay_of: replayOf,
				status: response.status,
				replayed,
				...(succeeded
					? { result: boundSyntheticSubscriptionResult(body['result']) }
					: { error: readInvocationError(response) }),
			}
		},
	},
)
