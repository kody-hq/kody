import { type createMcpCallerContext } from '#mcp/context.ts'
import { type AutomationRouting } from '#worker/execution-contexts/automation-execution.ts'
import { type AutomationExecutionTarget } from '#worker/execution-contexts/automation-settings.ts'
import { type RequestSource } from '#worker/request-context/request-context.ts'
import { type EnablementAudience } from '#worker/enablements/run-gate.ts'
import { type PackageEventTools } from '#mcp/run-kody-registry.ts'
import {
	type RunRecordContext,
	type RunRecordHandle,
} from '#worker/run-records/types.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	normalizeExportName,
	packageInvocationScopeWildcard,
	type PackageInvocationRequest,
	type PackageInvocationResponse,
	type PackageInvocationTokenScope,
	type PackageRuntimeContext,
	type PackageRuntimeToolFactories,
	type PackageSourceRevisionOptions,
} from './common.ts'
import { invokePackageExportWithToolFactories } from './http-invoke.ts'
import { type PackageEventsDispatchQueueMessage } from '#worker/package-events/dispatch-queue-producer.ts'
import {
	createPackageEventToolsWithToolFactories,
	deliverPackageEventWithToolFactories,
	invokePackageSubscriptionWithToolFactories,
	type SubscriptionInvocationInput,
} from './subscription-dispatch.ts'
import { type TrustedSyntheticSubscriptionDispatch } from './subscription-envelope.ts'

export {
	normalizeExportName,
	packageInvocationScopeWildcard,
	type PackageInvocationRequest,
	type PackageInvocationResponse,
	type PackageInvocationTokenScope,
}

const packageRuntimeToolFactories: PackageRuntimeToolFactories = {
	createPackageEventTools(input) {
		return createPackageEventToolsWithToolFactories({
			...input,
			toolFactories: packageRuntimeToolFactories,
		})
	},
}

export function createPackageEventTools(input: {
	env: Env
	baseUrl: string
	callerContext: ReturnType<typeof createMcpCallerContext>
	packageContext: PackageRuntimeContext | null
	parentRunRecord?: RunRecordContext | null
	packageInvokeDepth?: number
	waitUntil?: (promise: Promise<unknown>) => void
}): PackageEventTools {
	return createPackageEventToolsWithToolFactories({
		...input,
		toolFactories: packageRuntimeToolFactories,
	})
}

export async function invokePackageExport(input: {
	env: Env
	baseUrl: string
	token: PackageInvocationTokenScope
	request: PackageInvocationRequest
	runtimeInvokeDepth?: number
	waitUntil?: (promise: Promise<unknown>) => void
	/**
	 * Skip the idempotency ledger and run key-less. Required for Cloudflare
	 * Workflow step retries: reusing a keyed timeout/error would replay the
	 * failure in milliseconds instead of re-executing.
	 */
	ephemeral?: boolean
	/** Sandbox wall-clock budget; omit for the default ~90s export cap. */
	executorTimeoutMs?: number | null
	/** Inbound request abort. Caller disconnect finishes the keyed run. */
	signal?: AbortSignal
	/** Report, and optionally pin, the commit the invoke resolves. */
	sourceRevision?: PackageSourceRevisionOptions | null
	/** Where an automation asked to run (execution contexts). */
	executionRouting?: AutomationRouting | null
	/** Caller-owned record (workflow step) that a context run hangs under. */
	parentRunHandle?: RunRecordHandle | null
	/** Declared automation whose execution setting applies. */
	executionTarget?: AutomationExecutionTarget | null
}): Promise<PackageInvocationResponse> {
	return await invokePackageExportWithToolFactories({
		...input,
		toolFactories: packageRuntimeToolFactories,
	})
}

export async function deliverPackageEvent(input: {
	env: Env
	baseUrl: string
	message: PackageEventsDispatchQueueMessage
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	return await deliverPackageEventWithToolFactories({
		...input,
		toolFactories: packageRuntimeToolFactories,
	})
}

export async function invokePackageSubscription(input: {
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
	audience?: EnablementAudience | null
	resourceEventDepth?: number
	paramsForRun?: SubscriptionInvocationInput['paramsForRun']
	inboundFromAddress?: string | null
	inboundFromAuthenticated?: boolean
	runtimeInvokeDepth?: number
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	return await invokePackageSubscriptionWithToolFactories({
		...input,
		toolFactories: packageRuntimeToolFactories,
	})
}
