import { z } from 'zod'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	buildKodyToolContext,
	createWorkflowTools,
} from '#mcp/run-kody-registry.ts'
import { type CredentialClientToolOptions } from '#mcp/runtime-helper-manifest.ts'
import {
	createExecutionSecretRedactor,
	type ExecutionSecretRedactor,
	trackSecretValueForms,
} from '#mcp/secrets/execution-secret-redactor.ts'
import {
	credentialCallMapSchema,
	normalizeCredentialCallMap,
	type CredentialCallMap,
} from '#worker/credentials/credential-call-map.ts'
import {
	CredentialClientError,
	loadRunCredentialNeedEntries,
	toCredentialClientError,
	type RunCredentialEntries,
} from '#worker/credentials/credential-client.ts'
import { capabilityProxyCredentialClientBinding } from '#worker/credentials/credential-client-handle.ts'
import {
	isLocalExecutePackageBindingToken,
	verifyLocalExecutePackageBindingClaims,
} from '#worker/package-runtime/local-execute-package-binding.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	toCapabilityOpenApiPrincipal,
	type ApiInvocationContext,
} from './context.ts'
import { ApiError, invalidRequest, notFound, toApiError } from './errors.ts'
import { maxApiRequestBodyBytes } from './request-params.ts'
import { runCapabilityProxyAuthenticatedFetch } from './capability-proxy-authenticated-fetch.ts'
import { runCapabilityProxyGatewayFetch } from './capability-proxy-gateway-fetch.ts'
import { runCapabilityProxyOauthClientCredentials } from './capability-proxy-oauth-client-credentials.ts'
import {
	authorizeLocalExecutePackageBinding,
	createCapabilityProxyPackageHostTools,
} from './capability-proxy-package-grants.ts'

/**
 * CapabilityProxy: the cloud half of local execute (`kody execute --local`,
 * `@kodycodes/cli`). The CLI runs modules in a local workerd and forwards every
 * `kody:runtime` call here as `{ path, args }`; this dispatches it through the
 * same `kody.*` tool map ad hoc cloud execute builds, so capabilities,
 * `kody.mcp`, and `workflows.create` behave as they do in the cloud. Static
 * `kody:@…` imports are downloaded via `POST /v1/local-execute/package-graph`
 * and embedded in that workerd — never a silent whole-module hop to
 * `kody.execute`. Local CPU is never metered; each hop is one `api_call`, and
 * the capability behind it meters itself as usual.
 *
 * Authenticated outbound fetch uses `kody.authenticatedFetch` (placeholder +
 * fetch-gateway on origin). Secret-bearing ambient `fetch` uses
 * `kody.gatewayFetch` the same way. OAuth client-credentials grants use
 * `kody.oauthClientCredentials`. Stamped `packageStorage` / `packageSecrets`
 * hop as `kody.packageStorage*` / `kody.packageSecret*` with per-call
 * ownership checks — long-lived OAuth tokens and secret
 * plaintext never enter local workerd.
 */

export const capabilityProxyLimits = {
	maxPathSegments: 8,
	maxPathSegmentLength: 200,
	maxArgs: 8,
	maxRequestBytes: maxApiRequestBodyBytes,
} as const

/** Feature flags in the session response, for clients to detect host support. */
export const capabilityProxyFeatures = ['credential-call-map'] as const

const pathSegmentSchema = z
	.string()
	.min(1)
	.max(capabilityProxyLimits.maxPathSegmentLength)

export const capabilityProxyCallInputSchema = z
	.object({
		path: z
			.array(pathSegmentSchema)
			.min(2)
			.max(capabilityProxyLimits.maxPathSegments)
			.describe(
				"`kody:runtime` property path, e.g. `['kody','emailSend']`, `['kody','mcp','home','lights_on']`, or `['workflows','create']`.",
			),
		args: z
			.array(z.unknown())
			.max(capabilityProxyLimits.maxArgs)
			.describe('Positional arguments passed to the runtime function.'),
		conversationId: z
			.string()
			.min(1)
			.max(64)
			.optional()
			.describe('Optional MCP conversation id to attribute the call to.'),
		credentials: credentialCallMapSchema
			.optional()
			.describe(
				'Credential picks for this local run, by need key (CLI `--credential key=name`), read by `kody.credentialClient*` calls. Same shape as `execute` `credentials`. Picks choose only among credentials you can Use.',
			),
	})
	.strict()

export type CapabilityProxyCallInput = z.infer<
	typeof capabilityProxyCallInputSchema
>

export const capabilityProxyCallOutputSchema = z.object({
	result: z.unknown().describe('Return value of the runtime call (JSON).'),
})

export const capabilityProxySessionOutputSchema = z.object({
	scopes: z.array(z.string()),
	expiresAt: z
		.string()
		.describe('Sliding expiry; every proxied call pushes it forward.'),
	maxExpiresAt: z.string().describe('Absolute expiry of the token.'),
	idleTtlSeconds: z.number().int(),
	user: z.object({ userId: z.string(), email: z.string() }),
	features: z
		.array(z.string())
		.describe(
			'Optional host features this proxy serves, e.g. `credential-call-map` (the `credentials` call field and `kody.credentialClientCheck`).',
		),
	limits: z.object({
		maxPathSegments: z.number().int(),
		maxArgs: z.number().int(),
		maxRequestBytes: z.number().int(),
	}),
})

