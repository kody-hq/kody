import { shouldRunPackageAppHostMigrationReminderCron } from '@kody-internal/shared/jobs/scheduled-lanes.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { detectPackageAppHostMigrationCodemodId } from './codemods/0019-detect-package-app-host-migration.ts'
import { runPackageCodemodStep } from './engine.ts'
import { runPackageAppHostMigrationNotice } from './host-migration-owner-notice.ts'

/**
 * Notice settings for the one-time reminder based on a fresh fleet scan.
 * See “Scheduled host migration reminder” in `docs/contributing/package-codemods.md`.
 */
export const packageAppHostMigrationReminder = {
	sendFrom: '2026-12-03T15:00:00Z',
	noticeId: 'host-migration-reminder',
	cutoverDate: 'December 17, 2026',
	reminderDate: 'December 3, 2026',
} as const

export const packageAppHostMigrationReminderKvKey =
	'package-app-host-migration-reminder:v1'
const stateTtlSeconds = 180 * 24 * 60 * 60
const tickBudgetMs = 40_000
const initiatedBy = 'system:host-migration-reminder'

export type PackageAppHostMigrationReminderState = {
	scanRunId: string | null
	scanCursor: string | null
	scanDone: boolean
	noticeCursor: string | null
	/** Set true to finish, or by hand to cancel the reminder. */
	done: boolean
	/** Notice statuses counted over the current pass through the owners. */
	sent: Record<string, number>
	/** Passes that ended with a failed send and were started again. */
	passes: number
	updatedAt: string
}

type ReminderEnv = Env & {
	PACKAGE_APP_HOST_MIGRATION_REMINDER_ENABLED?: string
}

export async function runPackageAppHostMigrationReminder(input: {
	env: ReminderEnv
	now: Date
	scanStep?: typeof runPackageCodemodStep
	sendNotice?: typeof runPackageAppHostMigrationNotice
	clock?: () => number
}): Promise<PackageAppHostMigrationReminderState | null> {
	const { env } = input
	if (env.PACKAGE_APP_HOST_MIGRATION_REMINDER_ENABLED !== 'true') return null
	if (!shouldRunPackageAppHostMigrationReminderCron(input.now)) return null
	const kv = env.BUNDLE_ARTIFACTS_KV
	if (!kv) return null
	const scanStep = input.scanStep ?? runPackageCodemodStep
	const sendNotice = input.sendNotice ?? runPackageAppHostMigrationNotice
	const clock = input.clock ?? Date.now
	const startedAt = clock()
	const hasBudget = () => clock() - startedAt < tickBudgetMs

	const state: PackageAppHostMigrationReminderState = (await kv.get(
		packageAppHostMigrationReminderKvKey,
		'json',
	)) ?? {
		scanRunId: null,
		scanCursor: null,
		scanDone: false,
		noticeCursor: null,
		done: false,
		sent: {},
		passes: 0,
		updatedAt: input.now.toISOString(),
	}
	if (state.done) return state
	const save = async () => {
		state.updatedAt = new Date(clock()).toISOString()
		await kv.put(packageAppHostMigrationReminderKvKey, JSON.stringify(state), {
			expirationTtl: stateTtlSeconds,
		})
	}

	while (!state.scanDone && hasBudget()) {
		const step = await scanStep({
			env,
			baseUrl: getAppBaseUrl({ env }),
			initiatedByUserId: initiatedBy,
			codemodId: detectPackageAppHostMigrationCodemodId,
			mode: 'scan',
			scope: { kind: 'fleet' },
			...(state.scanRunId
				? { runId: state.scanRunId, cursor: state.scanCursor }
				: {}),
		})
		state.scanRunId = step.runId
		state.scanCursor = step.nextCursor
		state.scanDone = step.nextCursor === null
		await save()
	}
	if (
		!state.scanDone ||
		!state.scanRunId ||
		input.now.getTime() < Date.parse(packageAppHostMigrationReminder.sendFrom)
	) {
		return state
	}

	while (!state.done && hasBudget()) {
		const page = await sendNotice({
			env,
			runId: state.scanRunId,
			noticeId: packageAppHostMigrationReminder.noticeId,
			kind: 'reminder',
			cutoverDate: packageAppHostMigrationReminder.cutoverDate,
			reminderDate: packageAppHostMigrationReminder.reminderDate,
			dryRun: false,
			cursor: state.noticeCursor,
			limit: 5,
		})
		for (const [status, count] of Object.entries(page.summary)) {
			state.sent[status] = (state.sent[status] ?? 0) + (count ?? 0)
		}
		state.noticeCursor = page.nextCursor
		if (page.nextCursor === null) {
			// A failed send leaves no claim, so another pass on a later tick
			// retries only those owners. A failed claim write is the one case
			// where a pass could mail someone twice, so that ends the run.
			const retry =
				(state.sent.send_failed ?? 0) > 0 &&
				(state.sent.claim_failed ?? 0) === 0
			if (retry) {
				state.passes += 1
				state.sent = {}
				await save()
				break
			}
			state.done = true
		}
		await save()
	}
	console.log('package-app-host-migration-reminder', {
		scanRunId: state.scanRunId,
		done: state.done,
		sent: state.sent,
		passes: state.passes,
	})
	return state
}
