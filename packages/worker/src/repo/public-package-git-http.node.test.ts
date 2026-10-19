import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { encodeGitFlushPkt, encodeGitPktLine } from './git-pkt-line.ts'

const resolveCommunityPackageUrl = vi.fn()
const getCommunityListingById = vi.fn()
const getEntitySourceById = vi.fn()
const resolveExistingArtifactSourceRepo = vi.fn()
const checkRateLimit = vi.fn()

vi.mock('#worker/community/package-url.ts', () => ({
	resolveCommunityPackageUrl: (...args: Array<unknown>) =>
		resolveCommunityPackageUrl(...args),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingById: (...args: Array<unknown>) =>
		getCommunityListingById(...args),
}))

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

vi.mock('#app/rate-limit.ts', () => ({
	checkRateLimit: (...args: Array<unknown>) => checkRateLimit(...args),
}))

vi.mock('#worker/audit-log.ts', () => ({
	getRequestIp: () => '203.0.113.10',
}))

const {
	handlePublicPackageGitHttpRequest,
	parsePublicPackageGitHttpPath,
	readGitHttpCredential,
	resolveImmutableSnapshotCommit,
	shouldRedirectBrowserFromPackageGitRoot,
} = await import('./public-package-git-http.ts')

const publishedCommit = '0123456789abcdef0123456789abcdef01234567'
const liveCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function resetMocks() {
	resolveCommunityPackageUrl.mockReset()
	getCommunityListingById.mockReset()
	getEntitySourceById.mockReset()
	resolveExistingArtifactSourceRepo.mockReset()
	checkRateLimit.mockReset()
	checkRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: null })
}

function seedPublicListing(input?: {
	username?: string
	kodyId?: string
	publishedCommit?: string | null
	pinnedCommit?: string
}) {
	const username = input?.username ?? 'kody'
	const kodyId = input?.kodyId ?? 'cloudflare'
	resolveCommunityPackageUrl.mockResolvedValue({
		kind: 'listing',
		listingId: 'listing-1',
		username,
		kodyId,
	})
	getCommunityListingById.mockResolvedValue({
		id: 'listing-1',
		ownerUserId: ownerIdFromStored('owner-1'),
		packageId: 'pkg-1',
		sourceId: 'source-1',
		kodyId,
		name: `@${username}/${kodyId}`,
		description: 'test',
		tags: [],
		category: 'other',
		searchText: null,
		readmeContent: null,
		license: 'MIT',
		pinnedCommit: input?.pinnedCommit ?? publishedCommit,
		iconCommit: publishedCommit,
		trustedCommit: null,
		trustedAt: null,
		trusted: false,
		featuredAt: null,
		featured: false,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		publishedAt: '2026-01-01T00:00:00.000Z',
		status: 'active',
	})
	getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: ownerIdFromStored('owner-1'),
		entity_kind: 'package',
		entity_id: 'pkg-1',
		repo_id: 'package-pkg-1',
		published_commit:
			input?.publishedCommit === undefined
				? publishedCommit
				: input.publishedCommit,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '.',
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
	})
	resolveExistingArtifactSourceRepo.mockResolvedValue({
		info: async () => ({
			id: 'repo-1',
			name: 'package-pkg-1',
			description: null,
			defaultBranch: 'main',
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			lastPushAt: null,
			source: null,
			readOnly: false,
			remote: 'https://artifacts.example.test/git/default/package-pkg-1.git',
		}),
		createToken: async () => ({
			id: 'tok-1',
			plaintext: 'art_v1_secret?expires=9999999999',
			scope: 'read',
			expiresAt: '2099-01-01T00:00:00.000Z',
		}),
	})
}

function envStub() {
	return { APP_DB: {} } as Env
}

test('parsePublicPackageGitHttpPath recognizes smart HTTP suffixes under /@owner/pkg.git', () => {
	expect(parsePublicPackageGitHttpPath('/@kody/cloudflare.git')).toEqual({
		kind: 'repo-root',
		username: 'kody',
		kodyId: 'cloudflare',
	})
	expect(
		parsePublicPackageGitHttpPath('/@kody/cloudflare.git/info/refs'),
	).toEqual({
		kind: 'info-refs',
		username: 'kody',
		kodyId: 'cloudflare',
	})
	expect(
		parsePublicPackageGitHttpPath('/@kody/cloudflare.git/git-upload-pack'),
	).toEqual({
		kind: 'upload-pack',
		username: 'kody',
		kodyId: 'cloudflare',
	})
	expect(
		parsePublicPackageGitHttpPath('/@kody/cloudflare.git/git-receive-pack'),
	).toEqual({
		kind: 'receive-pack',
		username: 'kody',
		kodyId: 'cloudflare',
	})
	expect(parsePublicPackageGitHttpPath('/@kody/cloudflare')).toBeNull()
	expect(
		parsePublicPackageGitHttpPath('/@kody/cloudflare/tree/main'),
	).toBeNull()
})

