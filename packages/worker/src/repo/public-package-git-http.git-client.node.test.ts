import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { http as mswHttp, HttpResponse } from 'msw'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import {
	encodeGitFlushPkt,
	encodeGitPktLine,
	splitGitPktLines,
	summarizeUploadPackRequest,
} from './git-pkt-line.ts'

const gitProbe = spawnSync('git', ['--version'], { stdio: 'ignore' })
const gitAvailable = gitProbe.status === 0

const authenticateApiToken = vi.fn()
const resolveGitHttpTargetAccess = vi.fn()
const resolveCommunityPackageUrl = vi.fn()
const getCommunityListingById = vi.fn()
const getEntitySourceById = vi.fn()
const resolveExistingArtifactSourceRepo = vi.fn()
const checkRateLimit = vi.fn()

vi.mock('#worker/api-tokens/service.ts', () => ({
	authenticateApiToken: (...args: Array<unknown>) =>
		authenticateApiToken(...args),
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
	resolveGitHttpTargetAccess: (...args: Array<unknown>) =>
		resolveGitHttpTargetAccess(...args),
}))

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

const { handlePublicPackageGitHttpRequest } =
	await import('./public-package-git-http.ts')

const artifactsRemote =
	'https://artifacts.example.test/git/default/package-pkg-1.git'
const apiToken = `kody_at_${'a'.repeat(20)}_${'B'.repeat(43)}`
const snapshotWantMessage =
	'Public package git remotes only serve the published snapshot commit.'

const access = { canRead: true, canWrite: false }
let publishedCommit = ''
let upstreamMode: 'gitty' | 'compliant' = 'gitty'
let bareRepo = ''

type GitResult = { code: number; stdout: Buffer; stderr: string }

/** A hung upload-pack or fetch must not stall the suite. */
const gitCommandTimeoutMs = 20_000

function runGit(
	args: Array<string>,
	options: {
		cwd?: string
		env?: NodeJS.ProcessEnv
		input?: Uint8Array | string
		allowFailure?: boolean
		timeoutMs?: number
	} = {},
): Promise<GitResult> {
	return new Promise((resolve, reject) => {
		const child = spawn('git', args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ['pipe', 'pipe', 'pipe'],
		})
		const out: Array<Buffer> = []
		const err: Array<Buffer> = []
		let settled = false
		const finish = (settle: () => void) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			settle()
		}
		const timer = setTimeout(() => {
			child.kill('SIGKILL')
			finish(() => {
				reject(
					new Error(
						`git ${args.join(' ')} timed out after ${options.timeoutMs ?? gitCommandTimeoutMs}ms`,
					),
				)
			})
		}, options.timeoutMs ?? gitCommandTimeoutMs)
		child.stdout.on('data', (chunk: Buffer) => {
			out.push(chunk)
		})
		child.stderr.on('data', (chunk: Buffer) => {
			err.push(chunk)
		})
		child.on('error', (error) => {
			finish(() => reject(error))
		})
		child.on('close', (code) => {
			const stdout = Buffer.concat(out)
			const stderr = Buffer.concat(err).toString('utf8')
			finish(() => {
				if ((code ?? 1) !== 0 && !options.allowFailure) {
					reject(
						new Error(
							`git ${args.join(' ')} exited ${code}: ${stderr || stdout.toString('utf8')}`,
						),
					)
					return
				}
				resolve({ code: code ?? 1, stdout, stderr })
			})
		})
		if (options.input === undefined) child.stdin.end()
		else child.stdin.end(options.input)
	})
}

function gitEnv(home: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		HOME: home,
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_TERMINAL_PROMPT: '0',
		GIT_AUTHOR_NAME: 'Kody Test',
		GIT_AUTHOR_EMAIL: 'test@example.com',
		GIT_COMMITTER_NAME: 'Kody Test',
		GIT_COMMITTER_EMAIL: 'test@example.com',
	}
}

function clientArgs(protocol: '0' | '2', args: Array<string>) {
	return [
		'-c',
		`protocol.version=${protocol}`,
		'-c',
		'safe.directory=*',
		'-c',
		'credential.helper=',
		...args,
	]
}

