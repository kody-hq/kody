/**
 * Dedicated exposure writes for flags with
 * `exposureRecording: 'mcp-events-clients'` (currently `mcp-events-extension`).
 *
 * The experiment frame is OAuth callers whose modern MCP client calls an
 * `events/*` method served by `registerMcpEvents`. Execute and other
 * non-events clients stay outside the on/off cohorts.
 */

import {
	getFeatureFlagExposureRecording,
	mcpEventsExtensionFlagKey,
	type FeatureFlagKey,
} from '#universal/feature-flags/registry.ts'
import {
	recordFeatureFlagExposures,
	type FeatureFlagExposureEnv,
} from './exposure.ts'
import { type FeatureFlagEvaluation } from './service.ts'

export type McpEventsClientsExposureInput = {
	env: FeatureFlagExposureEnv
	stableUserId: string | null | undefined
	/** Same evaluation that gated `registerMcpEvents`. */
	evaluation: FeatureFlagEvaluation
	/** Override for tests; defaults to the MCP Events extension flag. */
	flagKey?: FeatureFlagKey
}

/**
 * Record one MCP-events-clients exposure. Never throws: registration must
 * not fail because attribution failed.
 */
export async function recordMcpEventsClientsFlagExposure(
	input: McpEventsClientsExposureInput,
): Promise<void> {
	try {
		const stableUserId = input.stableUserId?.trim() ?? ''
		if (!stableUserId) return
		const flagKey = input.flagKey ?? mcpEventsExtensionFlagKey
		if (getFeatureFlagExposureRecording(flagKey) !== 'mcp-events-clients') {
			return
		}
		await recordFeatureFlagExposures(input.env, {
			stableUserId,
			evaluations: { [flagKey]: input.evaluation },
			recordingSite: 'dedicated',
		})
	} catch (error) {
		console.warn('mcp-events-clients-exposure-failed', error)
	}
}
