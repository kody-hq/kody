import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { requirePackageIdFromJobId } from '#worker/jobs/package-job-id.ts'
import { buildSingleTriggerEnablementHint } from './enablement-agent-hints.ts'
import { listEnablementsForInstance } from './repo.ts'

/**
 * When a scheduled job is armed (`enabled`) but has no on enablement (or only
 * paused ones), return the agent-directed enablementEnable hint. Owner-created
 * jobs auto-enable on create, so a missing hint is anomalous repair guidance
 * (not an ask-the-user prompt).
 */
export async function resolveCronJobEnablementHint(input: {
	env: Env
	orgId: OwnerId
	jobId: string
	jobName: string
	enabled: boolean
}): Promise<string | null> {
	if (!input.enabled) return null
	let packageId: string
	try {
		packageId = requirePackageIdFromJobId(input.jobId)
	} catch {
		return null
	}
	try {
		const enablements = await listEnablementsForInstance({
			db: input.env.APP_DB,
			orgId: input.orgId,
			triggerKind: 'cron',
			instanceId: input.jobId,
		})
		if (enablements.some((enablement) => enablement.state === 'on')) return null
		return buildSingleTriggerEnablementHint({
			packageId,
			triggerKind: 'cron',
			triggerName: input.jobName,
			reason: enablements.some((enablement) => enablement.state === 'paused')
				? 'paused'
				: 'missing',
		})
	} catch (error) {
		// Optional guidance only — never fail jobGet/list/update/runNow after the
		// underlying action already succeeded (same pattern as publish gaps).
		console.warn('cron-job-enablement-hint-failed', error)
		return null
	}
}
