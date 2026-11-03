import * as Sentry from '@sentry/cloudflare'
import type { JobsWorkerEnv } from './env.ts'
import { handleJobsHealthRequest } from './health.ts'
import { JobManager } from './manager-do.ts'
import {
	dispatchScheduledLanes,
	handleScheduledDispatchQueue,
} from './scheduled.ts'
import { buildSentryOptions } from './sentry-options.ts'
import { JobsService } from './service.ts'

export { JobManager, JobsService }

const handler = {
	async fetch(request: Request, env: JobsWorkerEnv) {
		const healthResponse = await handleJobsHealthRequest(request, env)
		if (healthResponse) return healthResponse
		return new Response('Not found', { status: 404 })
	},
	async scheduled(
		controller: ScheduledController,
		env: JobsWorkerEnv,
		ctx: ExecutionContext,
	) {
		ctx.waitUntil(dispatchScheduledLanes({ controller, env }))
	},
	async queue(batch: MessageBatch<unknown>, env: JobsWorkerEnv) {
		await handleScheduledDispatchQueue(batch, env)
	},
} satisfies ExportedHandler<JobsWorkerEnv>

export default Sentry.withSentry(
	(env: JobsWorkerEnv) => buildSentryOptions(env),
	handler,
)