function installHandlerMocks() {
	checkRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: null })
	authenticateApiToken.mockResolvedValue({
		ok: true,
		record: {
			user_id: 'user-1',
			scopes: ['package:read', 'package:write'],
			created_at: '2026-01-01T00:00:00.000Z',
			rotated_at: null,
		},
	})
	resolveGitHttpTargetAccess.mockImplementation(async () => ({
		ownerHandle: 'kody',
		repoName: 'cloudflare',
		resourceKind: 'package' as const,
		resourceId: 'pkg-1',
		resourceOrgId: 'org-1',
		sourceId: 'source-1',
		repoId: 'package-pkg-1',
		canRead: access.canRead,
		canWrite: access.canWrite,
	}))
	resolveCommunityPackageUrl.mockResolvedValue({
		kind: 'listing',
		listingId: 'listing-1',
		username: 'kody',
		kodyId: 'cloudflare',
	})
	getCommunityListingById.mockImplementation(async () => ({
		id: 'listing-1',
		ownerUserId: ownerIdFromStored('owner-1'),
		packageId: 'pkg-1',
		sourceId: 'source-1',
		kodyId: 'cloudflare',
		name: '@kody/cloudflare',
		description: 'test',
		tags: [],
		category: 'other',
		searchText: null,
		readmeContent: null,
		license: 'MIT',
		pinnedCommit: publishedCommit,
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
	}))
	getEntitySourceById.mockImplementation(async () => ({
		id: 'source-1',
		user_id: ownerIdFromStored('owner-1'),
		entity_kind: 'package',
		entity_id: 'pkg-1',
		repo_id: 'package-pkg-1',
		published_commit: publishedCommit,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '.',
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
	}))
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
			remote: artifactsRemote,
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

function packetLines(body: Uint8Array) {
	const parsed = splitGitPktLines(body)
	if (!parsed.ok) return null
	return parsed.packets
		.filter((packet): packet is string => packet !== null)
		.map((packet) => (packet.endsWith('\n') ? packet.slice(0, -1) : packet))
}

async function currentHead() {
	const result = await runGit([
		'--git-dir',
		bareRepo,
		'rev-parse',
		'refs/heads/main',
	])
	return result.stdout.toString('utf8').trim()
}

async function objectExists(oid: string) {
	const result = await runGit(
		['--git-dir', bareRepo, 'cat-file', '-e', `${oid}^{commit}`],
		{ allowFailure: true },
	)
	return result.code === 0
}

function frameSideband64k(pack: Buffer) {
	const frames: Array<Buffer> = []
	const chunkSize = 65515
	for (let offset = 0; offset < pack.length; offset += chunkSize) {
		const chunk = pack.subarray(offset, offset + chunkSize)
		const length = chunk.length + 5
		frames.push(
			Buffer.from(length.toString(16).padStart(4, '0')),
			Buffer.from([1]),
			chunk,
		)
	}
	frames.push(Buffer.from('0000'))
	return Buffer.concat(frames)
}

/**
 * Production Artifacts (`gitty/1.0`) shape: negotiation without `done` is a
 * single plain `ACK <first common>` and no NAK (or a lone NAK when nothing
 * is common). `done` is `ACK <common>` or `NAK` plus a side-band-64k pack.
 */
async function gittyUploadPackResponse(body: Uint8Array) {
	const lines = packetLines(body) ?? []
	const wants = lines
		.filter((line) => line.startsWith('want '))
		.map((line) => line.slice('want '.length).split(' ')[0] ?? '')
		.filter((oid) => /^[0-9a-f]{40}$/i.test(oid))
	const haves = lines
		.filter((line) => line.startsWith('have '))
		.map((line) => line.slice('have '.length).trim())
	const hasDone = lines.includes('done')
	let common: string | null = null
	const knownHaves: Array<string> = []
	for (const have of haves) {
		if (!(await objectExists(have))) continue
		knownHaves.push(have)
		if (!common) common = have
	}
	if (!hasDone) {
		if (!common) return Buffer.from(encodeGitPktLine('NAK\n'))
		return Buffer.from(encodeGitPktLine(`ACK ${common}\n`))
	}
	const revList = [...wants, ...knownHaves.map((have) => `^${have}`)]
	const packed = await runGit(
		['--git-dir', bareRepo, 'pack-objects', '--revs', '--stdout'],
		{ input: `${revList.join('\n')}\n` },
	)
	const prefix = common
		? encodeGitPktLine(`ACK ${common}\n`)
		: encodeGitPktLine('NAK\n')
	return Buffer.concat([Buffer.from(prefix), frameSideband64k(packed.stdout)])
}