test('shouldRedirectBrowserFromPackageGitRoot matches browser HTML GET/HEAD only', () => {
	expect(
		shouldRedirectBrowserFromPackageGitRoot(
			new Request('https://kody.codes/@kody/cloudflare.git', {
				headers: {
					Accept: 'text/html,application/xhtml+xml',
					'User-Agent': 'Mozilla/5.0',
				},
			}),
		),
	).toBe(true)
	expect(
		shouldRedirectBrowserFromPackageGitRoot(
			new Request('https://kody.codes/@kody/cloudflare.git', {
				method: 'HEAD',
				headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0' },
			}),
		),
	).toBe(true)
	expect(
		shouldRedirectBrowserFromPackageGitRoot(
			new Request('https://kody.codes/@kody/cloudflare.git', {
				headers: { Accept: '*/*', 'User-Agent': 'Mozilla/5.0' },
			}),
		),
	).toBe(false)
	expect(
		shouldRedirectBrowserFromPackageGitRoot(
			new Request('https://kody.codes/@kody/cloudflare.git', {
				headers: {
					Accept: 'text/html',
					'User-Agent': 'git/2.46.0',
				},
			}),
		),
	).toBe(false)
	expect(
		shouldRedirectBrowserFromPackageGitRoot(
			new Request(
				'https://kody.codes/@kody/cloudflare.git?service=git-upload-pack',
				{
					headers: {
						Accept: 'text/html',
						'User-Agent': 'Mozilla/5.0',
					},
				},
			),
		),
	).toBe(false)
	expect(
		shouldRedirectBrowserFromPackageGitRoot(
			new Request('https://kody.codes/@kody/cloudflare.git?service=unknown', {
				headers: {
					Accept: 'text/html',
					'User-Agent': 'Mozilla/5.0',
				},
			}),
		),
	).toBe(false)
	expect(
		shouldRedirectBrowserFromPackageGitRoot(
			new Request('https://kody.codes/@kody/cloudflare.git', {
				method: 'POST',
				headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0' },
			}),
		),
	).toBe(false)
})

test('browser GET to bare .git redirects to the package page; git info/refs is unchanged', async () => {
	resetMocks()
	seedPublicListing({
		username: 'kentcdodds',
		kodyId: 'cloudflare-demo-slideshow',
	})

	const browser = await handlePublicPackageGitHttpRequest(
		new Request(
			'https://kody.codes/@kentcdodds/cloudflare-demo-slideshow.git?utm=docs',
			{
				headers: {
					Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
					'User-Agent':
						'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
				},
			},
		),
		envStub(),
	)
	expect(browser).not.toBeNull()
	expect(browser!.status).toBe(301)
	expect(browser!.headers.get('Location')).toBe(
		'https://kody.codes/@kentcdodds/cloudflare-demo-slideshow?utm=docs',
	)
	expect(browser!.headers.get('Cache-Control')).toBe('no-store')
	expect(resolveCommunityPackageUrl).not.toHaveBeenCalled()

	const artifactsRemote =
		'https://artifacts.example.test/git/default/package-pkg-1.git'
	const upstreamAdvertisement =
		encodeGitPktLine('# service=git-upload-pack\n') +
		encodeGitFlushPkt() +
		encodeGitPktLine(
			`${publishedCommit} HEAD\0multi_ack thin-pack side-band-64k ofs-delta symref=HEAD:refs/heads/main agent=git/artifacts\n`,
		) +
		encodeGitPktLine(`${publishedCommit} refs/heads/main\n`) +
		encodeGitFlushPkt()
	using _server = createMswNodeServer([
		http.get(`${artifactsRemote}/info/refs`, () => {
			return new HttpResponse(upstreamAdvertisement, {
				status: 200,
				headers: {
					'Content-Type': 'application/x-git-upload-pack-advertisement',
				},
			})
		}),
	])

	const infoRefs = await handlePublicPackageGitHttpRequest(
		new Request(
			'https://kody.codes/@kentcdodds/cloudflare-demo-slideshow.git/info/refs?service=git-upload-pack',
			{
				headers: {
					'User-Agent': 'git/2.46.0',
				},
			},
		),
		envStub(),
	)
	expect(infoRefs).not.toBeNull()
	expect(infoRefs!.status).toBe(200)
	expect(infoRefs!.headers.get('Content-Type')).toBe(
		'application/x-git-upload-pack-advertisement',
	)
	expect(infoRefs!.headers.get('Location')).toBeNull()
	const advertisement = await infoRefs!.text()
	expect(advertisement).toContain(`${publishedCommit} HEAD\0`)
})

