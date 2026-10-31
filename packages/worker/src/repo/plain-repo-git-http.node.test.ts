import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'

const getEntitySourceById = vi.fn()
const resolveExistingArtifactSourceRepo = vi.fn()

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

function testEnv() {
	return {
		APP_DB: {},
		USAGE_EVENTS: fakeAnalyticsDataset().binding,
	} as unknown as Env
}

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		getEntitySourceById(...args),
}))

vi.mock('#worker/repo/artifacts.ts', () => ({
	buildAuthenticatedArtifactsRemote: ({
		remote,
		token,
	}: {
		remote: string
		token: string
	}) => {
		const url = new URL(remote)
		url.username = 'x'
		url.password = token.split('?expires=')[0] ?? token
		return url.toString()
	},
	parseArtifactTokenSecret: (token: string) =>
		token.split('?expires=')[0] ?? token,
	resolveExistingArtifactSourceRepo: (...args: Array<unknown>) =>
		resolveExistingArtifactSourceRepo(...args),
}))

const {
	artifactsGitReceivePackBusyCode,
	artifactsReceivePackWaitBudgetMs,
	extractArtifactsTokenFromRequest,
	handlePlainRepoGitHttpRequest,
	isArtifactsGitReceivePackBusyResponse,
	parsePlainRepoGitHttpPath,
	readCappedResponseText,
	repositoryBusyRetryResponse,
} = await import('./plain-repo-git-http.ts')

const sourceId = '11111111-1111-4111-8111-111111111111'
const artifactsRemote =
	'https://acct.artifacts.cloudflare.net/git/default/plain-notes.git'
const artifactToken = 'art_plain_token_secret'

function resetMocks() {
	getEntitySourceById.mockReset()
	resolveExistingArtifactSourceRepo.mockReset()
}

function seedPlainRepo() {
	getEntitySourceById.mockResolvedValue({
		id: sourceId,
		user_id: ownerIdFromStored('owner-1'),
		entity_kind: 'repo',
		entity_id: 'user-repo-1',
		repo_id: 'plain-notes',
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
		info: async () => ({
			id: 'plain-notes',
			name: 'plain-notes',
			description: null,
			defaultBranch: 'main',
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			lastPushAt: null,
			source: null,
			readOnly: false,
			remote: artifactsRemote,
		}),
		createToken: async () => {
			throw new Error('proxy must not mint tokens')
		},
	})
}

test('parsePlainRepoGitHttpPath matches UUID remotes and rejects junk', () => {
	expect(parsePlainRepoGitHttpPath(`/git/sources/${sourceId}.git`)).toEqual({
		kind: 'repo-root',
		sourceId,
	})
	expect(
		parsePlainRepoGitHttpPath(`/git/sources/${sourceId}.git/info/refs`),
	).toEqual({ kind: 'info-refs', sourceId })
	expect(
		parsePlainRepoGitHttpPath(`/git/sources/${sourceId}.git/git-receive-pack`),
	).toEqual({ kind: 'receive-pack', sourceId })
	expect(
		parsePlainRepoGitHttpPath(`/git/sources/${sourceId}.git/git-upload-pack`),
	).toEqual({ kind: 'upload-pack', sourceId })
	expect(parsePlainRepoGitHttpPath('/git/sources/not-a-uuid.git')).toBeNull()
	expect(parsePlainRepoGitHttpPath('/@user/pkg.git')).toBeNull()
})

test('busy detector never rewrites success and matches the Artifacts code', () => {
	expect(
		isArtifactsGitReceivePackBusyResponse({
			status: 200,
			bodyText: artifactsGitReceivePackBusyCode,
		}),
	).toBe(false)
	expect(
		isArtifactsGitReceivePackBusyResponse({
			status: 500,
			bodyText: `remote: ${artifactsGitReceivePackBusyCode}\n`,
		}),
	).toBe(true)
	expect(
		isArtifactsGitReceivePackBusyResponse({
			status: 500,
			bodyText: 'something else',
		}),
	).toBe(false)
})

