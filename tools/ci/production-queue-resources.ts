import {
	communityActivityDispatchDeadLetterQueueName,
	communityActivityDispatchQueueBinding,
	communityActivityDispatchQueueName,
} from '../../packages/worker/src/community/activity-dispatch-queue-names.ts'
import {
	communityListingPublishedDispatchDeadLetterQueueName,
	communityListingPublishedDispatchQueueBinding,
	communityListingPublishedDispatchQueueName,
} from '../../packages/worker/src/community/listing-published-dispatch-queue-names.ts'
import {
	packageEventsDispatchDeadLetterQueueName,
	packageEventsDispatchQueueBinding,
	packageEventsDispatchQueueName,
} from '../../packages/worker/src/package-events/dispatch-queue-names.ts'
import {
	platformFeedbackDispatchDeadLetterQueueName,
	platformFeedbackDispatchQueueBinding,
	platformFeedbackDispatchQueueName,
} from '../../packages/worker/src/platform-feedback/dispatch-queue-names.ts'
import {
	artifactsRepoEventsDeadLetterQueueName,
	artifactsRepoEventsQueueName,
} from '../../packages/worker/src/repo/artifacts-event-queue-names.ts'
import {
	webhookDispatchDeadLetterQueueName,
	webhookDispatchQueueBinding,
	webhookDispatchQueueName,
} from '../../packages/worker/src/webhooks/dispatch-queue-names.ts'

const emailDeliveryQueueName = 'kody-email-delivery'
const emailDeliveryDeadLetterQueueName = 'kody-email-delivery-dlq'
const expectedMaxBatchSize = 10
const expectedMaxBatchTimeout = 5
const expectedMaxRetries = 3
const expectedSourceConsumerCount = 7
const scheduledDispatchDeadLetterQueueName = 'kody-scheduled-dispatch-dlq'
/** packages/worker/src/dead-letter/consumer.ts deadLetterConsumerMaxRetries */
const expectedDeadLetterConsumerMaxRetries = 100
const expectedDeadLetterConsumerRetryDelay = 60

function readQueueConsumer(input: {
	consumers: Array<unknown>
	queueName: string
	deadLetterQueueName: string
	configPath: string
	maxBatchSize?: number
	maxBatchTimeout?: number
	maxConcurrency?: number
	maxRetries?: number
}) {
	const value = input.consumers.find((entry) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry))
			return false
		return (entry as Record<string, unknown>).queue === input.queueName
	})
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(
			`wrangler config "${input.configPath}" must define the production Queue consumer "${input.queueName}".`,
		)
	}
	const consumer = value as Record<string, unknown>
	if (
		consumer.dead_letter_queue !== input.deadLetterQueueName ||
		consumer.max_batch_size !== (input.maxBatchSize ?? expectedMaxBatchSize) ||
		consumer.max_batch_timeout !==
			(input.maxBatchTimeout ?? expectedMaxBatchTimeout) ||
		consumer.max_retries !== (input.maxRetries ?? expectedMaxRetries) ||
		(input.maxConcurrency !== undefined &&
			consumer.max_concurrency !== input.maxConcurrency)
	) {
		throw new Error(
			`wrangler config "${input.configPath}" has invalid production consumer settings for "${input.queueName}".`,
		)
	}
	return {
		queue: input.queueName,
		deadLetterQueue: input.deadLetterQueueName,
	}
}

/**
 * The origin worker parks every production dead-letter queue in APP_DB
 * (packages/worker/src/dead-letter/consumer.ts), including the jobs worker's
 * scheduled-dispatch DLQ. A DLQ consumer has no DLQ of its own.
 */
function readDeadLetterQueueConsumer(input: {
	consumers: Array<unknown>
	queueName: string
	configPath: string
}) {
	const value = input.consumers.find((entry) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry))
			return false
		return (entry as Record<string, unknown>).queue === input.queueName
	})
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(
			`wrangler config "${input.configPath}" must define the production dead-letter Queue consumer "${input.queueName}".`,
		)
	}
	const consumer = value as Record<string, unknown>
	if (
		consumer.dead_letter_queue !== undefined ||
		consumer.max_batch_size !== expectedMaxBatchSize ||
		consumer.max_batch_timeout !== expectedMaxBatchTimeout ||
		consumer.max_retries !== expectedDeadLetterConsumerMaxRetries ||
		consumer.retry_delay !== expectedDeadLetterConsumerRetryDelay
	) {
		throw new Error(
			`wrangler config "${input.configPath}" has invalid production dead-letter consumer settings for "${input.queueName}".`,
		)
	}
}