test('resolveImmutableSnapshotCommit prefers published_commit then pinned_commit', () => {
	expect(
		resolveImmutableSnapshotCommit({
			publishedCommit: publishedCommit,
			pinnedCommit: liveCommit,
		}),
	).toBe(publishedCommit)
	expect(
		resolveImmutableSnapshotCommit({
			publishedCommit: null,
			pinnedCommit: publishedCommit,
		}),
	).toBe(publishedCommit)
	expect(
		resolveImmutableSnapshotCommit({
			publishedCommit: 'short',
			pinnedCommit: 'also-short',
		}),
	).toBeNull()
})

test('public package git HTTP advertises the published snapshot and proxies upload-pack without leaking Artifacts credentials', async () => {
	resetMocks()
	seedPublicListing()

	const upstreamAdvertisement =
		encodeGitPktLine('# service=git-upload-pack\n') +
		encodeGitFlushPkt() +
		encodeGitPktLine(
			`${liveCommit} HEAD\0multi_ack thin-pack side-band-64k ofs-delta symref=HEAD:refs/heads/main agent=git/artifacts\n`,
		) +
		encodeGitPktLine(`${liveCommit} refs/heads/main\n`) +
		encodeGitPktLine(`${liveCommit} refs/heads/wip\n`) +
		encodeGitFlushPkt()

	const artifactsRemote =
		'https://artifacts.example.test/git/default/package-pkg-1.git'
	const fetchCalls: Array<{ url: string; method: string; headers: Headers }> =
		[]
	using _server = createMswNodeServer([
		http.get(`${artifactsRemote}/info/refs`, ({ request }) => {
			fetchCalls.push({
				url: request.url,
				method: request.method,
				headers: request.headers,
			})
			return new HttpResponse(upstreamAdvertisement, {
				status: 200,
				headers: {
					'Content-Type': 'application/x-git-upload-pack-advertisement',
				},
			})
		}),
		http.post(`${artifactsRemote}/git-upload-pack`, ({ request }) => {
			fetchCalls.push({
				url: request.url,
				method: request.method,
				headers: request.headers,
			})
			return new HttpResponse('PACK-FAKE', {
				status: 200,
				headers: {
					'Content-Type': 'application/x-git-upload-pack-result',
					Location: 'https://artifacts.example.test/secret-redirect',
					'WWW-Authenticate': 'Basic realm=artifacts',
					'Set-Cookie': 'artifacts=1',
				},
			})
		}),
	])

	const infoRefs = await handlePublicPackageGitHttpRequest(
		new Request(
			'https://kody.codes/@kody/cloudflare.git/info/refs?service=git-upload-pack',
		),
		envStub(),
	)
	expect(infoRefs).not.toBeNull()
	expect(infoRefs!.status).toBe(200)
	expect(infoRefs!.headers.get('Content-Type')).toBe(
		'application/x-git-upload-pack-advertisement',
	)
	const advertisement = await infoRefs!.text()
	expect(advertisement).toContain(`${publishedCommit} HEAD\0`)
	expect(advertisement).toContain(`${publishedCommit} refs/heads/main\n`)
	expect(advertisement).not.toContain(liveCommit)
	expect(advertisement).not.toContain('refs/heads/wip')
	expect(advertisement).not.toContain('art_v1_secret')
	expect(advertisement).not.toContain('artifacts.example.test')

	const uploadPack = await handlePublicPackageGitHttpRequest(
		new Request('https://kody.codes/@kody/cloudflare.git/git-upload-pack', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-git-upload-pack-request',
				Accept: 'application/x-git-upload-pack-result',
				'Git-Protocol': 'version=2',
			},
			body:
				encodeGitPktLine(
					`want ${publishedCommit} multi_ack side-band-64k ofs-delta\n`,
				) +
				encodeGitFlushPkt() +
				encodeGitPktLine('done\n'),
		}),
		envStub(),
	)
	expect(uploadPack).not.toBeNull()
	expect(uploadPack!.status).toBe(200)
	expect(uploadPack!.headers.get('Content-Type')).toBe(
		'application/x-git-upload-pack-result',
	)
	expect(uploadPack!.headers.get('Location')).toBeNull()
	expect(uploadPack!.headers.get('WWW-Authenticate')).toBeNull()
	expect(uploadPack!.headers.get('Set-Cookie')).toBeNull()
	expect(await uploadPack!.text()).toBe('PACK-FAKE')
	expect(fetchCalls).toHaveLength(2)
	for (const call of fetchCalls) {
		expect(call.url).toContain('artifacts.example.test')
		expect(call.url).not.toContain('art_v1_secret')
		expect(call.headers.get('Authorization')).toBe('Bearer art_v1_secret')
	}
	const uploadCall = fetchCalls.find((call) =>
		call.url.includes('/git-upload-pack'),
	)
	expect(uploadCall?.method).toBe('POST')
	expect(uploadCall?.headers.get('Git-Protocol')).toBe('version=1')

	const unpublishedWant = await handlePublicPackageGitHttpRequest(
		new Request('https://kody.codes/@kody/cloudflare.git/git-upload-pack', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-git-upload-pack-request',
			},
			body:
				encodeGitPktLine(`want ${liveCommit}\n`) +
				encodeGitFlushPkt() +
				encodeGitPktLine('done\n'),
		}),
		envStub(),
	)
	expect(unpublishedWant!.status).toBe(200)
	expect(unpublishedWant!.headers.get('Content-Type')).toBe(
		'application/x-git-upload-pack-result',
	)
	const rejectedBody = await unpublishedWant!.text()
	expect(rejectedBody).toContain(
		'ERR Public package git remotes only serve the published snapshot commit.',
	)
	expect(rejectedBody).not.toContain('artifacts.example.test')
	// Rejected before upstream fetch.
	expect(fetchCalls).toHaveLength(2)

	const oversized = await handlePublicPackageGitHttpRequest(
		new Request('https://kody.codes/@kody/cloudflare.git/git-upload-pack', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-git-upload-pack-request',
				'Content-Length': String(300 * 1024),
			},
			body: new Uint8Array(300 * 1024),
		}),
		envStub(),
	)
	expect(oversized!.status).toBe(200)
	expect(oversized!.headers.get('Content-Type')).toBe(
		'application/x-git-upload-pack-result',
	)
	expect(await oversized!.text()).toContain(
		'ERR Upload-pack request body too large.',
	)
	expect(fetchCalls).toHaveLength(2)
})