async function gittyAdvertisement(commit: string) {
	const capabilities = [
		'multi_ack',
		'thin-pack',
		'side-band',
		'side-band-64k',
		'ofs-delta',
		'shallow',
		'deepen-since',
		'deepen-not',
		'deepen-relative',
		'no-progress',
		'include-tag',
		'multi_ack_detailed',
		'no-done',
		'symref=HEAD:refs/heads/main',
		'agent=gitty/1.0',
	].join(' ')
	return Buffer.from(
		encodeGitPktLine('# service=git-upload-pack\n') +
			encodeGitFlushPkt() +
			encodeGitPktLine(`${commit} HEAD\0${capabilities}\n`) +
			encodeGitPktLine(`${commit} refs/heads/main\n`) +
			encodeGitFlushPkt(),
	)
}

async function compliantAdvertisement() {
	const advertised = await runGit([
		'upload-pack',
		'--stateless-rpc',
		'--advertise-refs',
		bareRepo,
	])
	return Buffer.concat([
		Buffer.from(
			encodeGitPktLine('# service=git-upload-pack\n') + encodeGitFlushPkt(),
		),
		advertised.stdout,
	])
}

const uploadLog: Array<{ hasDone: boolean; hasHaves: boolean }> = []

type ClientUploadRequest = {
	contentEncoding: string | null
	bodyBytes: number
	gzipMagic: boolean
}

/** Bytes git actually POSTed, before the proxy decompresses them. */
const clientUploadRequests: Array<ClientUploadRequest> = []

function upstreamHandlers() {
	return [
		mswHttp.get(`${artifactsRemote}/info/refs`, async () => {
			const head = await currentHead()
			const body =
				upstreamMode === 'gitty'
					? await gittyAdvertisement(head)
					: await compliantAdvertisement()
			return new HttpResponse(new Uint8Array(body), {
				status: 200,
				headers: {
					'Content-Type': 'application/x-git-upload-pack-advertisement',
				},
			})
		}),
		mswHttp.post(`${artifactsRemote}/git-upload-pack`, async ({ request }) => {
			const body = new Uint8Array(await request.arrayBuffer())
			const summary = summarizeUploadPackRequest(body)
			uploadLog.push({
				hasDone: summary.hasDone,
				hasHaves: summary.hasHaves,
			})
			const response =
				upstreamMode === 'gitty'
					? await gittyUploadPackResponse(body)
					: (
							await runGit(['upload-pack', '--stateless-rpc', bareRepo], {
								input: body,
							})
						).stdout
			return new HttpResponse(new Uint8Array(response), {
				status: 200,
				headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
			})
		}),
	]
}

function listen(server: http.Server) {
	return new Promise<number>((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			if (!address || typeof address === 'string') {
				reject(new Error('Test git HTTP server did not bind a port.'))
				return
			}
			resolve(address.port)
		})
	})
}

function cloneUrl(port: number, authenticated: boolean) {
	const auth = authenticated ? `git:${apiToken}@` : ''
	return `http://${auth}127.0.0.1:${port}/@kody/cloudflare.git`
}

async function headOf(repo: string, revision: string, env: NodeJS.ProcessEnv) {
	const result = await runGit(['-C', repo, 'rev-parse', revision], { env })
	return result.stdout.toString('utf8').trim()
}

