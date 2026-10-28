import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import {
	repoPushQueueAttemptsHeader,
	repoPushQueueDepthHeader,
	repoPushQueueOutcomeHeader,
	repoPushQueuePathHeader,
	repoPushQueueSourceIdHeader,
	repoPushQueueUpstreamHeader,
	repoPushQueueV1Path,
	repoPushQueueWaitMsHeader,
	repoPushQueueWallMsHeader,
} from '@kody-internal/shared/repo-push-queue-protocol.ts'
import { http, HttpResponse } from 'msw'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'

const getEntitySourceById = vi.fn()
const resolveExistingArtifactSourceRepo = vi.fn()
const evaluateRepoFeatureFlag = vi.fn()

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		getEntitySourceById(...args),
}))

vi.mock('#worker/feature-flags/repo-flags.ts', () => ({
	evaluateRepoFeatureFlag: (...args: Array<unknown>) =>
		evaluateRepoFeatureFlag(...args),
}))

vi.mock('#worker/repo/artifacts.ts', () => ({
	buildAuthenticatedArtifactsRemote: ({ remote }: { remote: string }) => remote,
	parseArtifactTokenSecret: (token: string) =>
		token.split('?expires=')[0] ?? token,
	resolveExistingArtifactSourceRepo: (...args: Array<unknown>) =>
		resolveExistingArtifactSourceRepo(...args),
}))

function fakeAnalyticsDataset() {
	const points: Array<AnalyticsEngineDataPoint> = []
	return {
		points,
		binding: {
			writeDataPoint: (point?: AnalyticsEngineDataPoint) => {
				if (point) points.push(point)
			},
		} as AnalyticsEngineDataset,
	}
}

let usageEvents = fakeAnalyticsDataset()
let flagExposures = fakeAnalyticsDataset()

const { handlePlainRepoGitHttpRequest } =
	await import('./plain-repo-git-http.ts')

const sourceId = '57a9ce42-dfc2-4867-bc01-2c0d05f23f07'
const artifactsRemote =
	'https://acct.artifacts.cloudflare.net/git/default/concurrency.git'
const artifactToken = 'art_plain_token_secret'
const packResult = '000eunpack ok\n0000'

function seed() {
	usageEvents = fakeAnalyticsDataset()
	flagExposures = fakeAnalyticsDataset()
	getEntitySourceById.mockReset()
	resolveExistingArtifactSourceRepo.mockReset()
	evaluateRepoFeatureFlag.mockReset()
	getEntitySourceById.mockResolvedValue({
		id: sourceId,
		user_id: ownerIdFromStored('owner-1'),
		entity_kind: 'repo',
		entity_id: 'user-repo-1',
		repo_id: 'concurrency',
		published_commit: null,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '.',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
	})
	resolveExistingArtifactSourceRepo.mockResolvedValue({
		info: async () => ({ remote: artifactsRemote }),
	})
}