function readQueueProducer(input: {
	producers: Array<unknown>
	binding: string
	queueName: string
	configPath: string
}) {
	const producer = input.producers.find((entry) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry))
			return false
		return (entry as Record<string, unknown>).binding === input.binding
	})
	if (
		!producer ||
		typeof producer !== 'object' ||
		Array.isArray(producer) ||
		(producer as Record<string, unknown>).queue !== input.queueName
	) {
		throw new Error(
			`wrangler config "${input.configPath}" must bind "${input.binding}" to "${input.queueName}".`,
		)
	}
}

export function parseProductionQueueResources(input: {
	productionEnv: Record<string, unknown>
	configPath: string
}) {
	const queues = input.productionEnv.queues
	if (!queues || typeof queues !== 'object' || Array.isArray(queues)) {
		throw new Error(
			`wrangler config "${input.configPath}" is missing "env.production.queues".`,
		)
	}
	const queueConfig = queues as Record<string, unknown>
	const consumers = queueConfig.consumers
	const deadLetterQueueNames = [
		emailDeliveryDeadLetterQueueName,
		artifactsRepoEventsDeadLetterQueueName,
		platformFeedbackDispatchDeadLetterQueueName,
		communityActivityDispatchDeadLetterQueueName,
		communityListingPublishedDispatchDeadLetterQueueName,
		packageEventsDispatchDeadLetterQueueName,
		webhookDispatchDeadLetterQueueName,
		scheduledDispatchDeadLetterQueueName,
	]
	const expectedConsumerCount =
		expectedSourceConsumerCount + deadLetterQueueNames.length
	if (!Array.isArray(consumers) || consumers.length !== expectedConsumerCount) {
		throw new Error(
			`wrangler config "${input.configPath}" must define exactly ${expectedConsumerCount} production Queue consumers.`,
		)
	}
	for (const queueName of deadLetterQueueNames) {
		readDeadLetterQueueConsumer({
			consumers,
			queueName,
			configPath: input.configPath,
		})
	}
	const emailDelivery = readQueueConsumer({
		consumers,
		queueName: emailDeliveryQueueName,
		deadLetterQueueName: emailDeliveryDeadLetterQueueName,
		configPath: input.configPath,
	})
	const artifactsRepoEvents = readQueueConsumer({
		consumers,
		queueName: artifactsRepoEventsQueueName,
		deadLetterQueueName: artifactsRepoEventsDeadLetterQueueName,
		configPath: input.configPath,
	})
	const platformFeedbackDispatch = readQueueConsumer({
		consumers,
		queueName: platformFeedbackDispatchQueueName,
		deadLetterQueueName: platformFeedbackDispatchDeadLetterQueueName,
		configPath: input.configPath,
	})
	const communityActivityDispatch = readQueueConsumer({
		consumers,
		queueName: communityActivityDispatchQueueName,
		deadLetterQueueName: communityActivityDispatchDeadLetterQueueName,
		configPath: input.configPath,
	})
	const communityListingPublishedDispatch = readQueueConsumer({
		consumers,
		queueName: communityListingPublishedDispatchQueueName,
		deadLetterQueueName: communityListingPublishedDispatchDeadLetterQueueName,
		configPath: input.configPath,
	})
	const packageEventsDispatch = readQueueConsumer({
		consumers,
		queueName: packageEventsDispatchQueueName,
		deadLetterQueueName: packageEventsDispatchDeadLetterQueueName,
		configPath: input.configPath,
		maxConcurrency: 16,
	})
	const webhookDispatch = readQueueConsumer({
		consumers,
		queueName: webhookDispatchQueueName,
		deadLetterQueueName: webhookDispatchDeadLetterQueueName,
		configPath: input.configPath,
		maxBatchSize: 1,
		maxConcurrency: 16,
		maxRetries: 10,
	})
	const producers = queueConfig.producers
	if (!Array.isArray(producers)) {
		throw new Error(
			`wrangler config "${input.configPath}" must define production Queue producers.`,
		)
	}
	readQueueProducer({
		producers,
		binding: platformFeedbackDispatchQueueBinding,
		queueName: platformFeedbackDispatchQueueName,
		configPath: input.configPath,
	})
	readQueueProducer({
		producers,
		binding: communityActivityDispatchQueueBinding,
		queueName: communityActivityDispatchQueueName,
		configPath: input.configPath,
	})
	readQueueProducer({
		producers,
		binding: communityListingPublishedDispatchQueueBinding,
		queueName: communityListingPublishedDispatchQueueName,
		configPath: input.configPath,
	})
	readQueueProducer({
		producers,
		binding: packageEventsDispatchQueueBinding,
		queueName: packageEventsDispatchQueueName,
		configPath: input.configPath,
	})
	readQueueProducer({
		producers,
		binding: webhookDispatchQueueBinding,
		queueName: webhookDispatchQueueName,
		configPath: input.configPath,
	})
	return {
		emailDeliveryQueueName: emailDelivery.queue,
		emailDeliveryDeadLetterQueueName: emailDelivery.deadLetterQueue,
		artifactsRepoEventsQueueName: artifactsRepoEvents.queue,
		artifactsRepoEventsDeadLetterQueueName: artifactsRepoEvents.deadLetterQueue,
		platformFeedbackDispatchQueueName: platformFeedbackDispatch.queue,
		platformFeedbackDispatchDeadLetterQueueName:
			platformFeedbackDispatch.deadLetterQueue,
		communityActivityDispatchQueueName: communityActivityDispatch.queue,
		communityActivityDispatchDeadLetterQueueName:
			communityActivityDispatch.deadLetterQueue,
		communityListingPublishedDispatchQueueName:
			communityListingPublishedDispatch.queue,
		communityListingPublishedDispatchDeadLetterQueueName:
			communityListingPublishedDispatch.deadLetterQueue,
		packageEventsDispatchQueueName: packageEventsDispatch.queue,
		packageEventsDispatchDeadLetterQueueName:
			packageEventsDispatch.deadLetterQueue,
		webhookDispatchQueueName: webhookDispatch.queue,
		webhookDispatchDeadLetterQueueName: webhookDispatch.deadLetterQueue,
	}
}

