import { isNonProductionRuntime } from '#app/deployment-env.ts'
import { createCloudflareRestClient } from '#mcp/cloudflare/cloudflare-rest-client.ts'
import { deadLetterQueues } from '#worker/dead-letter/queues.ts'
import {
	listQueueIds,
	readQueueMetrics,
	type QueueMetrics,
} from '#worker/scheduled/dlq-depth-alert.ts'

type CloudflareMetricsEnv = Env & {
	CLOUDFLARE_API_BASE_URL?: string
	CLOUDFLARE_API_MOCK?: Fetcher
}

export async function readCloudflareBacklogs(
	env: CloudflareMetricsEnv,
): Promise<
	| { metrics: Map<string, QueueMetrics | Error>; error: null }
	| { metrics: null; error: string }
> {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = env.CLOUDFLARE_API_TOKEN?.trim()
	if (isNonProductionRuntime(env) || !accountId || !apiToken) {
		return {
			metrics: null,
			error:
				'Cloudflare Queue metrics are read only in production with CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.',
		}
	}
	const client = createCloudflareRestClient({
		CLOUDFLARE_API_TOKEN: apiToken,
		CLOUDFLARE_API_BASE_URL: env.CLOUDFLARE_API_BASE_URL,
		CLOUDFLARE_API_MOCK: env.CLOUDFLARE_API_MOCK,
	})
	let queueIds: Map<string, string>
	try {
		queueIds = await listQueueIds(client, accountId)
	} catch (error) {
		return {
			metrics: null,
			error: error instanceof Error ? error.message : 'Queue list failed.',
		}
	}
	const metrics = new Map<string, QueueMetrics | Error>()
	await Promise.all(
		deadLetterQueues.map(async (queue) => {
			const queueId = queueIds.get(queue.name)
			if (!queueId) {
				metrics.set(queue.name, new Error('Queue not found in Cloudflare.'))
				return
			}
			try {
				metrics.set(
					queue.name,
					await readQueueMetrics(client, accountId, queueId),
				)
			} catch (error) {
				metrics.set(
					queue.name,
					error instanceof Error ? error : new Error('Metrics read failed.'),
				)
			}
		}),
	)
	return { metrics, error: null }
}
