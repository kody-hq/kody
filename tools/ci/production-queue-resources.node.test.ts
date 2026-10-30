import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { parseProductionQueueResources } from './production-queue-resources.ts'
import { parseJsonc } from './resource-utils.ts'

function createProductionEnv() {
	const consumer = (queue: string, settings: Record<string, number> = {}) => ({
		queue,
		max_batch_size: 10,
		max_batch_timeout: 5,
		max_retries: 3,
		...settings,
		dead_letter_queue: `${queue}-dlq`,
	})
	const deadLetterConsumer = (queue: string) => ({
		queue,
		max_batch_size: 10,
		max_batch_timeout: 5,
		max_retries: 100,
		retry_delay: 60,
	})
	return {
		queues: {
			producers: [
				'PLATFORM_FEEDBACK',
				'COMMUNITY_ACTIVITY',
				'COMMUNITY_LISTING_PUBLISHED',
				'PACKAGE_EVENTS',
				'WEBHOOK',
			].map((name) => ({
				binding: `${name}_DISPATCH_QUEUE`,
				queue: `kody-${name.toLowerCase().replaceAll('_', '-')}-dispatch`,
			})),
			consumers: [
				consumer('kody-email-delivery'),
				consumer('kody-artifacts-repo-events'),
				consumer('kody-platform-feedback-dispatch'),
				consumer('kody-community-activity-dispatch'),
				consumer('kody-community-listing-published-dispatch'),
				consumer('kody-package-events-dispatch', { max_concurrency: 16 }),
				consumer('kody-webhook-dispatch', {
					max_batch_size: 1,
					max_retries: 10,
					max_concurrency: 16,
				}),
				...[
					'kody-email-delivery-dlq',
					'kody-artifacts-repo-events-dlq',
					'kody-platform-feedback-dispatch-dlq',
					'kody-community-activity-dispatch-dlq',
					'kody-community-listing-published-dispatch-dlq',
					'kody-package-events-dispatch-dlq',
					'kody-webhook-dispatch-dlq',
					'kody-scheduled-dispatch-dlq',
				].map(deadLetterConsumer),
			],
		},
	}
}

function parseEnv(
	mutate: (env: ReturnType<typeof createProductionEnv>) => void,
) {
	const productionEnv = createProductionEnv()
	mutate(productionEnv)
	return () =>
		parseProductionQueueResources({
			productionEnv,
			configPath: 'wrangler.jsonc',
		})
}

test('production queue config requires all consumers and consistent producers', () => {
	const wranglerConfig = parseJsonc<{
		env: { production: Record<string, unknown> }
	}>(
		readFileSync(
			new URL('../../packages/worker/wrangler.jsonc', import.meta.url),
			'utf8',
		),
	)
	expect(
		parseProductionQueueResources({
			productionEnv: wranglerConfig.env.production,
			configPath: 'packages/worker/wrangler.jsonc',
		}),
	).toEqual({
		emailDeliveryQueueName: 'kody-email-delivery',
		emailDeliveryDeadLetterQueueName: 'kody-email-delivery-dlq',
		artifactsRepoEventsQueueName: 'kody-artifacts-repo-events',
		artifactsRepoEventsDeadLetterQueueName: 'kody-artifacts-repo-events-dlq',
		platformFeedbackDispatchQueueName: 'kody-platform-feedback-dispatch',
		platformFeedbackDispatchDeadLetterQueueName:
			'kody-platform-feedback-dispatch-dlq',
		communityActivityDispatchQueueName: 'kody-community-activity-dispatch',
		communityActivityDispatchDeadLetterQueueName:
			'kody-community-activity-dispatch-dlq',
		communityListingPublishedDispatchQueueName:
			'kody-community-listing-published-dispatch',
		communityListingPublishedDispatchDeadLetterQueueName:
			'kody-community-listing-published-dispatch-dlq',
		packageEventsDispatchQueueName: 'kody-package-events-dispatch',
		packageEventsDispatchDeadLetterQueueName:
			'kody-package-events-dispatch-dlq',
		webhookDispatchQueueName: 'kody-webhook-dispatch',
		webhookDispatchDeadLetterQueueName: 'kody-webhook-dispatch-dlq',
	})

	expect(parseEnv(() => {})).not.toThrow()
	expect(
		parseEnv((env) => {
			env.queues.consumers.pop()
		}),
	).toThrow('exactly 15 production Queue consumers')
	expect(
		parseEnv((env) => {
			env.queues.consumers = env.queues.consumers.map((consumer) =>
				consumer.queue === 'kody-scheduled-dispatch-dlq'
					? { ...consumer, queue: 'kody-unrelated-queue' }
					: consumer,
			)
		}),
	).toThrow(
		'must define the production dead-letter Queue consumer "kody-scheduled-dispatch-dlq"',
	)
	expect(
		parseEnv((env) => {
			const consumer = env.queues.consumers.find(
				(candidate) =>
					candidate.queue === 'kody-platform-feedback-dispatch-dlq',
			)
			Object.assign(consumer ?? {}, { max_retries: 3 })
		}),
	).toThrow(
		'invalid production dead-letter consumer settings for "kody-platform-feedback-dispatch-dlq"',
	)
	expect(
		parseEnv((env) => {
			env.queues.producers[0] = {
				binding: 'PLATFORM_FEEDBACK_DISPATCH_QUEUE',
				queue: 'wrong-queue',
			}
		}),
	).toThrow(
		'must bind "PLATFORM_FEEDBACK_DISPATCH_QUEUE" to "kody-platform-feedback-dispatch"',
	)
	for (const [binding, queue] of [
		['COMMUNITY_ACTIVITY_DISPATCH_QUEUE', 'kody-community-activity-dispatch'],
		[
			'COMMUNITY_LISTING_PUBLISHED_DISPATCH_QUEUE',
			'kody-community-listing-published-dispatch',
		],
		['PACKAGE_EVENTS_DISPATCH_QUEUE', 'kody-package-events-dispatch'],
	]) {
		expect(
			parseEnv((env) => {
				env.queues.producers = env.queues.producers.filter(
					(producer) => producer.binding !== binding,
				)
			}),
		).toThrow(`must bind "${binding}" to "${queue}"`)
	}

	for (const invalidSettings of [
		{ max_batch_size: 2 },
		{ max_batch_timeout: 1 },
		{ max_concurrency: 1 },
	]) {
		expect(
			parseEnv((env) => {
				const webhook = env.queues.consumers.find(
					(consumer) => consumer.queue === 'kody-webhook-dispatch',
				)
				Object.assign(webhook ?? {}, invalidSettings)
			}),
		).toThrow(
			'invalid production consumer settings for "kody-webhook-dispatch"',
		)
	}
})