test('public package git HTTP challenges auth for anonymous push and private packages', async () => {
	resetMocks()

	const receivePack = await handlePublicPackageGitHttpRequest(
		new Request('https://kody.codes/@kody/cloudflare.git/git-receive-pack', {
			method: 'POST',
			body: 'push',
		}),
		envStub(),
	)
	expect(receivePack!.status).toBe(401)
	expect(receivePack!.headers.get('WWW-Authenticate')).toMatch(/Basic/i)
	expect(resolveCommunityPackageUrl).not.toHaveBeenCalled()

	const receiveInfo = await handlePublicPackageGitHttpRequest(
		new Request(
			'https://kody.codes/@kody/cloudflare.git/info/refs?service=git-receive-pack',
		),
		envStub(),
	)
	expect(receiveInfo!.status).toBe(401)
	expect(receiveInfo!.headers.get('WWW-Authenticate')).toMatch(/Basic/i)

	resolveCommunityPackageUrl.mockResolvedValue(null)
	const missing = await handlePublicPackageGitHttpRequest(
		new Request(
			'https://kody.codes/@someone/private-pkg.git/info/refs?service=git-upload-pack',
		),
		envStub(),
	)
	// Non-public paths challenge for credentials so `git` invokes the helper.
	expect(missing!.status).toBe(401)
	expect(missing!.headers.get('WWW-Authenticate')).toMatch(/Basic/i)
	expect(getCommunityListingById).not.toHaveBeenCalled()
})

