/**
 * Feature-flag success-metric exposure recording.
 *
 * For every flag that declares a `successMetric` in the registry, exposures
 * record which value the user saw and how it was assigned. Most flags write
 * at the two evaluation chokepoints (the app session flag cache and the MCP
 * caller flag resolver). Flags with `exposureRecording: 'mcp-events-clients'`
 * write only after an events-capable MCP client registers, so other MCP
 * callers stay outside the experiment frame.
 *
 * Exposures are what make the admin metric readout honest: current flag state
 * cannot reconstruct who was inside a percentage rollout last week, and
 * hand-picked override users must be excluded from on/off comparisons.
 *
 * The write path mirrors `packages/worker/src/usage/record-usage.ts`:
 *
 * - With the `FLAG_EXPOSURES` Analytics Engine binding (production/preview),
 *   each exposure is a single non-blocking `writeDataPoint` call.
 * - Without it — or in local Wrangler dev, where the binding is a local
 *   emulation whose data the SQL API can never read — exposures are upserted
 *   into the D1 `feature_flag_exposure_rollups` table (one row per
 *   flag/user/day/state) so the readout keeps working without Analytics
 *   Engine access.
 *
 * `recordFeatureFlagExposures` never throws and never rejects: exposure
 * recording must not break session loading or MCP request handling.
 */

import {
	measuredFeatureFlagKeys,
	recordsFeatureFlagExposureAtEvaluation,
	type FeatureFlagKey,
} from '#universal/feature-flags/registry.ts'
import { type FeatureFlagEvaluation } from './service.ts'

export type FeatureFlagExposureEnv = {
	FLAG_EXPOSURES?: AnalyticsEngineDataset
	APP_DB?: D1Database
	WRANGLER_IS_LOCAL_DEV?: string
}

const exposureRollupUpsertStatement = `
INSERT INTO feature_flag_exposure_rollups (
	flag_key, user_id, day, enabled, source, exposure_count, updated_at
) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
ON CONFLICT (flag_key, user_id, day, enabled, source) DO UPDATE SET
	exposure_count = exposure_count + 1,
	updated_at = excluded.updated_at
`.trim()

export type FeatureFlagExposureRecordingSite = 'evaluation' | 'dedicated'

/**
 * Record one exposure per measured flag in `evaluations` for the given
 * stable user id. Flags without a registry `successMetric` are skipped, so
 * request volume for unmeasured flags never reaches a sink.
 *
 * `recordingSite: 'evaluation'` (default) also skips flags that declare a
 * dedicated exposure path (for example `mcp-events-clients`). Pass
 * `'dedicated'` from that path so those flags still write.
 */
export async function recordFeatureFlagExposures(
	env: FeatureFlagExposureEnv,
	input: {
		stableUserId: string
		evaluations: Partial<Record<FeatureFlagKey, FeatureFlagEvaluation>>
		timestamp?: string
		recordingSite?: FeatureFlagExposureRecordingSite
	},
): Promise<void> {
	try {
		if (!input.stableUserId) return
		const recordingSite = input.recordingSite ?? 'evaluation'
		const exposures = Object.entries(input.evaluations).filter(([key]) => {
			const flagKey = key as FeatureFlagKey
			if (!measuredFeatureFlagKeys.has(flagKey)) return false
			if (recordingSite === 'dedicated') return true
			return recordsFeatureFlagExposureAtEvaluation(flagKey)
		}) as Array<[FeatureFlagKey, FeatureFlagEvaluation]>
		if (exposures.length === 0) return
		const timestamp = input.timestamp ?? new Date().toISOString()
		if (env.FLAG_EXPOSURES && env.WRANGLER_IS_LOCAL_DEV !== 'true') {
			writeExposureDataPoints(env, input.stableUserId, exposures, timestamp)
			return
		}
		await writeExposureRollups(env, input.stableUserId, exposures, timestamp)
	} catch (error) {
		console.warn('flag-exposure-record-failed', error)
	}
}

function writeExposureDataPoints(
	env: FeatureFlagExposureEnv,
	stableUserId: string,
	exposures: Array<[FeatureFlagKey, FeatureFlagEvaluation]>,
	timestamp: string,
) {
	if (!env.FLAG_EXPOSURES) return
	for (const [flagKey, evaluation] of exposures) {
		try {
			env.FLAG_EXPOSURES.writeDataPoint({
				indexes: [stableUserId],
				blobs: [
					stableUserId,
					flagKey,
					evaluation.enabled ? 'on' : 'off',
					evaluation.source,
					timestamp,
				],
				doubles: [],
			})
		} catch (error) {
			console.warn('flag-exposure-analytics-failed', error)
		}
	}
}

async function writeExposureRollups(
	env: FeatureFlagExposureEnv,
	stableUserId: string,
	exposures: Array<[FeatureFlagKey, FeatureFlagEvaluation]>,
	timestamp: string,
) {
	const db = env.APP_DB
	if (
		!db ||
		typeof db.batch !== 'function' ||
		typeof db.prepare !== 'function'
	) {
		console.debug('flag-exposure-skipped', 'missing APP_DB binding')
		return
	}
	try {
		const day = timestamp.slice(0, 'YYYY-MM-DD'.length)
		await db.batch(
			exposures.map(([flagKey, evaluation]) =>
				db
					.prepare(exposureRollupUpsertStatement)
					.bind(
						flagKey,
						stableUserId,
						day,
						evaluation.enabled ? 1 : 0,
						evaluation.source,
						timestamp,
					),
			),
		)
	} catch (error) {
		console.warn('flag-exposure-rollup-failed', error)
	}
}