export type ProductionBoundQueueProducer = {
	binding: string
	queue: string
	deadLetterQueue: string
}

/**
 * Origin producer bindings, in wrangler order, after the production queue
 * config has been validated. Preview provisioning starts from this list.
 */
export function listProductionBoundQueueProducers(input: {
	productionEnv: Record<string, unknown>
	configPath: string
}): Array<ProductionBoundQueueProducer> {
	parseProductionQueueResources(input)
	const queues = input.productionEnv.queues
	if (!queues || typeof queues !== 'object' || Array.isArray(queues)) {
		throw new Error(
			`wrangler config "${input.configPath}" is missing "env.production.queues".`,
		)
	}
	const producers = (queues as Record<string, unknown>).producers
	const consumers = (queues as Record<string, unknown>).consumers
	if (!Array.isArray(producers) || !Array.isArray(consumers)) {
		throw new Error(
			`wrangler config "${input.configPath}" has invalid "env.production.queues".`,
		)
	}
	return producers.map((entry, index) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			throw new Error(
				`wrangler config "${input.configPath}" producer ${String(index)} is not an object.`,
			)
		}
		const producer = entry as Record<string, unknown>
		const binding = producer.binding
		const queue = producer.queue
		if (typeof binding !== 'string' || typeof queue !== 'string') {
			throw new Error(
				`wrangler config "${input.configPath}" producer ${String(index)} is missing binding or queue.`,
			)
		}
		const consumer = consumers.find((candidate) => {
			if (
				!candidate ||
				typeof candidate !== 'object' ||
				Array.isArray(candidate)
			) {
				return false
			}
			return (candidate as Record<string, unknown>).queue === queue
		}) as Record<string, unknown> | undefined
		const deadLetterQueue = consumer?.dead_letter_queue
		if (typeof deadLetterQueue !== 'string') {
			throw new Error(
				`wrangler config "${input.configPath}" producer "${binding}" on "${queue}" has no consumer dead-letter queue.`,
			)
		}
		return { binding, queue, deadLetterQueue }
	})
}
