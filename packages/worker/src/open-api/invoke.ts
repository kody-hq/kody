import { isRecord } from '@kody-internal/shared/is-record.ts'
import { callerCanAccessCapability } from '#mcp/capabilities/access-control.ts'
import { getStaticRegistry } from '#mcp/capabilities/registry.ts'
import { type Capability } from '#mcp/capabilities/types.ts'
import { authorizeSurface } from '#worker/authorization/authorize.ts'
import {
	recordUsage,
	usageAttributionFieldsFromRequest,
} from '#worker/usage/record-usage.ts'
import {
	toCapabilityOpenApiPrincipal,
	type ApiInvocationContext,
} from './context.ts'
import { ApiError, invalidRequest, notFound, toApiError } from './errors.ts'
import {
	apiOperationsById,
	type ApiOperation,
	type CapabilityApiOperation,
	capabilityNameForOperation,
} from './operations.ts'
import { nativeApiOperationDefinitions } from './native-operations.ts'

/**
 * CapabilityProxy native routes (`org:execute`). Their observe-only
 * `api_call` events append the ApiError `code` to `entityId` on failure so
 * session start vs `unauthorized` / hop errors stay distinguishable in
 * Analytics Engine without a new UsageEventType.
 */
export function isCapabilityProxyOperation(operation: ApiOperation): boolean {
	return operation.kind === 'native' && operation.tag === 'capability-proxy'
}

/**
 * CLI `kody login` OAuth is a bearer only long enough to mint a device
 * `kody_at_` (and on the pre-existing local-execute routes, so older CLIs
 * keep working). Every other Open API route stays `kody_at_`-only.
 */
export function operationAllowsCliOauth(operation: ApiOperation): boolean {
	return (
		isCapabilityProxyOperation(operation) ||
		(operation.kind === 'native' &&
			operation.operationId === 'cliLoginDeviceToken')
	)
}

/** Code-authenticated CLI redeem — no Bearer (ADR 0056). */
export function isCliCredentialBootstrapRedeemOperation(
	operation: ApiOperation,
): boolean {
	return (
		operation.kind === 'native' &&
		operation.operationId === 'cliCredentialBootstrapRedeem'
	)
}

/** Analytics Engine blob length bound for observation entity ids. */
export const capabilityProxyObservationEntityIdMaxLength = 200

export function capabilityProxyObservationEntityId(input: {
	baseEntityId: string
	outcome: 'success' | 'error'
	failureCode?: string | null
}): string {
	const maxLength = capabilityProxyObservationEntityIdMaxLength
	if (input.outcome === 'success' || !input.failureCode) {
		return input.baseEntityId.slice(0, maxLength)
	}
	// Reserve `:${failureCode}` before truncating the base so a maximal-length
	// path id cannot erase the failure code operators use to distinguish hops.
	const suffix = `:${input.failureCode}`
	const maxBaseLength = Math.max(0, maxLength - suffix.length)
	return `${input.baseEntityId.slice(0, maxBaseLength)}${suffix}`
}

async function resolveCapability(operation: CapabilityApiOperation) {
	const registry = await getStaticRegistry()
	const capabilityName = capabilityNameForOperation(operation)
	const capability = registry.capabilityMap[capabilityName]
	if (!capability) {
		throw new ApiError({
			status: 500,
			code: 'internal_error',
			message: `Operation "${operation.operationId}" has no capability "${capabilityName}".`,
		})
	}
	return capability
}

async function assertCapabilityAvailable(
	ctx: ApiInvocationContext,
	capability: Capability,
) {
	const featureFlags = capability.featureFlag
		? await ctx.getFeatureFlags()
		: null
	if (callerCanAccessCapability(ctx.callerContext, capability, featureFlags)) {
		return
	}
	throw new ApiError({
		status: 404,
		code: 'feature_unavailable',
		message: `Operation "${capability.name}" is not available for this account.`,
		...(capability.featureFlag
			? { details: { feature_flag: capability.featureFlag } }
			: {}),
	})
}

