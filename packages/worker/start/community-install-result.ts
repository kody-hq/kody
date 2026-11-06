import type {
	CommunityInstallApiPayload,
	CommunityInstallOutcome,
} from './community-types.ts'

/**
 * Normalize a website fork/install server-fn payload. A successful fork can
 * still resolve to `undefined` when the serverFn return chain unwraps an
 * operationResult-shaped value incorrectly (install outcome `status:
 * 'installed'` colliding with HTTP `status`). Never read `.ok` until the
 * payload is an object, or the UI surfaces
 * `Cannot read properties of undefined (reading 'ok')` after the fork row
 * already exists.
 */
export function readCommunityInstallResult(
	result: unknown,
): CommunityInstallOutcome {
	const payload =
		result && typeof result === 'object'
			? (result as CommunityInstallApiPayload)
			: null
	if (
		!payload ||
		payload.ok !== true ||
		!payload.status ||
		!payload.targetName ||
		!payload.agentPrompt
	) {
		throw new Error(
			(payload && typeof payload.error === 'string' && payload.error) ||
				'Unable to install this public package.',
		)
	}
	return {
		status: payload.status,
		targetName: payload.targetName,
		agentPrompt: payload.agentPrompt,
		packageId: payload.packageId ?? null,
		failedChecks: payload.failedChecks ?? [],
		alreadyInstalled: payload.alreadyInstalled === true,
	}
}
