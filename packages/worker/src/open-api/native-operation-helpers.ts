import { type z } from 'zod'
import { type ApiInvocationContext, type ApiPrincipal } from './context.ts'
import { isCredentialedRuntimeCall } from '#worker/execution-contexts/credential-grant.ts'
import { ApiError, invalidRequest } from './errors.ts'

export type NativeApiOperationDefinition = {
	summary: string
	description: string
	inputSchema: z.ZodType
	outputSchema: z.ZodType
	readOnly: boolean
	handler: (params: unknown, ctx: ApiInvocationContext) => Promise<unknown>
	/** `api_call` entity id; defaults to the operationId. */
	usageEntityId?: (params: unknown) => string
}

export type LocalExecuteHttpPrincipal = Extract<
	ApiPrincipal,
	{ kind: 'token' } | { kind: 'mcp-oauth' } | { kind: 'execution-context-run' }
>

export function parseNativeInput<T extends z.ZodType>(
	schema: T,
	params: unknown,
) {
	const parsed = schema.safeParse(params ?? {})
	if (!parsed.success) {
		throw invalidRequest('Invalid parameters.', {
			issues: parsed.error.issues.map((issue) => ({
				path: issue.path.join('.'),
				message: issue.message,
			})),
		})
	}
	return parsed.data as z.infer<T>
}

export function requireTokenPrincipal(ctx: ApiInvocationContext) {
	if (ctx.principal.kind !== 'token') {
		throw invalidRequest(
			'This operation acts on the calling API token, so it is only available over HTTP with Authorization: Bearer kody_at_….',
		)
	}
	return ctx.principal.token
}

/**
 * CapabilityProxy and package-graph accept either a scoped `kody_at_` token
 * or CLI MCP OAuth (`mcp-oauth`). The MCP `api` tool principal is not used
 * on these HTTP routes.
 */
export function requireLocalExecuteHttpPrincipal(
	ctx: ApiInvocationContext,
): LocalExecuteHttpPrincipal {
	if (
		ctx.principal.kind === 'token' ||
		ctx.principal.kind === 'mcp-oauth' ||
		ctx.principal.kind === 'execution-context-run'
	) {
		return ctx.principal
	}
	throw invalidRequest(
		'Local execute HTTP routes require Authorization: Bearer with a kody_at_ API token or a kody login OAuth access token.',
	)
}

/**
 * A context run may only call the Kody runtime paths its context's grant
 * allows (`grant.runtime`). Other principals are not narrowed here.
 */
export function assertContextRunRuntimePathAllowed(
	ctx: ApiInvocationContext,
	path: ReadonlyArray<string>,
) {
	if (ctx.principal.kind !== 'execution-context-run') return
	const { runtime } = ctx.principal
	if (runtime.mode === 'all') return
	// Host commands have their own grant (execution_context:command, ADR 0093).
	if (path[0] === 'kody' && path[1] === 'command') return
	const joined = path.join('.')
	if (runtime.paths.includes(joined)) return
	throw new ApiError({
		status: 403,
		code: 'insufficient_scope',
		message: `This execution context's grant does not allow ${joined}. Its operator can allow it in the context's local policy (runtime allowlist).`,
		details: { reason: 'context_runtime', path: joined },
	})
}

/**
 * Runtime paths with special handling on a context run: the operator's own
 * runs start workflows and use credentials as in Kody cloud; anyone else's
 * do neither. Credential values still never leave Kody cloud.
 */
export function assertContextRunSpecialPathAllowed(
	ctx: ApiInvocationContext,
	path: ReadonlyArray<string>,
) {
	if (ctx.principal.kind !== 'execution-context-run') return
	const [root, name] = path
	if (root === 'workflows' && !ctx.principal.byOperator) {
		throw new ApiError({
			status: 403,
			code: 'insufficient_scope',
			message:
				"Only this execution context's operator can start workflows from runs on it. Start the workflow from Kody cloud, or from a context you operate.",
			details: { reason: 'context_denied', path: path.join('.') },
		})
	}
	const credentialed =
		root === 'kody' &&
		typeof name === 'string' &&
		isCredentialedRuntimeCall(name)
	if (!credentialed) return
	if (ctx.principal.credentials === 'requester') return
	throw new ApiError({
		status: 403,
		code: 'execution_context_credential_not_granted',
		message: `Only this execution context's operator can use credentials in runs on it, so kody.${name} cannot run here. Run this on Kody cloud, or on a context you operate.`,
		details: { path: path.join('.'), reason: 'context_operator_only' },
	})
}