export function getApiOperation(operationId: string): ApiOperation {
	const operation = apiOperationsById.get(operationId)
	if (!operation) {
		throw notFound(
			`Unknown operationId "${operationId}". Operation ids are listed in /openapi.json and match Kody capability names (plus token operations such as tokenCreate).`,
		)
	}
	return operation
}

async function dispatch(input: {
	operation: ApiOperation
	params: Record<string, unknown>
	ctx: ApiInvocationContext
}) {
	const { operation, params, ctx } = input
	switch (operation.kind) {
		case 'native': {
			await authorizeSurface(
				{ env: ctx.env, request: ctx.callerContext.request },
				operation.permission,
			)
			return nativeApiOperationDefinitions[operation.operationId].handler(
				params,
				ctx,
			)
		}
		case 'capability': {
			const capability = await resolveCapability(operation)
			await assertCapabilityAvailable(ctx, capability)
			const capabilityParams = operation.deprecatedForward
				? { ...params, ...operation.deprecatedForward.fixedInputs }
				: params
			const result = await capability.handler(capabilityParams, {
				env: ctx.env,
				callerContext: ctx.callerContext,
				openApiPrincipal: toCapabilityOpenApiPrincipal(ctx.principal),
				...(ctx.waitUntil ? { waitUntil: ctx.waitUntil } : {}),
			})
			if (!operation.deprecatedForward || !isRecord(result)) return result
			const fixedInputNames = new Set(
				Object.keys(operation.deprecatedForward.fixedInputs),
			)
			return Object.fromEntries(
				Object.entries(result).filter(([key]) => !fixedInputNames.has(key)),
			)
		}
		default: {
			const exhaustive: never = operation
			throw new Error(`Unhandled API operation: ${String(exhaustive)}`)
		}
	}
}

function resolveUsageEntityId(
	operation: ApiOperation,
	params: Record<string, unknown>,
) {
	if (operation.kind !== 'native') return operation.operationId
	const definition = nativeApiOperationDefinitions[operation.operationId]
	return definition.usageEntityId?.(params) ?? operation.operationId
}

/**
 * Run one Open API operation for an authenticated account. Shared by the
 * HTTP API (`api.kody.codes`) and the MCP `api` tool so both enforce the same
 * org permissions, feature flags, and metering. Throws `ApiError` on failure.
 */
export async function invokeApiOperation(input: {
	operationId: string
	params: unknown
	ctx: ApiInvocationContext
}): Promise<unknown> {
	const operation = getApiOperation(input.operationId)
	const params = input.params ?? {}
	if (!isRecord(params)) {
		throw invalidRequest('params must be a JSON object.')
	}
	const startedAt = Date.now()
	let outcome: 'success' | 'error' = 'error'
	let failureCode: string | null = null
	try {
		const result = await dispatch({ operation, params, ctx: input.ctx })
		outcome = 'success'
		return result
	} catch (error) {
		const apiError = toApiError(error)
		failureCode = apiError.code
		if (apiError.status >= 500 && !(error instanceof ApiError)) {
			console.error('open-api-operation-failed', operation.operationId, error)
		}
		throw apiError
	} finally {
		const baseEntityId = resolveUsageEntityId(operation, params)
		const entityId = isCapabilityProxyOperation(operation)
			? capabilityProxyObservationEntityId({
					baseEntityId,
					outcome,
					failureCode,
				})
			: baseEntityId
		const usage = recordUsage(
			input.ctx.env,
			{
				userId: input.ctx.callerContext.user.userId,
				eventType: 'api_call',
				entityId,
				durationMs: Date.now() - startedAt,
				outcome,
				...usageAttributionFieldsFromRequest(input.ctx.callerContext.request),
			},
			input.ctx.waitUntil ? { waitUntil: input.ctx.waitUntil } : undefined,
		)
		if (input.ctx.waitUntil) input.ctx.waitUntil(usage)
		else await usage
	}
}
