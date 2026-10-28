import {
	repoPushQueueOutcomeHeader,
	repoPushQueuePositionHeader,
} from '@kody-internal/shared/repo-push-queue-protocol.ts'
import { expect, test } from 'vitest'
import {
	classifyReceivePackResponse,
	measureReceivePack,
} from './receive-pack-metrics.ts'

function response(status: number, headers: Record<string, string> = {}) {
	return new Response(null, { status, headers })
}

test('classifies receive-pack responses into ok, busy, timeout, and error', () => {
	expect(classifyReceivePackResponse(response(200), 'queued')).toEqual({
		kind: 'ok',
		errorName: null,
	})
	expect(
		classifyReceivePackResponse(
			response(503, { [repoPushQueueOutcomeHeader]: 'timeout' }),
			'queued',
		),
	).toEqual({ kind: 'timeout', errorName: 'timeout' })
	expect(
		classifyReceivePackResponse(
			response(503, { [repoPushQueueOutcomeHeader]: 'full' }),
			'queued',
		),
	).toEqual({ kind: 'busy', errorName: 'busy' })
	expect(
		classifyReceivePackResponse(
			response(503, { [repoPushQueueOutcomeHeader]: 'unavailable' }),
			'queued',
		),
	).toEqual({ kind: 'error', errorName: 'queue_unavailable' })
	expect(
		classifyReceivePackResponse(
			response(503, { 'Retry-After': '5' }),
			'direct',
		),
	).toEqual({ kind: 'busy', errorName: 'busy' })
	expect(classifyReceivePackResponse(response(503), 'direct')).toEqual({
		kind: 'error',
		errorName: 'upstream_5xx',
	})
	expect(classifyReceivePackResponse(response(413), 'direct')).toEqual({
		kind: 'error',
		errorName: 'too_large',
	})
	expect(classifyReceivePackResponse(response(408), 'queued')).toEqual({
		kind: 'error',
		errorName: 'body_timeout',
	})
	expect(classifyReceivePackResponse(response(401), 'direct')).toEqual({
		kind: 'error',
		errorName: 'upstream_4xx',
	})
	expect(classifyReceivePackResponse(null, 'direct')).toEqual({
		kind: 'error',
		errorName: 'proxy_error',
	})
})

test('queued metrics fall back to origin wall time and position for older queue workers', () => {
	const metrics = measureReceivePack({
		path: 'queued',
		response: response(200, { [repoPushQueuePositionHeader]: '2' }),
		startedAt: 1_000,
		endedAt: 1_750,
		direct: { attempts: 0, gateAcquiredAt: null, firstSendAt: null },
	})
	expect(metrics).toMatchObject({
		durationMs: 750,
		waitMs: 0,
		queueDepth: 2,
		attempts: 0,
	})
})

test('direct metrics measure wait until the first Artifacts send', () => {
	expect(
		measureReceivePack({
			path: 'direct',
			response: response(200),
			startedAt: 1_000,
			endedAt: 3_000,
			direct: { attempts: 3, gateAcquiredAt: 1_200, firstSendAt: 1_400 },
		}),
	).toMatchObject({
		durationMs: 2_000,
		waitMs: 400,
		queueDepth: 0,
		attempts: 3,
	})
	expect(
		measureReceivePack({
			path: 'direct',
			response: response(503, { 'Retry-After': '5' }),
			startedAt: 1_000,
			endedAt: 46_000,
			direct: { attempts: 0, gateAcquiredAt: null, firstSendAt: null },
		}),
	).toMatchObject({ waitMs: 45_000, outcome: { kind: 'busy' } })
	expect(
		measureReceivePack({
			path: 'direct',
			response: response(413),
			startedAt: 1_000,
			endedAt: 1_300,
			direct: { attempts: 0, gateAcquiredAt: null, firstSendAt: null },
		}),
	).toMatchObject({ durationMs: 300, waitMs: 0, attempts: 0 })
	expect(
		measureReceivePack({
			path: 'direct',
			response: response(408),
			startedAt: 1_000,
			endedAt: 9_000,
			direct: { attempts: 0, gateAcquiredAt: 3_500, firstSendAt: null },
		}),
	).toMatchObject({ durationMs: 8_000, waitMs: 2_500, attempts: 0 })
})
