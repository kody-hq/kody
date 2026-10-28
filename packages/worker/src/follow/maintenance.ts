import { flushPendingWindow } from './push-ingress.ts'
import {
	deleteFollowPushPendingIfUnchanged,
	deletePausedFollowsBefore,
	deleteStaleFollowRecentUpdates,
	hasAppDb,
	listDueFollowPushPending,
} from './repo.ts'
import {
	followPauseRetentionMs,
	followPushWindowMs,
	followRecentUpdatesRetentionMs,
} from './types.ts'

/**
 * Every cron tick: flush push windows that have been open for five minutes,
 * delete follows paused longer than 30 days, then drop Recent updates older
 * than 30 days or whose follow is gone.
 */
export async function runFollowMaintenance(input: {
	env: Env
	now: Date
}): Promise<{
	flushed: number
	pausedDeleted: number
	recentUpdatesDeleted: number
}> {
	if (!hasAppDb(input.env.APP_DB))
		return { flushed: 0, pausedDeleted: 0, recentUpdatesDeleted: 0 }
	const cutoff = new Date(
		input.now.getTime() - followPushWindowMs,
	).toISOString()
	const due = await listDueFollowPushPending(input.env.APP_DB, cutoff)
	let flushed = 0
	for (const pending of due) {
		const ok = await flushPendingWindow({ env: input.env, pending })
		if (!ok) continue
		const deleted = await deleteFollowPushPendingIfUnchanged(
			input.env.APP_DB,
			pending,
		)
		if (deleted) flushed += 1
	}
	const pauseCutoff = new Date(
		input.now.getTime() - followPauseRetentionMs,
	).toISOString()
	const pausedDeleted = await deletePausedFollowsBefore(
		input.env.APP_DB,
		pauseCutoff,
	)
	const recentUpdatesDeleted = await deleteStaleFollowRecentUpdates(
		input.env.APP_DB,
		new Date(
			input.now.getTime() - followRecentUpdatesRetentionMs,
		).toISOString(),
	)
	return { flushed, pausedDeleted, recentUpdatesDeleted }
}
