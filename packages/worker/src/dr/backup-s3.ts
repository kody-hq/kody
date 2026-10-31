import { AwsClient } from 'aws4fetch'

export type DrBackupS3Config = {
	accountId: string
	bucketName: string
	accessKeyId: string
	secretAccessKey: string
}

export type DrBackupS3PutOptions = {
	contentType?: string
	/** Strong ETag precondition for updates (R2/S3 If-Match). */
	ifMatch?: string
	/** Create-only precondition (R2/S3 If-None-Match, typically `*`). */
	ifNoneMatch?: string
}

export class DrBackupPreconditionFailedError extends Error {
	readonly key: string
	readonly status: number

	constructor(key: string, status = 412) {
		super(`DR backup precondition failed for ${key}: HTTP ${status}`)
		this.name = 'DrBackupPreconditionFailedError'
		this.key = key
		this.status = status
	}
}

export type DrBackupS3Client = {
	head: (
		key: string,
	) => Promise<{ exists: boolean; status: number; etag: string | null }>
	getText: (
		key: string,
	) => Promise<{ text: string; etag: string | null } | null>
	getBytes: (key: string) => Promise<Uint8Array | null>
	put: (
		key: string,
		body: string | Uint8Array,
		options?: DrBackupS3PutOptions,
	) => Promise<{ etag: string | null }>
}

/** R2/S3 platform blips observed on PutObject (and siblings) during cron ticks. */
export const drBackupS3RetryMaxAttempts = 4
export const drBackupS3RetryBaseDelayMs = 150

function sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/**
 * Transient R2/S3 HTTP statuses worth retrying. 412 stays non-retryable so
 * conditional progress.json ownership conflicts surface immediately.
 */
export function isTransientDrBackupHttpStatus(status: number) {
	return (
		status === 429 ||
		status === 500 ||
		status === 502 ||
		status === 503 ||
		status === 504
	)
}

function objectUrl(config: DrBackupS3Config, key: string) {
	const encodedKey = key
		.split('/')
		.map((part) => encodeURIComponent(part))
		.join('/')
	return `https://${config.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(config.bucketName)}/${encodedKey}`
}

function readEtag(response: Response): string | null {
	const etag = response.headers.get('etag')?.trim()
	return etag && etag.length > 0 ? etag : null
}

async function drainResponseBody(response: Response) {
	try {
		await response.arrayBuffer()
	} catch {
		// Best-effort: free the connection before the next attempt.
	}
}

export function createDrBackupS3Client(
	config: DrBackupS3Config,
	options?: {
		maxAttempts?: number
		baseDelayMs?: number
	},
): DrBackupS3Client {
	const aws = new AwsClient({
		accessKeyId: config.accessKeyId,
		secretAccessKey: config.secretAccessKey,
		service: 's3',
		region: 'auto',
	})
	const maxAttempts = options?.maxAttempts ?? drBackupS3RetryMaxAttempts
	const baseDelayMs = options?.baseDelayMs ?? drBackupS3RetryBaseDelayMs

	async function signedFetch(key: string, init?: RequestInit) {
		const request = await aws.sign(objectUrl(config, key), init)
		return fetch(request)
	}

	/**
	 * Retry transport / platform blips. Conditional headers are preserved on
	 * each attempt: a phantom success that still 412s on retry is handled by
	 * callers as `DrBackupPreconditionFailedError` (safe skip / resume).
	 */
	async function signedFetchWithRetry(
		key: string,
		init?: RequestInit,
		options: { retryConflict?: boolean } = {},
	) {
		let lastError: unknown
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				const response = await signedFetch(key, init)
				const retryable =
					isTransientDrBackupHttpStatus(response.status) ||
					(options.retryConflict === true && response.status === 409)
				if (!retryable || attempt === maxAttempts) {
					return response
				}
				await drainResponseBody(response)
			} catch (error) {
				lastError = error
				if (attempt === maxAttempts) throw error
			}
			await sleep(baseDelayMs * 2 ** (attempt - 1))
		}
		throw lastError ?? new Error('DR backup request failed after retries')
	}

	return {
		async head(key) {
			const response = await signedFetchWithRetry(key, { method: 'HEAD' })
			if (response.status === 404) {
				return { exists: false, status: response.status, etag: null }
			}
			if (!response.ok && response.status !== 404) {
				throw new Error(
					`DR backup HEAD failed for ${key}: HTTP ${response.status}`,
				)
			}
			return {
				exists: response.ok,
				status: response.status,
				etag: readEtag(response),
			}
		},
		async getText(key) {
			const response = await signedFetchWithRetry(key, { method: 'GET' })
			if (response.status === 404) return null
			if (!response.ok) {
				throw new Error(
					`DR backup GET failed for ${key}: HTTP ${response.status}`,
				)
			}
			return {
				text: await response.text(),
				etag: readEtag(response),
			}
		},
		async getBytes(key) {
			const response = await signedFetchWithRetry(key, { method: 'GET' })
			if (response.status === 404) return null
			if (!response.ok) {
				throw new Error(
					`DR backup GET failed for ${key}: HTTP ${response.status}`,
				)
			}
			return new Uint8Array(await response.arrayBuffer())
		},
		async put(key, body, options = {}) {
			const headers: Record<string, string> = {
				'Content-Type': options.contentType ?? 'application/octet-stream',
			}
			if (options.ifMatch) {
				headers['If-Match'] = options.ifMatch
			}
			if (options.ifNoneMatch) {
				headers['If-None-Match'] = options.ifNoneMatch
			}
			// R2 answers a conditional PUT that races another write to the same
			// key with 409 instead of 412. Retry it; a conflict that outlasts
			// the retries is the same "someone else wrote it" signal as 412.
			const conditional = Boolean(options.ifMatch || options.ifNoneMatch)
			const response = await signedFetchWithRetry(
				key,
				{ method: 'PUT', headers, body: body as BodyInit },
				{ retryConflict: conditional },
			)
			if (response.status === 412 || (conditional && response.status === 409)) {
				throw new DrBackupPreconditionFailedError(key, response.status)
			}
			if (!response.ok) {
				throw new Error(
					`DR backup PUT failed for ${key}: HTTP ${response.status}`,
				)
			}
			return { etag: readEtag(response) }
		},
	}
}

export function readDrBackupS3Config(
	env: Pick<
		Env,
		| 'DR_BACKUP_ACCOUNT_ID'
		| 'DR_BACKUP_BUCKET_NAME'
		| 'DR_BACKUP_ACCESS_KEY_ID'
		| 'DR_BACKUP_SECRET_ACCESS_KEY'
	>,
): DrBackupS3Config | null {
	const accountId = env.DR_BACKUP_ACCOUNT_ID?.trim()
	const bucketName = env.DR_BACKUP_BUCKET_NAME?.trim()
	const accessKeyId = env.DR_BACKUP_ACCESS_KEY_ID?.trim()
	const secretAccessKey = env.DR_BACKUP_SECRET_ACCESS_KEY?.trim()
	if (!accountId || !bucketName || !accessKeyId || !secretAccessKey) {
		return null
	}
	return { accountId, bucketName, accessKeyId, secretAccessKey }
}