export function capabilityProxyUsageEntityId(params: unknown) {
	const parsed = capabilityProxyCallInputSchema.safeParse(params)
	return parsed.success
		? `capability-proxy:${parsed.data.path.join('.')}`.slice(0, 200)
		: 'capability-proxy:invalid'
}

function describePath(path: ReadonlyArray<string>) {
	return path.join('.')
}

class CapabilityInvocationError extends Error {
	constructor(cause: unknown) {
		super('Capability invocation failed.', { cause })
		this.name = 'CapabilityInvocationError'
	}
}

async function invokeCapability<T>(invoke: () => Promise<T> | T) {
	try {
		return await invoke()
	} catch (error) {
		throw new CapabilityInvocationError(error)
	}
}

/**
 * Local execute has no host run, so handles bind to the CapabilityProxy
 * credential instead. A package stamp from local workerd is the package
 * graph's signed binding, and stays a claim until `package:execute` on it
 * holds. A bare package id is refused.
 */
export function createCapabilityProxyCredentialClientTools(
	ctx: ApiInvocationContext,
	callMap: CredentialCallMap | null,
): CredentialClientToolOptions | undefined {
	const request = ctx.callerContext.request
	if (!request) return undefined
	const runEntriesByKey = new Map<string, Promise<RunCredentialEntries>>()
	return {
		binding: capabilityProxyCredentialClientBinding(request),
		callMap,
		resolvePackageId: async (requested) => {
			const packageId = typeof requested === 'string' ? requested.trim() : ''
			if (!packageId) return null
			try {
				return await authorizeLocalExecutePackageBinding({
					db: ctx.env.APP_DB,
					env: ctx.env,
					request,
					orgUserId: ownerIdFromCaller(ctx.callerContext),
					packageBinding: packageId,
				})
			} catch (error) {
				throw (
					toCredentialClientError(error) ??
					new CredentialClientError({
						code: 'credential_denied',
						message: 'This package is not one you can execute here.',
						retryWith: [],
					})
				)
			}
		},
		// Entries come only from the verified binding the call claims;
		// `resolvePackageId` has already checked `package:execute` on it.
		runEntries: async (requested) => {
			if (!isLocalExecutePackageBindingToken(requested)) return null
			const { entryPackageIds } = await verifyLocalExecutePackageBindingClaims({
				env: ctx.env,
				token: requested,
				subject: {
					org: ownerIdFromCaller(ctx.callerContext),
					actor: request.actor?.userId ?? null,
				},
			}).catch(() => ({ entryPackageIds: [] as Array<string> }))
			if (entryPackageIds.length === 0) return null
			const cacheKey = entryPackageIds.join('\n')
			let entries = runEntriesByKey.get(cacheKey)
			if (!entries) {
				entries = loadRunCredentialNeedEntries({
					env: ctx.env,
					orgId: request.org.id,
					packageIds: entryPackageIds,
					request,
				}).then((loaded) => loaded.entries)
				runEntriesByKey.set(cacheKey, entries)
			}
			return await entries
		},
		...(ctx.waitUntil ? { waitUntil: ctx.waitUntil } : {}),
	}
}

