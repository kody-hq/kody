import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import {
	httpDestinationIncludesWebhookUrlPlaceholder,
	webhookUrlApplyHttpMethods,
	webhookUrlApplyPlaceholder,
	webhookUrlApplySecretPlaceholder,
	type WebhookUrlApplyDestination,
} from '#worker/webhooks/apply.ts'
import { applyWebhookUrlForUser } from '#worker/webhooks/service.ts'
import { requireWebhookApplyDestinationGrantOrPending } from '#worker/webhooks/apply-destination-approval.ts'
import {
	toAppliedWebhookCapability,
	webhookUrlApplyResultSchema,
} from './shared.ts'

const httpDestinationSchema = z
	.object({
		type: z.literal('http'),
		url: z
			.string()
			.min(1)
			.describe(
				`HTTPS registration endpoint. May include ${webhookUrlApplyPlaceholder} and ${webhookUrlApplySecretPlaceholder} for server-side injection.`,
			),
		method: z
			.enum(webhookUrlApplyHttpMethods)
			.optional()
			.describe('HTTP method. Defaults to POST.'),
		headers: z
			.record(z.string(), z.string())
			.optional()
			.describe(
				`Optional request headers. Values may include ${webhookUrlApplyPlaceholder} and ${webhookUrlApplySecretPlaceholder}.`,
			),
		body: z
			.string()
			.max(64_384)
			.optional()
			.describe(
				`Optional request body template. May include ${webhookUrlApplyPlaceholder} and ${webhookUrlApplySecretPlaceholder}.`,
			),
		integration: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Optional OAuth integration whose access token is sent as Authorization Bearer. Host must be allowed on the integration.',
			),
		secretName: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Optional host-approved secret sent as Authorization Bearer. Host must be approved for the destination URL.',
			),
	})
	.superRefine((destination, ctx) => {
		const url = destination.url.trim()
		if (!url.startsWith('https://')) {
			ctx.addIssue({
				code: 'custom',
				path: ['url'],
				message: 'Destination url must be https.',
			})
		}
		if (
			!httpDestinationIncludesWebhookUrlPlaceholder({
				url,
				headers: destination.headers,
				body: destination.body,
			})
		) {
			ctx.addIssue({
				code: 'custom',
				message: `Destination must include ${webhookUrlApplyPlaceholder} in url, headers, or body.`,
			})
		}
		if (destination.secretName && destination.integration) {
			ctx.addIssue({
				code: 'custom',
				message: 'Provide either integration or secretName, not both.',
			})
		}
		const hasAuthorizationHeader = Object.keys(destination.headers ?? {}).some(
			(name) => name.toLowerCase() === 'authorization',
		)
		const hasAuthSource = Boolean(
			destination.secretName?.trim() || destination.integration?.trim(),
		)
		if (hasAuthorizationHeader && hasAuthSource) {
			ctx.addIssue({
				code: 'custom',
				message:
					'Provide Authorization in headers, or secretName/integration, not both.',
			})
		}
		const method = (destination.method ?? 'POST').toUpperCase()
		if (method === 'GET' && (destination.body?.length ?? 0) > 0) {
			ctx.addIssue({
				code: 'custom',
				path: ['body'],
				message: 'Destination body is not allowed with GET.',
			})
		}
	})

export const webhookUrlApplyDestinationSchema = httpDestinationSchema

type HttpApplyDestinationInput = z.infer<typeof httpDestinationSchema>

const httpApplyInteractiveOnlyErrorMessage =
	'webhookUrlApply destination type "http" is only available from an interactive MCP agent flow after the owner explicitly approves the exact outbound destination. Package jobs, subscriptions, webhooks, and other package runtimes cannot register arbitrary apply destinations.'

