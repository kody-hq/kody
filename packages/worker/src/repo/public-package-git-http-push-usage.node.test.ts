import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import {
	repoPushQueueAttemptsHeader,
	repoPushQueueDepthHeader,
	repoPushQueuePathHeader,
	repoPushQueueSourceIdHeader,
	repoPushQueueWaitMsHeader,
	repoPushQueueWallMsHeader,
} from '@kody-internal/shared/repo-push-queue-protocol.ts'
import { http, HttpResponse } from 'msw'
import { expect, test, vi } from 'vitest'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'

const evaluateRepoFeatureFlag = vi.fn()

vi.mock('#worker/api-tokens/service.ts', () => ({
	authenticateApiToken: async () => ({
		ok: true,
		record: { user_id: 'user-1', scopes: null },
	}),
	getApiTokenIssuedAtMs: () => 0,
	slideApiTokenExpiry: () => null,
	touchApiToken: async () => false,
}))

vi.mock('#worker/mcp-auth-user-context.ts', () => ({
	buildMcpUserContextFromGrantProps: async () => ({
		user: { userId: 'user-1', username: 'kody' },
		emailVerified: true,
		suspended: false,
		passwordChangedAt: null,
	}),
}))

vi.mock('#worker/password-change-lockout.ts', () => ({
	isCredentialInvalidatedByStoredPasswordChange: () => false,
}))

vi.mock('#worker/repo/git-http-target.ts', () => ({
	resolveGitHttpTargetAccess: async () => ({
		ownerHandle: 'kody',
		repoName: 'probe',
		resourceKind: 'repo',
		resourceId: 'user-repo-1',
		resourceOrgId: ownerIdFromStored('owner-1'),
		sourceId,
		repoId: 'probe',
		canRead: true,
		canWrite: true,
	}),
}))

vi.mock('#worker/feature-flags/repo-flags.ts', () => ({
	evaluateRepoFeatureFlag: (...args: Array<unknown>) =>
		evaluateRepoFeatureFlag(...args),
}))

vi.mock('#worker/repo/artifacts.ts', () => ({
	buildAuthenticatedArtifactsRemote: ({ remote }: { remote: string }) => remote,
	parseArtifactTokenSecret: (token: string) => token,
	resolveExistingArtifactSourceRepo: async () => ({
		info: async () => ({ remote: artifactsRemote, defaultBranch: 'main' }),
		createToken: async () => ({ plaintext: artifactToken }),
	}),
}))

vi.mock('#app/rate-limit.ts', () => ({
	checkRateLimit: async () => ({ allowed: true }),
}))

vi.mock('#worker/audit-log.ts', () => ({
	getRequestIp: () => '203.0.113.10',
}))

const { handlePublicPackageGitHttpRequest } =
	await import('./public-package-git-http.ts')

const sourceId = '57a9ce42-dfc2-4867-bc01-2c0d05f23f07'
const artifactsRemote =
	'https://acct.artifacts.cloudflare.net/git/default/probe.git'
const artifactToken = 'art_plain_write_token'
const apiToken = `kody_at_${'a'.repeat(20)}_${'B'.repeat(43)}`
const packResult = '000eunpack ok\n0000'

function analyticsDataset() {
	const points: Array<AnalyticsEngineDataPoint> = []
	const binding = {
		writeDataPoint: (point?: AnalyticsEngineDataPoint) => {
			if (point) points.push(point)
		},
	} as AnalyticsEngineDataset
	return { points, binding }
}

async function pushOnce(input: { flagEnabled: boolean; queue: Fetcher }) {
	evaluateRepoFeatureFlag.mockReset()
	evaluateRepoFeatureFlag.mockResolvedValue({
		enabled: input.flagEnabled,
		source: 'global',
		repoOverride: false,
	})
	const usageEvents = analyticsDataset()
	const response = await handlePublicPackageGitHttpRequest(
		new Request('https://kody.codes/@kody/probe.git/git-receive-pack', {
			method: 'POST',
			headers: {
				Authorization: `Basic ${btoa(`kody:${apiToken}`)}`,
				'Content-Type': 'application/x-git-receive-pack-request',
			},
			body: 'PACK',
		}),
		{
			APP_DB: {},
			USAGE_EVENTS: usageEvents.binding,
			FLAG_EXPOSURES: analyticsDataset().binding,
			REPO_PUSH_QUEUE: input.queue,
		} as unknown as Env,
	)
	const gitPushes = usageEvents.points
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
	return { response: response!, gitPushes }
}

test('one plain-repo push on the canonical remote records one queued git_push', async () => {
	const handedSourceIds: Array<string | null> = []
	const queue = {
		fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
			handedSourceIds.push(
				new Request(input, init).headers.get(repoPushQueueSourceIdHeader),
			)
			return new Response(packResult, {
				status: 200,
				headers: {
					[repoPushQueuePathHeader]: 'v1',
					[repoPushQueueWallMsHeader]: '4500',
					[repoPushQueueWaitMsHeader]: '1200',
					[repoPushQueueDepthHeader]: '3',
					[repoPushQueueAttemptsHeader]: '2',
				},
			})
		},
	} as Fetcher

	const { response, gitPushes } = await pushOnce({ flagEnabled: true, queue })

	expect(response.status).toBe(200)
	expect(await response.text()).toBe(packResult)
	expect(handedSourceIds).toEqual([sourceId])
	expect(gitPushes).toEqual([
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
})

test('one plain-repo push on the canonical remote records one direct git_push', async () => {
	const artifactsCalls: Array<string> = []
	using _server = createMswNodeServer([
		http.post(`${artifactsRemote}/git-receive-pack`, async ({ request }) => {
			artifactsCalls.push(request.headers.get('Authorization') ?? '')
			return HttpResponse.text(packResult, { status: 200 })
		}),
	])
	const queue = {
		fetch: async () => new Response('unexpected', { status: 500 }),
	} as unknown as Fetcher

	const { response, gitPushes } = await pushOnce({ flagEnabled: false, queue })

	expect(response.status).toBe(200)
	expect(await response.text()).toBe(packResult)
	expect(artifactsCalls).toEqual([`Bearer ${artifactToken}`])
	expect(gitPushes).toEqual([
		{
			userId: 'owner-1',
			path: 'direct',
			outcome: 'success',
			errorName: '',
			durationMs: expect.any(Number),
			waitMs: expect.any(Number),
			queueDepth: 0,
			attempts: 1,
		},
	])
	expect(gitPushes[0]!.durationMs).toBeGreaterThanOrEqual(gitPushes[0]!.waitMs!)
})