async function callKodyPath(input: {
	ctx: ApiInvocationContext
	path: ReadonlyArray<string>
	args: ReadonlyArray<unknown>
	redactor: ExecutionSecretRedactor
	callMap: CredentialCallMap | null
}) {
	const { ctx, path, args, redactor, callMap } = input
	const [, name] = path
	if (path.length === 2 && name === 'authenticatedFetch') {
		return invokeCapability(() =>
			runCapabilityProxyAuthenticatedFetch({ ctx, args }),
		)
	}
	if (path.length === 2 && name === 'gatewayFetch') {
		return invokeCapability(() => runCapabilityProxyGatewayFetch({ ctx, args }))
	}
	if (path.length === 2 && name === 'oauthClientCredentials') {
		return invokeCapability(() =>
			runCapabilityProxyOauthClientCredentials({
				ctx,
				args,
				trackAccessToken: (accessToken) =>
					trackSecretValueForms((value) => redactor.track(value), accessToken),
			}),
		)
	}
	const needsPackageHostTools =
		typeof name === 'string' &&
		(name.startsWith('packageStorage') || name.startsWith('packageSecret'))
	const packageHostTools = needsPackageHostTools
		? await createCapabilityProxyPackageHostTools({
				env: ctx.env,
				callerContext: ctx.callerContext,
			})
		: {}
	const credentialClientTools =
		typeof name === 'string' && name.startsWith('credentialClient')
			? createCapabilityProxyCredentialClientTools(ctx, callMap)
			: undefined
	const { tools, mcpServers } = await buildKodyToolContext(
		ctx.env,
		ctx.callerContext,
		{
			trackSecretInputValue: (value) => redactor.track(value),
			additionalTools: packageHostTools,
			workflowTools: createWorkflowTools({
				env: ctx.env,
				callerContext: ctx.callerContext,
				packageContext: null,
			}),
			openApiPrincipal: toCapabilityOpenApiPrincipal(ctx.principal),
			localExecuteHop: true,
			...(ctx.waitUntil ? { waitUntil: ctx.waitUntil } : {}),
			...(credentialClientTools ? { credentialClientTools } : {}),
		},
	)
	if (path[1] === 'mcp') {
		const [, , serverName, toolName] = path
		if (path.length !== 4 || !serverName || !toolName) {
			throw notFound(
				`kody.mcp calls must look like kody.mcp.<server>.<tool>(args); got ${describePath(path)}.`,
			)
		}
		const server = mcpServers.find((entry) => entry.name === serverName)
		if (!server) {
			throw notFound(
				`Unknown MCP server "${serverName}". Available MCP servers: ${
					mcpServers.map((entry) => entry.name).join(', ') || '(none)'
				}.`,
			)
		}
		if (!server.status.connected || server.status.toolCount === 0) {
			throw invalidRequest(server.status.unavailableMessage)
		}
		const capability = server.capabilities.find(
			(entry) => entry.name === toolName,
		)
		// tools map is keyed by raw capability.name (`mcp:server:tool`). Cloud
		// ToolDispatcher indexes by sanitizeToolName (dispatchName); looking up
		// dispatchName here misses colon-bearing keys and throws Unknown tool
		// while still listing the short name as available (#2949).
		const toolKey = `mcp:${serverName}:${toolName}`
		const tool = capability ? tools[toolKey] : undefined
		if (!tool) {
			throw notFound(
				`Unknown tool "${toolName}" for MCP server "${serverName}". Available tools: ${
					server.capabilities.map((entry) => entry.name).join(', ') || '(none)'
				}.`,
			)
		}
		return invokeCapability(() => tool(args[0]))
	}
	const tool = name && Object.hasOwn(tools, name) ? tools[name] : undefined
	if (path.length !== 2 || !tool) {
		throw notFound(`Unknown runtime function kody.${path.slice(1).join('.')}.`)
	}
	return invokeCapability(() => tool(args[0]))
}

async function dispatchCapabilityProxyCall(input: {
	ctx: ApiInvocationContext
	call: CapabilityProxyCallInput
	redactor: ExecutionSecretRedactor
}) {
	const { ctx, call, redactor } = input
	const [root, name] = call.path
	if (root === 'kody') {
		return callKodyPath({
			ctx,
			path: call.path,
			args: call.args,
			redactor,
			callMap: normalizeCredentialCallMap(call.credentials),
		})
	}
	if (root === 'workflows' && name === 'create' && call.path.length === 2) {
		const workflowTools = createWorkflowTools({
			env: ctx.env,
			callerContext: ctx.callerContext,
			packageContext: null,
		})
		return invokeCapability(() => workflowTools.create(call.args[0] as never))
	}
	throw notFound(
		`Unknown runtime path ${describePath(call.path)}. CapabilityProxy serves kody.*, kody.authenticatedFetch, kody.gatewayFetch, kody.oauthClientCredentials, kody.mcp.<server>.<tool>, kody.packageStorage* / kody.packageSecret*, and workflows.create.`,
	)
}

/**
 * Run one proxied `kody:runtime` call. Errors the capability throws reach
 * local user code with the message cloud execute would show, minus secret
 * values the call wrote and API tokens. Platform failures outside the
 * capability return the generic internal error and are logged here.
 */
export async function runCapabilityProxyCall(input: {
	ctx: ApiInvocationContext
	call: CapabilityProxyCallInput
}) {
	const redactor = createExecutionSecretRedactor()
	try {
		return {
			result:
				(await dispatchCapabilityProxyCall({ ...input, redactor })) ?? null,
		}
	} catch (error) {
		const fromCapability = error instanceof CapabilityInvocationError
		const cause = fromCapability ? error.cause : error
		const apiError = toApiError(cause)
		if (
			cause instanceof ApiError ||
			apiError.status < 500 ||
			// Transient Artifacts git (and similar) already mapped to sanitized
			// 503 internal_error — keep that envelope instead of capability_error.
			(apiError.status === 503 && apiError.code === 'internal_error')
		) {
			throwRedacted(apiError, redactor)
		}
		if (fromCapability) {
			throw new ApiError({
				status: 500,
				code: 'capability_error',
				message: redactor.redactErrorMessage(getErrorMessage(cause)),
			})
		}
		console.error('capability-proxy platform failure', {
			path: describePath(input.call.path),
			userId: input.ctx.callerContext.user?.userId ?? null,
			error: redactor.redactErrorMessage(getErrorMessage(cause)),
		})
		throw apiError
	}
}

function throwRedacted(
	apiError: ApiError,
	redactor: ExecutionSecretRedactor,
): never {
	const message = redactor.redactErrorMessage(apiError.message)
	if (message === apiError.message) throw apiError
	throw new ApiError({
		status: apiError.status,
		code: apiError.code,
		message,
		details: redactor.redactUnknown(apiError.details),
		headers: apiError.headers,
		cause: apiError,
	})
}
