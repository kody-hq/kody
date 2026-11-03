import { assertBackupDay } from '@kody-internal/shared/backup-staging.ts'
import {
	handleSecretMaintenanceRequest,
	MaintenanceFailureError,
} from '#worker/maintenance-handler.ts'
import type { DrBackupS3Client } from '#worker/dr/backup-s3.ts'
import {
	runDrExportTick,
	type DrExportTickResult,
} from '#worker/dr/exporter.ts'

export const drExportMaintenanceMaxTicks = 10
const defaultTicksPerRequest = 5

function parseDay(value: unknown): string {
	if (typeof value !== 'string') {
		throw new MaintenanceFailureError('Request body requires day: string', {
			ticks: [],
		})
	}
	try {
		assertBackupDay(value)
	} catch {
		throw new MaintenanceFailureError('day must be a UTC YYYY-MM-DD day', {
			ticks: [],
		})
	}
	return value
}

function parseMaxTicks(value: unknown): number {
	if (value === undefined) return defaultTicksPerRequest
	if (
		typeof value !== 'number' ||
		!Number.isSafeInteger(value) ||
		value < 1 ||
		value > drExportMaintenanceMaxTicks
	) {
		throw new MaintenanceFailureError(
			`maxTicks must be an integer between 1 and ${drExportMaintenanceMaxTicks}`,
			{ ticks: [] },
		)
	}
	return value
}

/**
 * Operator recovery for a stranded staging day (see the disaster-recovery
 * runbook): runs resume-only exporter ticks for the requested UTC day until
 * its `exporter/summary.json` is written, the tick skips, or `maxTicks` is
 * reached. Repeat the request until `summaryWritten` is true. Reuses the
 * `DR_RESTORE_SECRET` bearer like the other DR maintenance endpoints and the
 * exporter's own lease/If-Match ownership, so racing scheduled catch-up
 * ticks stay safe.
 */
export async function handleDrExportRequest(
	request: Request,
	env: Env,
	s3?: DrBackupS3Client,
): Promise<Response> {
	return handleSecretMaintenanceRequest({
		request,
		secret: env.DR_RESTORE_SECRET,
		notConfiguredMessage: 'DR export maintenance is not configured',
		run: async () => {
			let body: { day?: unknown; maxTicks?: unknown }
			try {
				body = (await request.json()) as { day?: unknown; maxTicks?: unknown }
			} catch {
				throw new MaintenanceFailureError('Request body must be JSON', {
					ticks: [],
				})
			}
			const day = parseDay(body.day)
			const maxTicks = parseMaxTicks(body.maxTicks)
			const ticks: Array<DrExportTickResult> = []
			for (let tick = 0; tick < maxTicks; tick += 1) {
				const result = await runDrExportTick({ env, day, s3 })
				ticks.push(result)
				if (result.summaryWritten || result.skipped) break
			}
			const last = ticks[ticks.length - 1]!
			return {
				day,
				summaryWritten: last.summaryWritten,
				phase: last.phase,
				skipped: last.skipped,
				...(last.reason ? { reason: last.reason } : {}),
				ticks,
			}
		},
	})
}
