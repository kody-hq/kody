import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { isRecord } from '@kody-internal/shared/is-record.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import type { RequestSource } from '#worker/request-context/request-context.ts'
import { sealedSecretProviderInvocationSource } from '#worker/package-runtime/package-invocation-sources.ts'
import { runSavedPackageModuleOnce } from '#worker/package-invocations/module-execution.ts'
import { createPackageEventTools } from '#worker/package-invocations/service.ts'
import {
	secretProviderCanonicalizeTimeoutMs,
	secretProviderResolveTimeoutMs,
	SecretProviderError,
	createProviderErrorMessage,
} from './errors.ts'
import { sealedSecretProviderExportName } from './sealed-export.ts'
import type {
	SecretProviderInvokeInput,
	SealedProviderCanonicalizeResult,
	SealedProviderResolveResult,
} from './types.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'

const toolFactories = {
	createPackageEventTools,
}

export async function invokeSealedSecretProvider(
	input: SecretProviderInvokeInput & {
		env: Env
		baseUrl: string
		ownerUserId: string
		request: RequestSource
		savedPackage: SavedPackageRecord
	},
): Promise<SealedProviderCanonicalizeResult | SealedProviderResolveResult> {
	const timeoutMs =
		input.action === 'canonicalize'
			? secretProviderCanonicalizeTimeoutMs
			: secretProviderResolveTimeoutMs
	const outcome = await runSavedPackageModuleOnce({
		env: input.env,
		baseUrl: input.baseUrl,
		actor: {
			sourceId: 'internal:secret-provider-sealed',
			orgId: ownerIdFromStored(input.ownerUserId),
			request: input.request,
		},
		savedPackage: input.savedPackage,
		invocationName: sealedSecretProviderExportName,
		moduleSelector: {
			kind: 'export',
			exportName: sealedSecretProviderExportName,
		},
		params: {
			action: input.action,
			providerId: input.providerId,
			ref: input.ref,
			canonicalRef: input.canonicalRef,
			doorSecretName: input.doorSecretName,
			doorSecretValue: input.doorSecretValue,
			config: input.config,
		},
		idempotencyKey: null,
		invocationId: null,
		source: sealedSecretProviderInvocationSource,
		topic: null,
		notFoundCode: 'export_not_found',
		toolFactories,
		executorTimeoutMs: timeoutMs,
		signal: AbortSignal.timeout(timeoutMs),
	})
	if (outcome.kind !== 'completed') {
		throw new SecretProviderError(
			createProviderErrorMessage(input.providerId),
			{
				cause:
					outcome.kind === 'failed'
						? outcome.error
						: new Error(getErrorMessage(outcome.response)),
			},
		)
	}
	return parseSealedProviderModuleResult({
		providerId: input.providerId,
		action: input.action,
		result: outcome.result,
	})
}

function parseSealedProviderModuleResult(input: {
	providerId: string
	action: SecretProviderInvokeInput['action']
	result: unknown
}): SealedProviderCanonicalizeResult | SealedProviderResolveResult {
	if (!isRecord(input.result)) {
		throw new SecretProviderError(createProviderErrorMessage(input.providerId))
	}
	switch (input.action) {
		case 'canonicalize': {
			const canonicalRef =
				typeof input.result.canonicalRef === 'string'
					? input.result.canonicalRef.trim()
					: ''
			if (!canonicalRef) {
				throw new SecretProviderError(
					createProviderErrorMessage(input.providerId),
				)
			}
			return { canonicalRef }
		}
		case 'resolve': {
			const value =
				typeof input.result.value === 'string' ? input.result.value : ''
			const hosts = Array.isArray(input.result.hosts)
				? input.result.hosts.filter(
						(host): host is string => typeof host === 'string',
					)
				: null
			if (!value || !hosts) {
				throw new SecretProviderError(
					createProviderErrorMessage(input.providerId),
				)
			}
			return { value, hosts }
		}
		default: {
			const _exhaustive: never = input.action
			return _exhaustive
		}
	}
}
