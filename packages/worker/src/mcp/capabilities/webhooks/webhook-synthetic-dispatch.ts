import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { requireInteractiveMcpCaller } from '#mcp/capabilities/meta/require-interactive-caller.ts'
import { dispatchSyntheticWebhookForUser } from '#worker/webhooks/service.ts'
import { webhookSyntheticDispatchCapabilityName } from '#worker/webhooks/synthetic.ts'
import { requirePackageRef, webhookPackageRefSchema } from './shared.ts'

const packageRuntimeCallerErrorMessage = `${webhookSyntheticDispatchCapabilityName} is unavailable from package runtime contexts. It is the interactive-MCP post-publish webhook smoke test. Compose another package with a static kody:@scope/pkg/export import.`

const requestFixtureSchema = z
	.object({
		method: z.string().min(1).optional(),
		headers: z.record(z.string(), z.string()).optional(),
		body: z.string().optional(),
		json: z.unknown().optional(),
		contentType: z.string().optional(),
	})
	.describe(
		'Fixture for inputMode "request": method/headers/body/json the export normally sees. Platform builds { webhook, request, synthetic: true }. Not a package dryRun flag.',
	)

export const webhookSyntheticDispatchCapability = defineDomainCapability(
	capabilityDomainNames.webhooks,
	{
		name: webhookSyntheticDispatchCapabilityName,
		contextRuns: 'deny',
		orgPermission: 'package:execute',
		description:
			'Interactive-MCP post-publish smoke test for one minted package.json#kody.webhooks export. Skips public URL and HMAC, invokes the bound export with a caller fixture, marks the Activity webhook run synthetic: true, and counts against automation usage like a normal delivery. Side effects are real. Unavailable from package jobs, subscriptions, webhooks, or other package runtimes. Does not return url or url_secret. Distinct from any package-local dryRun field on trusted-client POSTs.',
		keywords: [
			'webhook',
			'synthetic',
			'dispatch',
			'smoke',
			'test',
			'fixture',
			'interactive',
			'post-publish',
			'verification',
			'simulate',
			'probe',
			'debug',
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z
			.object({
				...webhookPackageRefSchema,
				webhookName: z
					.string()
					.min(1)
					.describe('Webhook name from package.json#kody.webhooks[].name.'),
				request: requestFixtureSchema.optional(),
				params: z
					.record(z.string(), z.unknown())
					.optional()
					.describe(
						'Fixture for inputMode "params": first-arg object (sibling fields like route/dryRun preserved). Caller-supplied synthetic is ignored; platform sets synthetic: true. Distinct from package-local dryRun.',
					),
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
				const hasRequest = input.request !== undefined
				const hasParams = input.params !== undefined
				if (hasRequest === hasParams) {
					ctx.addIssue({
						code: 'custom',
						message:
							'Provide exactly one of `request` (inputMode request) or `params` (inputMode params).',
					})
				}
			}),
		outputSchema: z.object({
			package_id: z.string(),
			package_kody_id: z.string(),
			webhook_name: z.string(),
			input_mode: z.enum(['request', 'params']),
			synthetic: z.literal(true),
			status: z.number().int(),
			run_id: z.string(),
			idempotency_key: z.string(),
			result: z.unknown().optional(),
			error: z
				.object({
					code: z.string(),
					message: z.string(),
				})
				.optional(),
		}),
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			requireInteractiveMcpCaller(
				ctx.callerContext,
				packageRuntimeCallerErrorMessage,
			)
			const dispatched = await dispatchSyntheticWebhookForUser({
				env: ctx.env,
				requestContext: requireMcpRequest(ctx.callerContext),
				userId: ownerIdFromCaller(ctx.callerContext),
				baseUrl: ctx.callerContext.baseUrl,
				packageId: args.packageId,
				kodyId: args.kodyId,
				webhookName: args.webhookName,
				request: args.request,
				params: args.params,
			})
			return {
				package_id: dispatched.packageId,
				package_kody_id: dispatched.packageKodyId,
				webhook_name: dispatched.webhookName,
				input_mode: dispatched.inputMode,
				synthetic: true as const,
				status: dispatched.status,
				run_id: dispatched.runId,
				idempotency_key: dispatched.idempotencyKey,
				...(dispatched.error
					? { error: dispatched.error }
					: { result: dispatched.result }),
			}
		},
	},
)
