import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

import { parseJsonc } from './resource-utils.ts'
import { assertPreviewResourceName } from './preview-resources.ts'
import {
	planPreviewOriginQueues,
	previewInlineOnlyQueueBindings,
	previewQueueName,
} from './preview-queue-plan.ts'

type QueueProducer = { binding?: string; queue?: string }
type QueueConsumer = {
	queue?: string
	dead_letter_queue?: string
	max_batch_size?: number
	max_batch_timeout?: number
	max_retries?: number
	max_concurrency?: number
}

function readQueues(configPath: string, envName: 'production' | 'preview') {
	const config = parseJsonc<{
		env?: Record<
			string,
			{
				queues?: {
					producers?: Array<QueueProducer>
					consumers?: Array<QueueConsumer>
				}
			}
		>
	}>(readFileSync(configPath, 'utf8'))
	const queues = config.env?.[envName]?.queues
	if (!queues?.producers) {
		throw new Error(`${configPath} env.${envName} is missing queue producers.`)
	}
	return queues
}

function bindingNames(producers: Array<QueueProducer>) {
	return producers.map((producer) => producer.binding)
}

const originConfigPath = 'packages/worker/wrangler.jsonc'
const siblingConfigPaths = [
	'packages/platform-worker/wrangler.jsonc',
	'packages/runtime-worker/wrangler.jsonc',
]

test('preview origin queues are the production producers except the inline-only set', () => {
	const production = readQueues(originConfigPath, 'production')
	const preview = readQueues(originConfigPath, 'preview')
	const expected = (production.producers ?? [])
		.map((producer) => producer.binding)
		.filter(
			(binding) =>
				typeof binding === 'string' &&
				!previewInlineOnlyQueueBindings.has(binding),
		)
	expect(bindingNames(preview.producers ?? [])).toEqual(expected)
	expect(
		previewInlineOnlyQueueBindings.has('PACKAGE_EVENTS_DISPATCH_QUEUE'),
	).toBe(true)

	for (const producer of preview.producers ?? []) {
		const consumer = preview.consumers?.find(
			(entry) => entry.queue === producer.queue,
		)
		expect(consumer?.dead_letter_queue).toBe(`${producer.queue}-dlq`)
		const productionProducer = production.producers?.find(
			(entry) => entry.binding === producer.binding,
		)
		const productionConsumer = production.consumers?.find(
			(entry) => entry.queue === productionProducer?.queue,
		)
		expect(consumer?.max_batch_size).toBe(productionConsumer?.max_batch_size)
		expect(consumer?.max_batch_timeout).toBe(
			productionConsumer?.max_batch_timeout,
		)
		expect(consumer?.max_retries).toBe(productionConsumer?.max_retries)
		expect(consumer?.max_concurrency).toBe(productionConsumer?.max_concurrency)
	}
})

test('platform and runtime preview producers match the origin preview plan', () => {
	const originPreview = bindingNames(
		readQueues(originConfigPath, 'preview').producers ?? [],
	)
	for (const configPath of siblingConfigPaths) {
		expect(
			bindingNames(readQueues(configPath, 'preview').producers ?? []),
		).toEqual(originPreview)
		const production = bindingNames(
			readQueues(configPath, 'production').producers ?? [],
		)
		expect(
			production.filter((binding) => !originPreview.includes(binding)),
		).toEqual(['PACKAGE_EVENTS_DISPATCH_QUEUE'])
	}
})

test('preview queue names are per-worker copies of the production queue names', () => {
	const plan = planPreviewOriginQueues('kody-pr-42')
	expect(plan.bindings.map((binding) => binding.binding)).toContain(
		'PLATFORM_FEEDBACK_DISPATCH_QUEUE',
	)
	expect(plan.bindings.map((binding) => binding.binding)).not.toContain(
		'PACKAGE_EVENTS_DISPATCH_QUEUE',
	)
	expect(
		plan.bindings.find(
			(binding) => binding.binding === 'PLATFORM_FEEDBACK_DISPATCH_QUEUE',
		),
	).toMatchObject({
		queue: 'kody-pr-42-platform-feedback-dispatch',
		deadLetterQueue: 'kody-pr-42-platform-feedback-dispatch-dlq',
	})
	expect(
		plan.bindings.find(
			(binding) => binding.binding === 'WEBHOOK_DISPATCH_QUEUE',
		),
	).toMatchObject({
		queue: 'kody-pr-42-webhook-dispatch',
		deadLetterQueue: 'kody-pr-42-webhook-dispatch-dlq',
	})
	for (const name of plan.queueNames) {
		expect(() => assertPreviewResourceName(name, 'queue')).not.toThrow()
		expect(name).not.toBe('kody-preview-jobs')
		expect(name).not.toBe('kody-capabilities-preview')
	}

	const longWorkerName = `kody-branch-${'a1'.repeat(15)}-z`
	const otherLongWorkerName = `kody-branch-${'a1'.repeat(15)}-y`
	const productionDlq = 'kody-community-listing-published-dispatch-dlq'
	const longName = previewQueueName(longWorkerName, productionDlq)
	const otherLongName = previewQueueName(otherLongWorkerName, productionDlq)
	expect(longName).not.toBe(otherLongName)
	expect(longName.endsWith('-community-listing-published-dispatch-dlq')).toBe(
		true,
	)
	expect(longName.length).toBeLessThanOrEqual(63)
	expect(otherLongName.length).toBeLessThanOrEqual(63)
	expect(() => assertPreviewResourceName(longName, 'queue')).not.toThrow()
	expect(() => assertPreviewResourceName(otherLongName, 'queue')).not.toThrow()
})
