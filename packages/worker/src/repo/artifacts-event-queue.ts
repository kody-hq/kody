import { processCloudflareArtifactsRepoEvent } from './package-subscriptions.ts'
import { artifactsRepoEventsQueueName } from './artifacts-event-queue-names.ts'

const unmatchedRetryDelaySeconds = 30
export { artifactsRepoEventsQueueName }

export async function handleArtifactsRepoEventsQueue(
	batch: MessageBatch<unknown>,
	env: Env,
	ctx: ExecutionContext,
) {
	const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise)
	for (const queueMessage of batch.messages) {
		try {
			const result = await processCloudflareArtifactsRepoEvent({
				env,
				body: queueMessage.body,
				waitUntil,
			})
			switch (result.outcome) {
				case 'invalid':
				case 'ignored':
					queueMessage.ack()
					break
				case 'unmatched': {
					// Create can race D1 insert; retry briefly. Deleted events after
					// entity_sources cleanup are expected misses — ack without fan-out.
					if (result.providerEvent.type === 'cf.artifacts.repo.deleted') {
						queueMessage.ack()
						break
					}
					console.warn('artifacts-repo-event-unmatched', {
						queueMessageId: queueMessage.id,
						type: result.providerEvent.type,
						repoName: result.providerEvent.source.repoName,
						namespace: result.providerEvent.source.namespace,
					})
					queueMessage.retry({ delaySeconds: unmatchedRetryDelaySeconds })
					break
				}
				case 'dispatched':
					queueMessage.ack()
					break
				default: {
					const exhaustive: never = result
					throw new Error(
						`Unsupported Artifacts repo event queue outcome: ${JSON.stringify(exhaustive)}`,
					)
				}
			}
		} catch (error) {
			console.error('artifacts-repo-event-processing-failed', {
				queueMessageId: queueMessage.id,
				attempts: queueMessage.attempts,
				error: describeError(error),
				cause: error instanceof Error ? describeError(error.cause) : null,
			})
			queueMessage.retry({ delaySeconds: unmatchedRetryDelaySeconds })
		}
	}
}

function describeError(error: unknown) {
	if (error == null) return null
	if (error instanceof Error) return `${error.name}: ${error.message}`
	return String(error)
}
