import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { authorize, packageResource } from '#worker/authorization/authorize.ts'
import { resolveSavedPackage } from '#worker/package-invocations/module-artifacts.ts'
import { listRunRecords } from '#worker/run-records/service.ts'
import { type RunRecord } from '#worker/run-records/types.ts'
import { getWebhookEndpointByKey } from '#worker/webhooks/repo.ts'
import {
	requirePackageRef,
	toDeliveryCapability,
	webhookDeliverySchema,
	webhookPackageRefSchema,
} from './shared.ts'

const webhookOutcomeValues = ['delivered', 'rejected', 'failed'] as const

function metadataString(
	metadata: Record<string, unknown>,
	keys: Array<string>,
): string | null {
	for (const key of keys) {
		const value = metadata[key]
		if (typeof value === 'string' && value.length > 0) return value
	}
	return null
}

function metadataNumber(
	metadata: Record<string, unknown>,
	keys: Array<string>,
): number | null {
	for (const key of keys) {
		const value = metadata[key]
		if (typeof value === 'number' && Number.isFinite(value)) return value
	}
	return null
}

function metadataOutcome(
	metadata: Record<string, unknown>,
): (typeof webhookOutcomeValues)[number] | null {
	const raw = metadataString(metadata, ['outcome'])
	if (raw === 'delivered' || raw === 'rejected' || raw === 'failed') {
		return raw
	}
	return null
}

function deliveryOutcome(
	run: RunRecord,
): (typeof webhookOutcomeValues)[number] {
	const explicit = metadataOutcome(run.metadata)
	if (explicit) return explicit
	return 'failed'
}

function toDeliveryFromRunRecord(run: RunRecord) {
	const outcome = deliveryOutcome(run)
	const httpStatus =
		metadataNumber(run.metadata, ['http_status', 'httpStatus']) ??
		(outcome === 'delivered' ? 202 : outcome === 'rejected' ? 400 : 502)
	const payloadBytes =
		metadataNumber(run.metadata, ['payload_bytes', 'payloadBytes']) ?? 0
	const webhookName =
		run.name ??
		metadataString(run.metadata, ['webhook_name', 'webhookName']) ??
		''
	const error =
		metadataString(run.metadata, ['error']) ?? run.errorMessage ?? null
	return toDeliveryCapability({
		id: run.id,
		packageId: run.packageId ?? '',
		webhookName,
		receivedAt: run.startedAt,
		outcome,
		httpStatus,
		error,
		payloadBytes,
	})
}

export const webhookDeliveryListCapability = defineDomainCapability(
	capabilityDomainNames.webhooks,
	{
		name: 'webhookDeliveryList',
		contextRuns: 'allow',
		orgPermission: 'package:read',
		description:
			'List recent inbound webhook deliveries for one minted package webhook from run records (metadata only; payload bodies are never stored).',
		keywords: ['webhook', 'delivery', 'log', 'debug', 'history', 'runs'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z
			.object({
				...webhookPackageRefSchema,
				webhookName: z.string().min(1),
				limit: z.number().int().min(1).max(50).optional(),
			})
			.superRefine((input, ctx) => {
				try {
					requirePackageRef(input)
				} catch (error) {
					ctx.addIssue({
						code: 'custom',
						path: ['packageId'],
						message:
							error instanceof Error ? error.message : 'Invalid package ref.',
					})
				}
			}),
		outputSchema: z.object({
			deliveries: z.array(webhookDeliverySchema),
		}),
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			const webhookName = args.webhookName.trim()
			const packageIdOrKodyId = (args.packageId ?? args.kodyId ?? '').trim()
			const savedPackage = await resolveSavedPackage({
				db: ctx.env.APP_DB,
				userId: ownerIdFromCaller(ctx.callerContext),
				packageIdOrKodyId,
			})
			if (!savedPackage) {
				throw new McpCallerError(
					`Saved package "${packageIdOrKodyId}" was not found for this user.`,
				)
			}
			await authorize(
				{ env: ctx.env, request: ctx.callerContext.request },
				'package:read',
				packageResource(savedPackage),
			)
			const mint = await getWebhookEndpointByKey({
				db: ctx.env.APP_DB,
				userId: ownerIdFromCaller(ctx.callerContext),
				packageId: savedPackage.id,
				webhookName,
			})
			if (!mint) {
				throw new McpCallerError(
					'Webhook URL has not been minted. Call webhookUrlMint first.',
				)
			}
			const limit = args.limit ?? 25
			const page = await listRunRecords({
				env: ctx.env,
				userId: ownerIdFromCaller(ctx.callerContext),
				filter: {
					surface: 'webhook',
					packageId: savedPackage.id,
					name: webhookName,
				},
				limit,
			})
			const deliveries = page.runs.map(toDeliveryFromRunRecord)
			return { deliveries }
		},
	},
)
