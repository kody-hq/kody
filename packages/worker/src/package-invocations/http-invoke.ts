import { type RunRecordHandle } from '#worker/run-records/types.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { type AutomationRouting } from '#worker/execution-contexts/automation-execution.ts'
import { type AutomationExecutionTarget } from '#worker/execution-contexts/automation-settings.ts'
import {
	buildSavedPackageNotFoundMessage,
	normalizeExportName,
	normalizeNullableString,
	packageInvocationScopeWildcard,
	type PackageInvocationRequest,
	type PackageInvocationResponse,
	type PackageInvocationTokenScope,
	type PackageRuntimeToolFactories,
	type PackageSourceRevisionOptions,
} from './common.ts'
import { invokeSavedPackageModule } from './idempotent-module-invocation.ts'
import { runSavedPackageModuleEphemeral } from './module-execution.ts'
import { resolveSavedPackage } from './module-artifacts.ts'
import { buildJsonErrorResponse } from './responses.ts'
import {
	isSealedSecretProviderExport,
	sealedSecretProviderExportDeniedResponse,
} from '#mcp/secrets/secret-providers/sealed-export.ts'

function tokenAllowsPackage(input: {
	token: PackageInvocationTokenScope
	savedPackage: NonNullable<Awaited<ReturnType<typeof resolveSavedPackage>>>
}) {
	return input.token.packageId === input.savedPackage.id
}

function tokenAllowsExport(input: {
	token: PackageInvocationTokenScope
	exportName: string
}) {
	const exportNames = input.token.exportNames ?? []
	return exportNames.some(
		(entry) =>
			entry === packageInvocationScopeWildcard ||
			normalizeExportName(entry) === input.exportName,
	)
}

export async function invokePackageExportWithToolFactories(input: {
	env: Env
	baseUrl: string
	token: PackageInvocationTokenScope
	request: PackageInvocationRequest
	runtimeInvokeDepth?: number
	toolFactories: PackageRuntimeToolFactories
	waitUntil?: (promise: Promise<unknown>) => void
	/**
	 * Internal workflow runner: skip the idempotency ledger so Cloudflare
	 * Workflow step retries re-execute instead of replaying a cached timeout.
	 */
	ephemeral?: boolean
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
	const packageIdOrKodyId = input.request.packageIdOrKodyId.trim()
	if (!packageIdOrKodyId) {
		return buildJsonErrorResponse({
			status: 400,
			code: 'invalid_package',
			message: 'Package id or kody id is required.',
		})
	}
	const exportName = normalizeExportName(input.request.exportName)
	if (isSealedSecretProviderExport(exportName)) {
		return buildJsonErrorResponse(sealedSecretProviderExportDeniedResponse())
	}
	// External webhook invocations stay keyed-only: providers retry
	// deliveries, so exactly-once is the point of this surface. Workflow
	// step retries pass ephemeral: true and run key-less instead.
	const idempotencyKey = input.ephemeral
		? null
		: normalizeNullableString(input.request.idempotencyKey)
	if (!input.ephemeral && !idempotencyKey) {
		return buildJsonErrorResponse({
			status: 400,
			code: 'missing_idempotency_key',
			message: 'Package invocations require a non-empty idempotencyKey.',
		})
	}
	const source = normalizeNullableString(input.request.source)
	const topic = normalizeNullableString(input.request.topic)
	const savedPackage = await resolveSavedPackage({
		db: input.env.APP_DB,
		userId: input.token.userId,
		packageIdOrKodyId,
	})
	if (!savedPackage) {
		return buildJsonErrorResponse({
			status: 404,
			code: 'package_not_found',
			message: buildSavedPackageNotFoundMessage(packageIdOrKodyId),
			idempotencyKey: idempotencyKey ?? undefined,
		})
	}
	if (!tokenAllowsPackage({ token: input.token, savedPackage })) {
		return buildJsonErrorResponse({
			status: 403,
			code: 'package_not_allowed',
			message: 'This token is not allowed to invoke the requested package.',
			idempotencyKey: idempotencyKey ?? undefined,
		})
	}
	if (!tokenAllowsExport({ token: input.token, exportName })) {
		return buildJsonErrorResponse({
			status: 403,
			code: 'export_not_allowed',
			message: `This token is not allowed to invoke export "${exportName}".`,
			idempotencyKey: idempotencyKey ?? undefined,
		})
	}

	const shared = {
		env: input.env,
		baseUrl: input.baseUrl,
		actor: {
			sourceId: input.token.tokenId,
			orgId: ownerIdFromStored(input.token.userId),
			request: input.token.request,
		},
		savedPackage,
		invocationName: exportName,
		moduleSelector: {
			kind: 'export' as const,
			exportName,
		},
		params: input.request.params,
		source,
		topic,
		notFoundCode: 'export_not_found' as const,
		runtimeInvokeDepth: input.runtimeInvokeDepth ?? 0,
		toolFactories: input.toolFactories,
		waitUntil: input.waitUntil,
		executorTimeoutMs: input.executorTimeoutMs,
		signal: input.signal,
		sourceRevision: input.sourceRevision,
		executionRouting: input.executionRouting ?? null,
		parentRunHandle: input.parentRunHandle ?? null,
		executionTarget: input.executionTarget ?? null,
	}

	if (!idempotencyKey) {
		return await runSavedPackageModuleEphemeral(shared)
	}

	return await invokeSavedPackageModule({
		...shared,
		idempotencyKey,
		...(input.request.idempotencyParamsHash === 'ignore'
			? { idempotencyParamsHash: 'ignore' as const }
			: {}),
		...(input.request.idempotencyHashParams
			? { idempotencyHashParams: input.request.idempotencyHashParams }
			: {}),
		...(input.request.claimOwner
			? { claimOwner: input.request.claimOwner }
			: {}),
	})
}