function pushRequest(body = 'PACK') {
	return new Request(
		`https://kody.codes/git/sources/${sourceId}.git/git-receive-pack`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${artifactToken}`,
				'Content-Type': 'application/x-git-receive-pack-request',
			},
			body,
		},
	)
}

function directArtifactsServer() {
	const calls: Array<string> = []
	const server = createMswNodeServer([
		http.post(`${artifactsRemote}/git-receive-pack`, async ({ request }) => {
			calls.push(await request.text())
			return HttpResponse.text(packResult, { status: 200 })
		}),
	])
	return { server, calls }
}

function fakeQueue(handler: (request: Request) => Promise<Response>): {
	binding: Fetcher
	requests: Array<Request>
} {
	const requests: Array<Request> = []
	return {
		requests,
		binding: {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init)
				requests.push(request)
				return handler(request)
			},
		} as Fetcher,
	}
}

test('flagged repos hand receive-pack to the push queue, not Artifacts', async () => {
	seed()
	evaluateRepoFeatureFlag.mockResolvedValue({
		enabled: true,
		source: 'override',
		repoOverride: true,
	})
	const direct = directArtifactsServer()
	using _server = direct.server
	let handedBody = ''
	const queue = fakeQueue(async (request) => {
		handedBody = await request.text()
		return new Response(packResult, {
			status: 200,
			headers: {
				'Content-Type': 'application/x-git-receive-pack-result',
				[repoPushQueuePathHeader]: 'v1',
				[repoPushQueueWaitMsHeader]: '42',
				'Set-Cookie': 'must-not-leak=1',
			},
		})
	})

	const response = await handlePlainRepoGitHttpRequest(pushRequest('PACK-Q'), {
		APP_DB: {},
		USAGE_EVENTS: usageEvents.binding,
		FLAG_EXPOSURES: flagExposures.binding,
		REPO_PUSH_QUEUE: queue.binding,
	} as unknown as Env)

	expect(response!.status).toBe(200)
	expect(await response!.text()).toBe(packResult)
	expect(response!.headers.get(repoPushQueuePathHeader)).toBe('v1')
	expect(response!.headers.get(repoPushQueueWaitMsHeader)).toBe('42')
	expect(response!.headers.get('Set-Cookie')).toBeNull()
	expect(direct.calls).toEqual([])
	expect(handedBody).toBe('PACK-Q')

	const handed = queue.requests[0]!
	expect(new URL(handed.url).pathname).toBe(repoPushQueueV1Path)
	expect(handed.headers.get(repoPushQueueSourceIdHeader)).toBe(sourceId)
	expect(handed.headers.get(repoPushQueueUpstreamHeader)).toBe(
		`${artifactsRemote}/git-receive-pack`,
	)
	expect(handed.headers.get('Authorization')).toBe(`Bearer ${artifactToken}`)
	expect(evaluateRepoFeatureFlag).toHaveBeenCalledWith({}, 'repo-push-queue', {
		sourceId,
		ownerId: 'owner-1',
	})
})

test('unflagged repos keep the isolate-local wait-and-retry path', async () => {
	seed()
	evaluateRepoFeatureFlag.mockResolvedValue({
		enabled: false,
		source: 'global',
		repoOverride: false,
	})
	const direct = directArtifactsServer()
	using _server = direct.server
	const queue = fakeQueue(async () => new Response('unexpected'))

	const response = await handlePlainRepoGitHttpRequest(pushRequest('PACK-D'), {
		APP_DB: {},
		USAGE_EVENTS: usageEvents.binding,
		FLAG_EXPOSURES: flagExposures.binding,
		REPO_PUSH_QUEUE: queue.binding,
	} as unknown as Env)

	expect(response!.status).toBe(200)
	expect(await response!.text()).toBe(packResult)
	expect(response!.headers.get(repoPushQueuePathHeader)).toBe('off')
	expect(direct.calls).toEqual(['PACK-D'])
	expect(queue.requests).toEqual([])
})

test('flag evaluation failures fail closed to the direct path', async () => {
	seed()
	consoleWarn.mockImplementation(() => {})
	evaluateRepoFeatureFlag.mockRejectedValue(new Error('D1 unavailable'))
	const direct = directArtifactsServer()
	using _server = direct.server
	const queue = fakeQueue(async () => new Response('unexpected'))

	const response = await handlePlainRepoGitHttpRequest(pushRequest(), {
		APP_DB: {},
		USAGE_EVENTS: usageEvents.binding,
		FLAG_EXPOSURES: flagExposures.binding,
		REPO_PUSH_QUEUE: queue.binding,
	} as unknown as Env)

	expect(response!.status).toBe(200)
	expect(response!.headers.get(repoPushQueuePathHeader)).toBe('off')
	expect(queue.requests).toEqual([])
	expect(consoleWarn).toHaveBeenCalledWith(
		'repo-push-queue-flag-evaluation-failed',
		expect.objectContaining({ sourceId }),
	)
})

test('an unhealthy queue returns a retryable 503 with no fallback to Artifacts', async () => {
	seed()
	consoleWarn.mockImplementation(() => {})
	evaluateRepoFeatureFlag.mockResolvedValue({
		enabled: true,
		source: 'global',
		repoOverride: false,
	})
	const direct = directArtifactsServer()
	using _server = direct.server
	const queue = fakeQueue(async () => {
		throw new Error('Durable Object reset because its code was updated.')
	})

	const response = await handlePlainRepoGitHttpRequest(pushRequest(), {
		APP_DB: {},
		USAGE_EVENTS: usageEvents.binding,
		FLAG_EXPOSURES: flagExposures.binding,
		REPO_PUSH_QUEUE: queue.binding,
	} as unknown as Env)

	expect(response!.status).toBe(503)
	expect(response!.headers.get('Retry-After')).toBe('2')
	expect(response!.headers.get(repoPushQueueOutcomeHeader)).toBe('unavailable')
	expect(response!.headers.get(repoPushQueuePathHeader)).toBe('v1')
	expect(direct.calls).toEqual([])
})

test('without the queue binding (local dev, tests) the flag is not consulted', async () => {
	seed()
	const direct = directArtifactsServer()
	using _server = direct.server

	const response = await handlePlainRepoGitHttpRequest(pushRequest(), {
		APP_DB: {},
		USAGE_EVENTS: usageEvents.binding,
		FLAG_EXPOSURES: flagExposures.binding,
	} as unknown as Env)

	expect(response!.status).toBe(200)
	expect(response!.headers.get(repoPushQueuePathHeader)).toBe('off')
	expect(evaluateRepoFeatureFlag).not.toHaveBeenCalled()
	expect(direct.calls).toEqual(['PACK'])
})

function gitPushPoints() {
	return usageEvents.points
		.filter((point) => point.blobs?.[1] === 'git_push')
		.map((point) => ({
			userId: point.blobs?.[0],
			path: point.blobs?.[2],
			outcome: point.blobs?.[3],
			errorName: point.blobs?.[12],
			durationMs: point.doubles?.[0],
			waitMs: point.doubles?.[5],
			queueDepth: point.doubles?.[6],
			attempts: point.doubles?.[7],
		}))
}

function exposurePoints() {
	return flagExposures.points.map((point) => point.blobs?.slice(0, 4))
}

test('queued pushes record git_push cost from queue headers and an owner exposure', async () => {
	seed()
	evaluateRepoFeatureFlag.mockResolvedValue({
		enabled: true,
		source: 'rollout',
		repoOverride: false,
	})
	const queue = fakeQueue(
		async () =>
			new Response(packResult, {
				status: 200,
				headers: {
					[repoPushQueuePathHeader]: 'v1',
					[repoPushQueueWaitMsHeader]: '1200',
					[repoPushQueueDepthHeader]: '3',
					[repoPushQueueWallMsHeader]: '4500',
					[repoPushQueueAttemptsHeader]: '2',
				},
			}),
	)

	const response = await handlePlainRepoGitHttpRequest(pushRequest(), {
		APP_DB: {},
		USAGE_EVENTS: usageEvents.binding,
		FLAG_EXPOSURES: flagExposures.binding,
		REPO_PUSH_QUEUE: queue.binding,
	} as unknown as Env)

	expect(response!.status).toBe(200)
	expect(gitPushPoints()).toEqual([
		{
			userId: 'owner-1',
			path: 'queued',
			outcome: 'success',
			errorName: '',
			durationMs: 4500,
			waitMs: 1200,
			queueDepth: 3,
			attempts: 2,
		},
	])
	expect(exposurePoints()).toEqual([
		['owner-1', 'repo-push-queue', 'on', 'rollout'],
	])
})

test('queue timeouts and busy rejections are recorded as git_push errors', async () => {
	for (const [outcome, errorName] of [
		['timeout', 'timeout'],
		['full', 'busy'],
	] as const) {
		seed()
		evaluateRepoFeatureFlag.mockResolvedValue({
			enabled: true,
			source: 'global',
			repoOverride: false,
		})
		const queue = fakeQueue(
			async () =>
				new Response('repository busy, retry', {
					status: 503,
					headers: {
						'Retry-After': '2',
						[repoPushQueuePathHeader]: 'v1',
						[repoPushQueueOutcomeHeader]: outcome,
						[repoPushQueueDepthHeader]: '64',
						[repoPushQueueWallMsHeader]: '90001',
					},
				}),
		)
		const response = await handlePlainRepoGitHttpRequest(pushRequest(), {
			APP_DB: {},
			USAGE_EVENTS: usageEvents.binding,
			FLAG_EXPOSURES: flagExposures.binding,
			REPO_PUSH_QUEUE: queue.binding,
		} as unknown as Env)
		expect(response!.status).toBe(503)
		expect(gitPushPoints()).toEqual([
			expect.objectContaining({
				path: 'queued',
				outcome: 'error',
				errorName,
				durationMs: 90001,
				queueDepth: 64,
			}),
		])
	}
})

test('direct pushes record the wait-and-retry outcome and an off exposure', async () => {
	seed()
	evaluateRepoFeatureFlag.mockResolvedValue({
		enabled: false,
		source: 'default',
		repoOverride: false,
	})
	const direct = directArtifactsServer()
	using _server = direct.server
	const queue = fakeQueue(async () => new Response('unexpected'))

	await handlePlainRepoGitHttpRequest(pushRequest(), {
		APP_DB: {},
		USAGE_EVENTS: usageEvents.binding,
		FLAG_EXPOSURES: flagExposures.binding,
		REPO_PUSH_QUEUE: queue.binding,
	} as unknown as Env)

	const [point] = gitPushPoints()
	expect(point).toEqual(
		expect.objectContaining({
			userId: 'owner-1',
			path: 'direct',
			outcome: 'success',
			queueDepth: 0,
			attempts: 1,
		}),
	)
	expect(point!.durationMs).toBeGreaterThanOrEqual(point!.waitMs!)
	expect(exposurePoints()).toEqual([
		['owner-1', 'repo-push-queue', 'off', 'default'],
	])
})

test('pushes record git_push without an exposure when the flag was not evaluated', async () => {
	seed()
	consoleWarn.mockImplementation(() => {})
	evaluateRepoFeatureFlag.mockRejectedValue(new Error('D1 unavailable'))
	const direct = directArtifactsServer()
	using _server = direct.server
	const queue = fakeQueue(async () => new Response('unexpected'))

	await handlePlainRepoGitHttpRequest(pushRequest(), {
		APP_DB: {},
		USAGE_EVENTS: usageEvents.binding,
		FLAG_EXPOSURES: flagExposures.binding,
		REPO_PUSH_QUEUE: queue.binding,
	} as unknown as Env)

	expect(gitPushPoints()).toEqual([
		expect.objectContaining({ path: 'direct', outcome: 'success' }),
	])
	expect(exposurePoints()).toEqual([])
})
