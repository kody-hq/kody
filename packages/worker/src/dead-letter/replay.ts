import { jobsService } from '#worker/jobs/jobs-data.ts'
import { type DeadLetterQueueDefinition } from './queues.ts'

export type DeadLetterReplayEnv = Pick<
	Env,
	| 'JOBS'
	| 'APP_DB'
	| 'PLATFORM_FEEDBACK_DISPATCH_QUEUE'
	| 'COMMUNITY_ACTIVITY_DISPATCH_QUEUE'
	| 'COMMUNITY_LISTING_PUBLISHED_DISPATCH_QUEUE'
	| 'PACKAGE_EVENTS_DISPATCH_QUEUE'
	| 'WEBHOOK_DISPATCH_QUEUE'
>

/** Sends a parked body back to the DLQ's source queue. */
export async function sendDeadLetterBodyToSourceQueue(input: {
	env: DeadLetterReplayEnv
	queue: DeadLetterQueueDefinition
	body: unknown
}) {
	const { replay } = input.queue
	switch (replay.kind) {
		case 'producer': {
			const producer = input.env[replay.binding] as Queue | undefined
			if (!producer) {
				throw new Error(
					`Queue producer binding ${replay.binding} is not bound in this environment.`,
				)
			}
			await producer.send(input.body, { contentType: 'json' })
			return
		}
		case 'scheduled-dispatch': {
			const jobs = jobsService(input.env)
			if (!jobs) {
				throw new Error(
					'The JOBS service binding is not bound in this environment.',
				)
			}
			await jobs.replayScheduledDispatchMessage({ body: input.body })
			return
		}
		case 'unsupported':
			throw new Error(replay.reason)
		default: {
			const unhandled: never = replay
			throw new Error(`Unhandled replay target: ${String(unhandled)}`)
		}
	}
}