function assertInteractiveHttpApplyCaller(callerContext: {
	executionOrigin?: string
	storageContext?: {
		packageId?: string | null
		appId?: string | null
		storageId?: string | null
	} | null
}) {
	if (callerContext.executionOrigin !== 'interactive') {
		throw new McpCallerError(httpApplyInteractiveOnlyErrorMessage)
	}
	const storageContext = callerContext.storageContext
	const packageId = storageContext?.packageId?.trim() ?? ''
	const appId = storageContext?.appId?.trim() ?? ''
	const storageId = storageContext?.storageId?.trim() ?? ''
	if (packageId || appId || storageId) {
		throw new McpCallerError(httpApplyInteractiveOnlyErrorMessage)
	}
}

async function assertHttpApplyDestinationApproved(input: {
	env: Env
	userId: ReturnType<typeof ownerIdFromCaller>
	handle: string
	destination: HttpApplyDestinationInput
	baseUrl: string
}): Promise<{ credentialId: string | null }> {
	try {
		const gate = await requireWebhookApplyDestinationGrantOrPending({
			env: input.env,
			userId: input.userId,
			handle: input.handle,
			destination: input.destination,
			baseUrl: input.baseUrl,
		})
		if (gate.status === 'granted') {
			return { credentialId: gate.credentialId }
		}
		throw new McpCallerError(gate.message)
	} catch (error) {
		if (error instanceof McpCallerError) throw error
		throw new McpCallerError(
			error instanceof Error
				? error.message
				: 'Unable to check webhook apply approval.',
			{ cause: error },
		)
	}
}

function toApplyDestination(
	destination: z.infer<typeof webhookUrlApplyDestinationSchema>,
): WebhookUrlApplyDestination {
	return destination
}

export const webhookUrlApplyCapability = defineDomainCapability(
	capabilityDomainNames.webhooks,
	{
		name: 'webhookUrlApply',
		contextRuns: 'deny',
		orgPermission: 'package:write',
		description:
			'Register a minted webhook URL at an HTTPS destination without exposing the credential. Pass the handle from webhookUrlMint, webhookUrlRotate, or webhookList. Destination type http performs an outbound HTTPS request and substitutes {{webhookUrl}} (and optional {{webhookSecret}} — package-owned HMAC from the webhook URL record, or a verification.secretName copied onto that record at mint or rotate) server-side into url/headers/body — interactive MCP only, and only after the owner Approves the exact destination via the same account approval flow as /connect/secrets host approval (approval_url → website Allow → durable grant → retry). Package-owned HMAC is not a user secrets-list entry and never needs a secret→host Allow; destination.secretName Bearer auth does. For GitHub repository hooks, POST https://api.github.com/repos/{owner}/{repo}/hooks with User-Agent kody, {{webhookUrl}} in config.url, {{webhookSecret}} in config.secret when HMAC is declared (omit verification.secretName so mint stores package-owned HMAC), and integration "github" (or a host-approved token). Returns ok, remote_id, and url_host only — never the credential URL or signing secret.',
		keywords: [
			'webhook',
			'apply',
			'register',
			'github',
			'http',
			'handle',
			'destination',
			'approval',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			handle: z
				.string()
				.min(1)
				.describe(
					'Opaque handle from webhookUrlMint, webhookUrlRotate, or webhookList.',
				),
			destination: webhookUrlApplyDestinationSchema,
		}),
		outputSchema: webhookUrlApplyResultSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			assertInteractiveHttpApplyCaller(ctx.callerContext)
			const userId = ownerIdFromCaller(ctx.callerContext)
			const approved = await assertHttpApplyDestinationApproved({
				env: ctx.env,
				userId,
				handle: args.handle,
				destination: args.destination,
				baseUrl: ctx.callerContext.baseUrl,
			})
			const applied = await applyWebhookUrlForUser({
				env: ctx.env,
				request: requireMcpRequest(ctx.callerContext),
				userId,
				email: user.email,
				username: user.username,
				handle: args.handle,
				destination: toApplyDestination(args.destination),
				requestUrl: ctx.callerContext.baseUrl,
				waitUntil: ctx.waitUntil,
				expectedAuthCredentialId: approved.credentialId,
			})
			return toAppliedWebhookCapability(applied)
		},
	},
)
