import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, rename, rm } from 'node:fs/promises'
import { get as httpsGet } from 'node:https'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { describeNetworkError } from './network-error.js'

/** Matches the workerd the Kody platform runs; bump together with the digests. */
export const workerdVersion = '1.20260815.1'

/** sha256 of each gzipped release asset on github.com/cloudflare/workerd. */
const workerdAssetDigests = {
	'linux-64':
		'05099ec6f50832fcbc327490e5a971d682c97231fb01943b61726db07677e559',
	'linux-arm64':
		'0331597b53771170df2ab8344d9ae81d38bad4959e47152dd86592eedd9264c7',
	'darwin-64':
		'752ec91c01dfc44d660de6e3a654879cfc1277caa7f3c5312871c608c4c2d6df',
	'darwin-arm64':
		'c189fc08f691739c37d8784945e943e33b66cbd4e14635a061fe516dc95f2b39',
	'windows-64':
		'49a0c1247da0c2a085717926f8c3e63ed3ff0df1c6a6fc5eebb22309dab630f1',
} as const

/** Abort a workerd download after this long with no bytes; a download that keeps making progress can run as long as it needs. */
const workerdDownloadIdleTimeoutMs = 60_000

export class WorkerdDownloadStalledError extends Error {}
/** A reset, refused connection, HTTP/2 stream error, or 5xx: worth a retry. */
export class WorkerdDownloadNetworkError extends Error {}

const workerdDownloadAttempts = 3
const workerdDownloadRetryDelayMs = 1_000

export type WorkerdTarget = keyof typeof workerdAssetDigests

export function workerdTargetFor(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): WorkerdTarget {
	const os =
		platform === 'linux'
			? 'linux'
			: platform === 'darwin'
				? 'darwin'
				: platform === 'win32'
					? 'windows'
					: null
	const cpu = arch === 'x64' ? '64' : arch === 'arm64' ? 'arm64' : null
	if (!os || !cpu) {
		throw new Error(
			`execute --local supports Linux, macOS, and Windows on x64 or arm64 (this machine is ${platform}-${arch}).`,
		)
	}
	// workerd ships no Windows arm64 build; Windows on Arm runs the x64 one under emulation.
	if (os === 'windows') return 'windows-64'
	return `${os}-${cpu}`
}

export function workerdAssetUrl(
	target: WorkerdTarget,
	version: string = workerdVersion,
): string {
	return `https://github.com/cloudflare/workerd/releases/download/v${version}/workerd-${target}.gz`
}

export function userCacheDir(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	home: string = homedir(),
): string {
	if (env.KODY_CACHE_DIR) return env.KODY_CACHE_DIR
	if (platform === 'darwin') return join(home, 'Library', 'Caches', 'kody')
	if (platform === 'win32')
		return join(
			env.LOCALAPPDATA || join(home, 'AppData', 'Local'),
			'kody',
			'cache',
		)
	return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'kody')
}

export function cachedWorkerdPath(
	cacheDir: string,
	target: WorkerdTarget,
): string {
	return join(
		cacheDir,
		'workerd',
		`${workerdVersion}-${target}`,
		target.startsWith('windows-') ? 'workerd.exe' : 'workerd',
	)
}

/**
 * Returns a runnable workerd path: `KODY_WORKERD_PATH` when set, otherwise the
 * pinned release under the user cache dir (downloaded and verified on first use).
 */
export async function ensureWorkerdBinary(
	input: {
		env?: NodeJS.ProcessEnv
		cacheDir?: string
		target?: WorkerdTarget
		fetchFn?: typeof fetch
		onDownload?: (url: string) => void
		idleTimeoutMs?: number
		retryDelayMs?: number
	} = {},
): Promise<string> {
	const env = input.env ?? process.env
	if (env.KODY_WORKERD_PATH) return env.KODY_WORKERD_PATH
	const target = input.target ?? workerdTargetFor()
	const binaryPath = cachedWorkerdPath(
		input.cacheDir ?? userCacheDir(env),
		target,
	)
	if (existsSync(binaryPath)) return binaryPath

	const url = workerdAssetUrl(target)
	const download = () => {
		input.onDownload?.(url)
		return downloadVerifiedGzip({
			url,
			sha256: workerdAssetDigests[target],
			destination: binaryPath,
			fetchFn: input.fetchFn ?? http1Fetch,
			idleTimeoutMs: input.idleTimeoutMs,
		})
	}
	for (let attempt = 1; ; attempt += 1) {
		try {
			await download()
			break
		} catch (error) {
			const retryable =
				error instanceof WorkerdDownloadStalledError ||
				error instanceof WorkerdDownloadNetworkError
			if (!retryable) throw error
			if (attempt >= workerdDownloadAttempts) {
				const ErrorClass =
					error instanceof WorkerdDownloadStalledError
						? WorkerdDownloadStalledError
						: WorkerdDownloadNetworkError
				throw new ErrorClass(
					`Downloading workerd for local execute failed ${attempt} times: ${error.message} Check the network, or set KODY_WORKERD_PATH to a local workerd binary.`,
				)
			}
			await new Promise((resolve) =>
				setTimeout(
					resolve,
					(input.retryDelayMs ?? workerdDownloadRetryDelayMs) * attempt,
				),
			)
		}
	}
	return binaryPath
}