test('authenticated smart-HTTP failures are git ERR packets', async () => {
	installHandlerMocks()
	access.canRead = true
	access.canWrite = false
	publishedCommit = '0123456789abcdef0123456789abcdef01234567'
	const authorization = `Basic ${Buffer.from(`git:${apiToken}`).toString('base64')}`
	using _server = createMswNodeServer([
		mswHttp.post(`${artifactsRemote}/git-receive-pack`, () => {
			return new HttpResponse('https://artifacts.example.test/secret', {
				status: 500,
			})
		}),
	])

	const infoRefs = await handlePublicPackageGitHttpRequest(
		new Request(
			'https://kody.codes/@kody/cloudflare.git/info/refs?service=git-receive-pack',
			{ headers: { Authorization: authorization } },
		),
		envStub(),
	)
	expect(infoRefs!.status).toBe(200)
	expect(infoRefs!.headers.get('Content-Type')).toBe(
		'application/x-git-receive-pack-advertisement',
	)
	const advertisement = await infoRefs!.text()
	expect(advertisement.startsWith('001f# service=git-receive-pack\n0000')).toBe(
		true,
	)
	expect(advertisement).toContain(
		'ERR You can clone this package but not push.',
	)
	expect(advertisement).not.toContain('artifacts.example.test')

	access.canWrite = true
	const receivePack = await handlePublicPackageGitHttpRequest(
		new Request('https://kody.codes/@kody/cloudflare.git/git-receive-pack', {
			method: 'POST',
			headers: {
				Authorization: authorization,
				'Content-Type': 'application/x-git-receive-pack-request',
			},
			body: '0000',
		}),
		envStub(),
	)
	expect(receivePack!.status).toBe(200)
	expect(receivePack!.headers.get('Content-Type')).toBe(
		'application/x-git-receive-pack-result',
	)
	const pushBody = await receivePack!.text()
	expect(pushBody).toContain(
		'ERR The artifact repository rejected git-receive-pack (HTTP 500).',
	)
	expect(pushBody).not.toContain('artifacts.example.test')
	expect(pushBody).not.toContain(apiToken)
})

test.skipIf(!gitAvailable)(
	'gitty negotiation without a common have is a NAK, matching git upload-pack',
	async () => {
		const home = await mkdtemp(path.join(tmpdir(), 'kody-git-nak-'))
		const bare = path.join(home, 'bare.git')
		const env = gitEnv(home)
		try {
			await runGit(['init', '--bare', '-b', 'main', bare], { env })
			const blob = (
				await runGit(['--git-dir', bare, 'hash-object', '-w', '--stdin'], {
					env,
					input: 'only\n',
				})
			).stdout
				.toString('utf8')
				.trim()
			const tree = (
				await runGit(['--git-dir', bare, 'mktree'], {
					env,
					input: `100644 blob ${blob}\tfile.txt\n`,
				})
			).stdout
				.toString('utf8')
				.trim()
			const commit = (
				await runGit(['--git-dir', bare, 'commit-tree', tree, '-m', 'only'], {
					env,
				})
			).stdout
				.toString('utf8')
				.trim()
			await runGit(
				['--git-dir', bare, 'update-ref', 'refs/heads/main', commit],
				{
					env,
				},
			)
			const unknown = '0123456789abcdef0123456789abcdef01234567'
			const request = Buffer.from(
				encodeGitPktLine(
					`want ${commit} multi_ack_detailed no-done side-band-64k agent=git/2.43.0\n`,
				) +
					encodeGitFlushPkt() +
					encodeGitPktLine(`have ${unknown}\n`) +
					encodeGitFlushPkt(),
			)
			bareRepo = bare
			const gitty = await gittyUploadPackResponse(request)
			const real = await runGit(['upload-pack', '--stateless-rpc', bare], {
				env,
				input: request,
			})
			expect(gitty.toString('utf8')).toBe(encodeGitPktLine('NAK\n'))
			expect(real.stdout.toString('utf8')).toBe(encodeGitPktLine('NAK\n'))
		} finally {
			bareRepo = ''
			await rm(home, { recursive: true, force: true })
		}
	},
)