test('readGitHttpCredential accepts Basic/Bearer kody_at_… and rejects others', () => {
	const token = `kody_at_${'a'.repeat(20)}_${'B'.repeat(43)}`
	expect(readGitHttpCredential(null)).toEqual({ kind: 'absent' })
	expect(readGitHttpCredential(`Bearer ${token}`)).toEqual({
		kind: 'api_token',
		token,
	})
	expect(readGitHttpCredential(`Basic ${btoa(`x:${token}`)}`)).toEqual({
		kind: 'api_token',
		token,
	})
	expect(readGitHttpCredential('Bearer not-a-token')).toEqual({
		kind: 'invalid',
	})
	expect(readGitHttpCredential(`Basic ${btoa('x:kody_gt_nope')}`)).toEqual({
		kind: 'invalid',
	})
})

test('public package git HTTP redirects listing renames and falls back to a local advertisement', async () => {
	resetMocks()
	resolveCommunityPackageUrl.mockResolvedValue({
		kind: 'redirect',
		listingId: 'listing-1',
		username: 'kody',
		kodyId: 'workers',
	})

	const redirected = await handlePublicPackageGitHttpRequest(
		new Request(
			'https://kody.codes/@kody/cloudflare.git/info/refs?service=git-upload-pack',
		),
		envStub(),
	)
	expect(redirected!.status).toBe(301)
	expect(redirected!.headers.get('Location')).toBe(
		'https://kody.codes/@kody/workers.git/info/refs?service=git-upload-pack',
	)

	resetMocks()
	seedPublicListing()
	let upstreamFetches = 0
	using _server = createMswNodeServer([
		http.get(
			'https://artifacts.example.test/git/default/package-pkg-1.git/info/refs',
			() => {
				upstreamFetches += 1
				return HttpResponse.error()
			},
		),
	])
	const fallback = await handlePublicPackageGitHttpRequest(
		new Request(
			'https://kody.codes/@kody/cloudflare.git/info/refs?service=git-upload-pack',
		),
		envStub(),
	)
	expect(fallback!.status).toBe(200)
	expect(upstreamFetches).toBe(1)
	const body = await fallback!.text()
	expect(body.startsWith('001e# service=git-upload-pack\n0000')).toBe(true)
	expect(body).toContain(`${publishedCommit} HEAD\0`)
	expect(body).toContain('symref=HEAD:refs/heads/main')
	expect(body).toContain(`${publishedCommit} refs/heads/main\n`)
	expect(body.endsWith('0000')).toBe(true)
})

test('upload-pack negotiation rewrites a bare ACK and leaves done responses unchanged', async () => {
	resetMocks()
	seedPublicListing()
	const artifactsRemote =
		'https://artifacts.example.test/git/default/package-pkg-1.git'
	const plainAck = encodeGitPktLine(`ACK ${liveCommit}\n`)
	let upstreamBodies: Array<string> = []
	using _server = createMswNodeServer([
		http.post(`${artifactsRemote}/git-upload-pack`, async ({ request }) => {
			upstreamBodies.push(await request.text())
			const client = upstreamBodies[upstreamBodies.length - 1] ?? ''
			if (client.includes('done\n')) {
				return new HttpResponse(plainAck + 'PACK-AFTER-DONE', {
					status: 200,
					headers: {
						'Content-Type': 'application/x-git-upload-pack-result',
						'Content-Length': String(
							Buffer.byteLength(plainAck + 'PACK-AFTER-DONE'),
						),
					},
				})
			}
			return new HttpResponse(plainAck, {
				status: 200,
				headers: {
					'Content-Type': 'application/x-git-upload-pack-result',
					'Content-Length': String(Buffer.byteLength(plainAck)),
				},
			})
		}),
	])

	const negotiation = await handlePublicPackageGitHttpRequest(
		new Request('https://kody.codes/@kody/cloudflare.git/git-upload-pack', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-git-upload-pack-request' },
			body:
				encodeGitPktLine(
					`want ${publishedCommit} multi_ack_detailed no-done side-band-64k\n`,
				) +
				encodeGitFlushPkt() +
				encodeGitPktLine(`have ${liveCommit}\n`) +
				encodeGitFlushPkt(),
		}),
		envStub(),
	)
	expect(negotiation!.status).toBe(200)
	expect(await negotiation!.text()).toBe(
		encodeGitPktLine(`ACK ${liveCommit} common\n`) + encodeGitPktLine('NAK\n'),
	)

	const done = await handlePublicPackageGitHttpRequest(
		new Request('https://kody.codes/@kody/cloudflare.git/git-upload-pack', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-git-upload-pack-request' },
			body:
				encodeGitPktLine(
					`want ${publishedCommit} multi_ack_detailed no-done side-band-64k\n`,
				) +
				encodeGitFlushPkt() +
				encodeGitPktLine(`have ${liveCommit}\n`) +
				encodeGitPktLine('done\n'),
		}),
		envStub(),
	)
	expect(await done!.text()).toBe(plainAck + 'PACK-AFTER-DONE')

	const single = await handlePublicPackageGitHttpRequest(
		new Request('https://kody.codes/@kody/cloudflare.git/git-upload-pack', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-git-upload-pack-request' },
			body:
				encodeGitPktLine(`want ${publishedCommit} side-band-64k\n`) +
				encodeGitFlushPkt() +
				encodeGitPktLine(`have ${liveCommit}\n`) +
				encodeGitFlushPkt(),
		}),
		envStub(),
	)
	expect(await single!.text()).toBe(plainAck)
})