test('readCappedResponseText detects busy marker in a truncated error body', async () => {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				new TextEncoder().encode(
					`remote: ${artifactsGitReceivePackBusyCode}\n`,
				),
			)
			queueMicrotask(() => controller.error(new Error('upstream truncated')))
		},
	})
	const response = new Response(body, { status: 500 })
	const text = await readCappedResponseText(response)
	expect(
		isArtifactsGitReceivePackBusyResponse({ status: 500, bodyText: text }),
	).toBe(true)
	const retry = repositoryBusyRetryResponse()
	expect(retry.status).toBe(503)
	expect(retry.headers.get('Retry-After')).toBe('5')
})

test('extractArtifactsTokenFromRequest accepts Bearer and Basic', () => {
	expect(
		extractArtifactsTokenFromRequest(
			new Request('https://kody.codes/', {
				headers: { Authorization: `Bearer ${artifactToken}?expires=1` },
			}),
		),
	).toBe(artifactToken)
	expect(
		extractArtifactsTokenFromRequest(
			new Request('https://kody.codes/', {
				headers: {
					Authorization: `Basic ${btoa(`x:${artifactToken}`)}`,
				},
			}),
		),
	).toBe(artifactToken)
	expect(
		extractArtifactsTokenFromRequest(new Request('https://kody.codes/')),
	).toBeNull()
})

test('proxy waits through Artifacts receive-pack busy then succeeds', async () => {
	resetMocks()
	seedPlainRepo()
	let attempts = 0
	const packResult = '000eunpack ok\n0000'
	using _server = createMswNodeServer([
		http.post(`${artifactsRemote}/git-receive-pack`, async ({ request }) => {
			attempts += 1
			expect(await request.text()).toBe('PACK-RETRY')
			if (attempts === 1) {
				return HttpResponse.text(
					`remote: ${artifactsGitReceivePackBusyCode}\n`,
					{ status: 500 },
				)
			}
			return HttpResponse.text(packResult, {
				status: 200,
				headers: {
					'Content-Type': 'application/x-git-receive-pack-result',
				},
			})
		}),
	])
	const response = await handlePlainRepoGitHttpRequest(
		new Request(
			`https://kody.codes/git/sources/${sourceId}.git/git-receive-pack`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${artifactToken}`,
					'Content-Type': 'application/x-git-receive-pack-request',
				},
				body: 'PACK-RETRY',
			},
		),
		testEnv(),
	)
	expect(response).not.toBeNull()
	expect(response!.status).toBe(200)
	expect(await response!.text()).toBe(packResult)
	expect(attempts).toBe(2)
})

test('proxy waits through in-band HTTP 200 busy (sideband fatal) then succeeds', async () => {
	resetMocks()
	seedPlainRepo()
	let attempts = 0
	const packResult = '000eunpack ok\n0000'
	using _server = createMswNodeServer([
		http.post(`${artifactsRemote}/git-receive-pack`, async () => {
			attempts += 1
			const body =
				attempts < 3
					? `0025\x03${artifactsGitReceivePackBusyCode}\n`
					: packResult
			return HttpResponse.text(body, {
				status: 200,
				headers: {
					'Content-Type': 'application/x-git-receive-pack-result',
				},
			})
		}),
	])
	const response = await handlePlainRepoGitHttpRequest(
		new Request(
			`https://kody.codes/git/sources/${sourceId}.git/git-receive-pack`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${artifactToken}`,
					'Content-Type': 'application/x-git-receive-pack-request',
				},
				body: 'PACK-IN-BAND',
			},
		),
		testEnv(),
	)
	expect(response).not.toBeNull()
	expect(response!.status).toBe(200)
	expect(await response!.text()).toBe(packResult)
	expect(attempts).toBe(3)
})