test.skipIf(!gitAvailable)(
	'real git clone, fetch, and pull work for gitty and compliant upstreams',
	async () => {
		installHandlerMocks()
		access.canRead = true
		access.canWrite = false
		const home = await mkdtemp(path.join(tmpdir(), 'kody-git-client-'))
		const bare = path.join(home, 'bare.git')
		const env = gitEnv(home)
		bareRepo = bare
		const server = http.createServer(async (req, res) => {
			try {
				const chunks: Array<Buffer> = []
				for await (const chunk of req) chunks.push(chunk as Buffer)
				const body = Buffer.concat(chunks)
				if (
					req.method === 'POST' &&
					(req.url ?? '').includes('/git-upload-pack')
				) {
					const encodingHeader = req.headers['content-encoding']
					const contentEncoding = Array.isArray(encodingHeader)
						? encodingHeader.join(',')
						: (encodingHeader ?? null)
					clientUploadRequests.push({
						contentEncoding,
						bodyBytes: body.byteLength,
						gzipMagic:
							body.byteLength >= 2 && body[0] === 0x1f && body[1] === 0x8b,
					})
				}
				const headers = new Headers()
				for (const [key, value] of Object.entries(req.headers)) {
					if (value === undefined) continue
					if (
						key === 'host' ||
						key === 'connection' ||
						key === 'content-length' ||
						key === 'transfer-encoding'
					) {
						continue
					}
					if (Array.isArray(value)) {
						for (const entry of value) headers.append(key, entry)
					} else {
						headers.set(key, value)
					}
				}
				const request = new Request(`https://kody.codes${req.url ?? '/'}`, {
					method: req.method,
					headers,
					body:
						req.method === 'GET' || req.method === 'HEAD'
							? undefined
							: new Uint8Array(body),
				})
				const response = await handlePublicPackageGitHttpRequest(
					request,
					envStub(),
				)
				if (!response) {
					res.writeHead(404)
					res.end('Not Found')
					return
				}
				const payload = Buffer.from(await response.arrayBuffer())
				const responseHeaders: Record<string, string> = {}
				response.headers.forEach((value, key) => {
					responseHeaders[key] = value
				})
				res.writeHead(response.status, responseHeaders)
				res.end(payload)
			} catch (error) {
				res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
				res.end(error instanceof Error ? error.message : 'git proxy failed')
			}
		})
		using _msw = createMswNodeServer(upstreamHandlers())
		try {
			await runGit(['init', '--bare', '-b', 'main', bare], { env })
			const commits: Array<string> = []
			let parent = ''
			for (let index = 1; index <= 18; index++) {
				const blob = (
					await runGit(['--git-dir', bare, 'hash-object', '-w', '--stdin'], {
						env,
						input: `commit ${index}\n`,
					})
				).stdout
					.toString('utf8')
					.trim()
				const tree = (
					await runGit(['--git-dir', bare, 'mktree'], {
						env,
						input: `100644 blob ${blob}\tfile.txt\n`,
					})
				).stdout
					.toString('utf8')
					.trim()
				const commitArgs = ['--git-dir', bare, 'commit-tree', tree]
				if (parent) commitArgs.push('-p', parent)
				commitArgs.push('-m', `commit ${index}`)
				parent = (await runGit(commitArgs, { env })).stdout
					.toString('utf8')
					.trim()
				commits.push(parent)
			}
			await runGit(
				['--git-dir', bare, 'update-ref', 'refs/heads/main', parent],
				{ env },
			)
			const commitA = commits[15] ?? ''
			const commitB = commits[16] ?? ''
			const commitC = commits[17] ?? ''
			expect(commitA).toMatch(/^[0-9a-f]{40}$/)
			expect(commitC).toMatch(/^[0-9a-f]{40}$/)

			const setTip = async (commit: string) => {
				publishedCommit = commit
				await runGit(
					['--git-dir', bare, 'update-ref', 'refs/heads/main', commit],
					{ env },
				)
			}

			const port = await listen(server)
			for (const mode of ['gitty', 'compliant'] as const) {
				for (const authenticated of [false, true]) {
					for (const protocol of ['0', '2'] as const) {
						upstreamMode = mode
						const label = `${mode}-${authenticated ? 'auth' : 'public'}-v${protocol}`
						const dest = path.join(home, label)
						await setTip(commitA)
						uploadLog.length = 0
						await runGit(
							clientArgs(protocol, [
								'clone',
								cloneUrl(port, authenticated),
								dest,
							]),
							{ env },
						)
						expect(await headOf(dest, 'HEAD', env)).toBe(commitA)

						uploadLog.length = 0
						await setTip(commitB)
						await runGit(
							clientArgs(protocol, ['-C', dest, 'fetch', 'origin']),
							{ env },
						)
						expect(
							uploadLog.some((entry) => entry.hasHaves && !entry.hasDone),
						).toBe(true)
						expect(await headOf(dest, 'origin/main', env)).toBe(commitB)
						await runGit(
							clientArgs(protocol, ['-C', dest, 'pull', '--ff-only']),
							{ env },
						)
						expect(await headOf(dest, 'HEAD', env)).toBe(commitB)

						await setTip(commitC)
						await runGit(
							clientArgs(protocol, ['-C', dest, 'pull', '--ff-only']),
							{ env },
						)
						expect(await headOf(dest, 'HEAD', env)).toBe(commitC)
					}
				}
			}

			// Sixteen haves is about 980 bytes, under git's 1024-byte gzip
			// threshold, and a common tip stops negotiation immediately.
			// Local-only commits are not acknowledged, so a later window
			// grows past 1024 bytes and git sends Content-Encoding: gzip.
			for (const mode of ['gitty', 'compliant'] as const) {
				upstreamMode = mode
				const dest = path.join(home, `gzip-${mode}`)
				await setTip(commitA)
				await runGit(clientArgs('0', ['clone', cloneUrl(port, false), dest]), {
					env,
				})
				let localTip = await headOf(dest, 'HEAD', env)
				for (let index = 1; index <= 48; index++) {
					const blob = (
						await runGit(['-C', dest, 'hash-object', '-w', '--stdin'], {
							env,
							input: `local ${index}\n`,
						})
					).stdout
						.toString('utf8')
						.trim()
					const tree = (
						await runGit(['-C', dest, 'mktree'], {
							env,
							input: `100644 blob ${blob}\tlocal.txt\n`,
						})
					).stdout
						.toString('utf8')
						.trim()
					localTip = (
						await runGit(
							[
								'-C',
								dest,
								'commit-tree',
								tree,
								'-p',
								localTip,
								'-m',
								`local ${index}`,
							],
							{ env },
						)
					).stdout
						.toString('utf8')
						.trim()
				}
				await runGit(
					['-C', dest, 'update-ref', 'refs/heads/local-only', localTip],
					{ env },
				)
				clientUploadRequests.length = 0
				await setTip(commitB)
				await runGit(clientArgs('0', ['-C', dest, 'fetch', 'origin']), {
					env,
				})
				const gzipped = clientUploadRequests.filter(
					(entry) => entry.contentEncoding === 'gzip',
				)
				expect(gzipped.length).toBeGreaterThan(0)
				expect(gzipped.every((entry) => entry.gzipMagic)).toBe(true)
				expect(await headOf(dest, 'origin/main', env)).toBe(commitB)
				await runGit(clientArgs('0', ['-C', dest, 'pull', '--ff-only']), {
					env,
				})
				expect(await headOf(dest, 'HEAD', env)).toBe(commitB)
			}

			upstreamMode = 'gitty'
			const rejectedDest = path.join(home, 'rejected-want')
			await setTip(commitA)
			await runGit(
				clientArgs('0', ['clone', cloneUrl(port, false), rejectedDest]),
				{ env },
			)
			const rejected = await runGit(
				clientArgs('0', ['-C', rejectedDest, 'fetch', 'origin', commitC]),
				{ env, allowFailure: true },
			)
			expect(rejected.code).not.toBe(0)
			expect(rejected.stderr).toContain(`remote error: ${snapshotWantMessage}`)
		} finally {
			bareRepo = ''
			await new Promise<void>((resolve) => {
				server.close(() => resolve())
			})
			await rm(home, { recursive: true, force: true })
		}
	},
	180_000,
)