test('upload-pack failures are git ERR packets and do not echo upstream URLs', async () => {
	resetMocks()
	seedPublicListing()
	const artifactsRemote =
		'https://artifacts.example.test/git/default/package-pkg-1.git'
	using _server = createMswNodeServer([
		http.post(`${artifactsRemote}/git-upload-pack`, () => {
			return new HttpResponse(
				'nope https://artifacts.example.test/secret art_v1_secret',
				{ status: 502 },
			)
		}),
	])
	const rejected = await handlePublicPackageGitHttpRequest(
		new Request('https://kody.codes/@kody/cloudflare.git/git-upload-pack', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-git-upload-pack-request' },
			body:
				encodeGitPktLine(`want ${publishedCommit} side-band-64k\n`) +
				encodeGitFlushPkt() +
				encodeGitPktLine('done\n'),
		}),
		envStub(),
	)
	expect(rejected!.status).toBe(200)
	expect(rejected!.headers.get('Content-Type')).toBe(
		'application/x-git-upload-pack-result',
	)
	const body = await rejected!.text()
	expect(body).toContain('ERR The artifact repository rejected git-upload-pack')
	expect(body).toContain('HTTP 502')
	expect(body).not.toContain('artifacts.example.test')
	expect(body).not.toContain('art_v1_secret')

	resetMocks()
	seedPublicListing({ publishedCommit: null, pinnedCommit: 'not-a-sha' })
	const infoRefs = await handlePublicPackageGitHttpRequest(
		new Request(
			'https://kody.codes/@kody/cloudflare.git/info/refs?service=git-upload-pack',
		),
		envStub(),
	)
	expect(infoRefs!.status).toBe(200)
	expect(infoRefs!.headers.get('Content-Type')).toBe(
		'application/x-git-upload-pack-advertisement',
	)
	const advertisement = await infoRefs!.text()
	expect(advertisement.startsWith('001e# service=git-upload-pack\n0000')).toBe(
		true,
	)
	expect(advertisement).toContain(
		'ERR Public package has no published snapshot commit to clone.',
	)

	const repoRoot = await handlePublicPackageGitHttpRequest(
		new Request('https://kody.codes/@kody/cloudflare.git', {
			headers: { Accept: '*/*', 'User-Agent': 'git/2.47.0' },
		}),
		envStub(),
	)
	expect(repoRoot!.status).toBe(503)
	expect(await repoRoot!.text()).toMatch(/published snapshot/i)
})

test('upload-pack negotiation bodies over 64KiB pass through unchanged', async () => {
	resetMocks()
	seedPublicListing()
	const artifactsRemote =
		'https://artifacts.example.test/git/default/package-pkg-1.git'
	const plainAck = encodeGitPktLine(`ACK ${liveCommit}\n`)
	let filler = ''
	while (Buffer.byteLength(plainAck + filler) <= 64 * 1024) {
		filler += encodeGitPktLine('NAK\n')
	}
	const upstreamBody = plainAck + filler
	using _server = createMswNodeServer([
		http.post(`${artifactsRemote}/git-upload-pack`, () => {
			return new HttpResponse(upstreamBody, {
				status: 200,
				headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
			})
		}),
	])
	const response = await handlePublicPackageGitHttpRequest(
		new Request('https://kody.codes/@kody/cloudflare.git/git-upload-pack', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-git-upload-pack-request' },
			body:
				encodeGitPktLine(
					`want ${publishedCommit} multi_ack_detailed no-done side-band-64k\n`,
				) +
				encodeGitFlushPkt() +
				encodeGitPktLine(`have ${liveCommit}\n`) +
				encodeGitFlushPkt(),
		}),
		envStub(),
	)
	expect(response!.status).toBe(200)
	expect(await response!.text()).toBe(upstreamBody)
})
