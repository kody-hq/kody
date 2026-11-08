import type { CommunityInstallApiPayload } from '../community-types.ts'

/**
 * Website community install handlers return `{ data, status }` like
 * `operationResult`. Start server functions must return the inner `data` POJO
 * and set the HTTP status separately (same pattern as package-mutations).
 *
 * Returning the wrapper, or calling `requireOperationResult` on an
 * already-unwrapped payload whose `status` is the install outcome string
 * (`'installed'`), yields `undefined` via `.data`. Separately, Start's client
 * does `return result.result`; a lost/incomplete RPC envelope after a long
 * committed install also resolves to `undefined` and made the Fork UI throw
 * `Cannot read properties of undefined (reading 'ok')`. Always rebuild a
 * plain success POJO here; the UI still reconciles via live fork state when
 * the envelope is missing.
 */
export type CommunityInstallHandlerResult = {
	data: CommunityInstallApiPayload
	status: number
}

export function unwrapCommunityInstallHandlerResult(
	result: CommunityInstallHandlerResult | null | undefined,
): CommunityInstallApiPayload {
	if (!result || typeof result !== 'object') {
		throw new Error('Community install returned an empty response.')
	}
	if (typeof result.status !== 'number') {
		throw new Error('Community install returned an empty response.')
	}
	if (result.status >= 400) {
		const data = result.data
		throw new Error(
			data &&
				typeof data === 'object' &&
				typeof data.error === 'string' &&
				data.error
				? data.error
				: 'Unable to install this public package.',
		)
	}
	const data = result.data
	if (!data || typeof data !== 'object' || typeof data.ok !== 'boolean') {
		throw new Error('Community install returned an empty response.')
	}
	// Rebuild a plain object so the serverFn serializer never sees a proxy,
	// class instance, or accidental `{ data, status }` wrapper.
	return {
		ok: data.ok,
		...(data.requiresAcknowledgement !== undefined
			? { requiresAcknowledgement: data.requiresAcknowledgement }
			: {}),
		...(data.status !== undefined ? { status: data.status } : {}),
		...(data.packageId !== undefined ? { packageId: data.packageId } : {}),
		...(data.targetName !== undefined ? { targetName: data.targetName } : {}),
		...(data.agentPrompt !== undefined
			? { agentPrompt: data.agentPrompt }
			: {}),
		...(data.failedChecks !== undefined
			? { failedChecks: data.failedChecks.map((check) => ({ ...check })) }
			: {}),
		...(data.alreadyInstalled !== undefined
			? { alreadyInstalled: data.alreadyInstalled }
			: {}),
		...(data.message !== undefined ? { message: data.message } : {}),
		...(data.error !== undefined ? { error: data.error } : {}),
	}
}