test('proxy returns 503 Retry-After after the receive-pack wait budget', async () => {
	resetMocks()
	seedPlainRepo()
	vi.useFakeTimers()
	using _server = createMswNodeServer([
		http.post(`${artifactsRemote}/git-receive-pack`, () =>
			HttpResponse.text(`remote: ${artifactsGitReceivePackBusyCode}\n`, {
				status: 500,
			}),
		),
	])
	try {
		const responsePromise = handlePlainRepoGitHttpRequest(
			new Request(
				`https://kody.codes/git/sources/${sourceId}.git/git-receive-pack`,
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${artifactToken}`,
						'Content-Type': 'application/x-git-receive-pack-request',
					},
					body: 'PACK',
				},
			),
			testEnv(),
		)
		await vi.advanceTimersByTimeAsync(artifactsReceivePackWaitBudgetMs + 1_000)
		const response = await responsePromise
		expect(response).not.toBeNull()
		expect(response!.status).toBe(503)
		expect(response!.headers.get('Retry-After')).toBe('5')
		expect(await response!.text()).toBe('repository busy, retry')
	} finally {
		vi.useRealTimers()
	}
})

test('proxy streams successful receive-pack unchanged', async () => {
	resetMocks()
	seedPlainRepo()
	const packResult = '000eunpack ok\n0000'
	using _server = createMswNodeServer([
		http.post(`${artifactsRemote}/git-receive-pack`, async ({ request }) => {
			expect(request.headers.get('Authorization')).toBe(
				`Bearer ${artifactToken}`,
			)
			expect(await request.text()).toBe('PACK-OK')
			return HttpResponse.text(packResult, {
				status: 200,
				headers: {
					'Content-Type': 'application/x-git-receive-pack-result',
				},
			})
		}),
	])
	const response = await handlePlainRepoGitHttpRequest(
		new Request(
			`https://kody.codes/git/sources/${sourceId}.git/git-receive-pack`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${artifactToken}`,
					'Content-Type': 'application/x-git-receive-pack-request',
				},
				body: 'PACK-OK',
			},
		),
		testEnv(),
	)
	expect(response).not.toBeNull()
	expect(response!.status).toBe(200)
	expect(await response!.text()).toBe(packResult)
	expect(response!.headers.get('Content-Type')).toBe(
		'application/x-git-receive-pack-result',
	)
})

test('proxy forwards gzip-encoded upload-pack requests to Artifacts decoded', async () => {
	resetMocks()
	seedPlainRepo()
	const fetchRequest =
		'0014command=fetch\n0001' +
		Array.from(
			{ length: 21 },
			(_, index) => `0032want ${index.toString(16).padStart(40, '0')}\n`,
		).join('') +
		'0009done\n0000'
	const seen: Array<{ encoding: string | null; body: string }> = []
	using _server = createMswNodeServer([
		http.post(`${artifactsRemote}/git-upload-pack`, async ({ request }) => {
			seen.push({
				encoding: request.headers.get('Content-Encoding'),
				body: await request.text(),
			})
			return HttpResponse.text('000dpackfile\n0000', {
				status: 200,
				headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
			})
		}),
	])
	const gzipped = await new Response(
		new Blob([fetchRequest])
			.stream()
			.pipeThrough(new CompressionStream('gzip')),
	).arrayBuffer()
	const response = await handlePlainRepoGitHttpRequest(
		new Request(
			`https://kody.codes/git/sources/${sourceId}.git/git-upload-pack`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${artifactToken}`,
					'Content-Type': 'application/x-git-upload-pack-request',
					'Content-Encoding': 'gzip',
					'Git-Protocol': 'version=2',
				},
				body: gzipped,
			},
		),
		testEnv(),
	)
	expect(response!.status).toBe(200)
	expect(await response!.text()).toBe('000dpackfile\n0000')
	expect(seen).toEqual([{ encoding: null, body: fetchRequest }])

	const rejected = await handlePlainRepoGitHttpRequest(
		new Request(
			`https://kody.codes/git/sources/${sourceId}.git/git-upload-pack`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${artifactToken}`,
					'Content-Encoding': 'br',
				},
				body: 'x',
			},
		),
		testEnv(),
	)
	expect(rejected!.status).toBe(415)
	expect(seen).toHaveLength(1)
})