/**
 * GET over HTTP/1.1 (`node:https`), following redirects. Node's fetch can
 * negotiate HTTP/2 with GitHub release downloads and fail every attempt with
 * `ERR_HTTP2_STREAM_ERROR` while HTTP/1.1 succeeds (#5010).
 */
function http1Fetch(
	url: Parameters<typeof fetch>[0],
	init?: RequestInit,
	redirectsLeft = 5,
): Promise<Response> {
	return new Promise((resolve, reject) => {
		const href = url instanceof Request ? url.url : String(url)
		const request = httpsGet(
			href,
			{
				signal: init?.signal ?? undefined,
				headers: { 'user-agent': 'kody-cli' },
			},
			(response) => {
				const status = response.statusCode ?? 502
				const location = response.headers.location
				if (status >= 300 && status < 400 && location) {
					response.resume()
					if (redirectsLeft <= 0) {
						reject(new Error(`too many redirects from ${href}`))
						return
					}
					resolve(http1Fetch(new URL(location, href), init, redirectsLeft - 1))
					return
				}
				resolve(
					new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
						status,
					}),
				)
			},
		)
		request.on('error', reject)
	})
}

export async function downloadVerifiedGzip(input: {
	url: string
	sha256: string
	destination: string
	fetchFn: typeof fetch
	idleTimeoutMs?: number
}): Promise<void> {
	const idleTimeoutMs = input.idleTimeoutMs ?? workerdDownloadIdleTimeoutMs
	const abort = new AbortController()
	let idle: ReturnType<typeof setTimeout> | undefined
	const stalled = () =>
		new WorkerdDownloadStalledError(
			`no bytes arrived from ${input.url} for ${Math.round(idleTimeoutMs / 1000)}s.`,
		)
	const touch = () => {
		clearTimeout(idle)
		idle = setTimeout(() => abort.abort(stalled()), idleTimeoutMs)
	}
	const stopIdle = () => clearTimeout(idle)
	touch()
	try {
		await fetchAndWrite({ ...input, signal: abort.signal, touch, stopIdle })
	} catch (error) {
		if (abort.signal.aborted) throw abort.signal.reason
		throw error
	} finally {
		stopIdle()
	}
}

async function fetchAndWrite(input: {
	url: string
	sha256: string
	destination: string
	fetchFn: typeof fetch
	signal: AbortSignal
	touch: () => void
	stopIdle: () => void
}): Promise<void> {
	let response: Response
	try {
		response = await input.fetchFn(input.url, { signal: input.signal })
	} catch (error) {
		if (input.signal.aborted) throw input.signal.reason
		throw new WorkerdDownloadNetworkError(
			`Could not download workerd from ${input.url} (${describeNetworkError(error)}).`,
		)
	}
	if (!response.ok || !response.body) {
		const ErrorClass =
			response.status >= 500 ? WorkerdDownloadNetworkError : Error
		throw new ErrorClass(
			`Could not download workerd from ${input.url} (HTTP ${response.status}).`,
		)
	}
	await mkdir(dirname(input.destination), { recursive: true })
	const gzipPath = `${input.destination}.${process.pid}.gz`
	const partialPath = `${input.destination}.${process.pid}.partial`
	const hash = createHash('sha256')
	const hashing = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			input.touch()
			hash.update(chunk)
			callback(null, chunk)
		},
	})
	const body = Readable.fromWeb(
		response.body as Parameters<typeof Readable.fromWeb>[0],
	)
	const gzipFile = createWriteStream(gzipPath)
	// pipeline destroys every stream with the first error, so only the side
	// that failed first says whether the network or the disk broke.
	let firstFailure: 'body' | 'write' | null = null
	body.once('error', () => {
		firstFailure ??= 'body'
	})
	gzipFile.once('error', () => {
		firstFailure ??= 'write'
	})
	try {
		try {
			await pipeline(body, hashing, gzipFile, { signal: input.signal })
		} catch (error) {
			if (input.signal.aborted) throw input.signal.reason
			// Disk full, read-only cache, and the like: another download won't help.
			if (firstFailure === 'write') throw error
			throw new WorkerdDownloadNetworkError(
				`Downloading workerd from ${input.url} broke off (${describeNetworkError(error)}).`,
			)
		}
		input.stopIdle()
		const digest = hash.digest('hex')
		if (digest !== input.sha256) {
			throw new Error(
				`workerd download from ${input.url} failed verification (sha256 ${digest}, expected ${input.sha256}).`,
			)
		}
		await pipeline(
			createReadStream(gzipPath),
			createGunzip(),
			createWriteStream(partialPath),
		)
		await chmod(partialPath, 0o755)
		try {
			await rename(partialPath, input.destination)
		} catch (error) {
			// A concurrent download won the race. Windows refuses to replace a
			// running workerd.exe; the pinned digest makes their copy identical.
			if (!existsSync(input.destination)) throw error
		}
	} finally {
		await rm(gzipPath, { force: true })
		await rm(partialPath, { force: true })
	}
}