test('proxy forwards a gzip-encoded receive-pack body decoded', async () => {
	resetMocks()
	seedPlainRepo()
	const packResult = '000eunpack ok\n0000'
	const received: Array<string> = []
	using _server = createMswNodeServer([
		http.post(`${artifactsRemote}/git-receive-pack`, async ({ request }) => {
			expect(request.headers.get('Content-Encoding')).toBeNull()
			received.push(await request.text())
			return HttpResponse.text(packResult, {
				status: 200,
				headers: { 'Content-Type': 'application/x-git-receive-pack-result' },
			})
		}),
	])
	const gzipped = await new Response(
		new Blob(['PACK-OK']).stream().pipeThrough(new CompressionStream('gzip')),
	).arrayBuffer()
	const response = await handlePlainRepoGitHttpRequest(
		new Request(
			`https://kody.codes/git/sources/${sourceId}.git/git-receive-pack`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${artifactToken}`,
					'Content-Type': 'application/x-git-receive-pack-request',
					'Content-Encoding': 'gzip',
				},
				body: gzipped,
			},
		),
		testEnv(),
	)
	expect(response!.status).toBe(200)
	expect(await response!.text()).toBe(packResult)
	expect(received).toEqual(['PACK-OK'])
})

test('proxy does not claim busy for unrelated upstream errors', async () => {
	resetMocks()
	seedPlainRepo()
	using _server = createMswNodeServer([
		http.post(`${artifactsRemote}/git-receive-pack`, () =>
			HttpResponse.text('internal blowup', { status: 500 }),
		),
	])
	const response = await handlePlainRepoGitHttpRequest(
		new Request(
			`https://kody.codes/git/sources/${sourceId}.git/git-receive-pack`,
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${artifactToken}` },
				body: 'PACK',
			},
		),
		testEnv(),
	)
	expect(response!.status).toBe(500)
	expect(await response!.text()).toBe('internal blowup')
})

test('proxy requires auth and 404s unknown repos', async () => {
	resetMocks()
	const missingAuth = await handlePlainRepoGitHttpRequest(
		new Request(
			`https://kody.codes/git/sources/${sourceId}.git/git-receive-pack`,
			{
				method: 'POST',
				body: 'PACK',
			},
		),
		testEnv(),
	)
	expect(missingAuth!.status).toBe(401)

	getEntitySourceById.mockResolvedValue(null)
	const missingRepo = await handlePlainRepoGitHttpRequest(
		new Request(
			`https://kody.codes/git/sources/${sourceId}.git/git-receive-pack`,
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${artifactToken}` },
				body: 'PACK',
			},
		),
		testEnv(),
	)
	expect(missingRepo!.status).toBe(404)
})

test('proxy keeps working after promote flips entity_kind to package', async () => {
	resetMocks()
	seedPlainRepo()
	getEntitySourceById.mockResolvedValue({
		id: sourceId,
		user_id: ownerIdFromStored('owner-1'),
		entity_kind: 'package',
		entity_id: 'saved-package-1',
		repo_id: 'plain-notes',
		published_commit: 'abc123',
		indexed_commit: 'abc123',
		manifest_path: 'package.json',
		source_root: '.',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-02T00:00:00.000Z',
	})
	const packResult = '000eunpack ok\n0000'
	using _server = createMswNodeServer([
		http.post(`${artifactsRemote}/git-receive-pack`, async ({ request }) => {
			expect(request.headers.get('Authorization')).toBe(
				`Bearer ${artifactToken}`,
			)
			return HttpResponse.text(packResult, {
				status: 200,
				headers: {
					'Content-Type': 'application/x-git-receive-pack-result',
				},
			})
		}),
	])
	const response = await handlePlainRepoGitHttpRequest(
		new Request(
			`https://kody.codes/git/sources/${sourceId}.git/git-receive-pack`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${artifactToken}`,
					'Content-Type': 'application/x-git-receive-pack-request',
				},
				body: 'PACK',
			},
		),
		testEnv(),
	)
	expect(response).not.toBeNull()
	expect(response!.status).toBe(200)
	expect(await response!.text()).toBe(packResult)
})
