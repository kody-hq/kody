import {
	parseBackupManifest,
	serializeBackupManifest,
} from '@kody-internal/shared/backup-manifest.ts'
import { d1ImportMaxStatementBytes } from '@kody-internal/shared/backup-restore-safety.ts'

import { BackupError } from './backup-policy.ts'
import type {
	BackupManifest,
	SqlStatementStats,
	StoredBackup,
} from './backup-types.ts'

export const MAXIMUM_SINGLE_BACKUP_OBJECT_BYTES = 5 * 1024 * 1024 * 1024

/**
 * R2 rejects any put targeting an existing object under a bucket-lock rule
 * with `put: The object is locked by the bucket policy. (10069)` before
 * evaluating conditional headers, so the `onlyIf: { etagDoesNotMatch: '*' }`
 * create-only pattern throws on locked prefixes instead of returning null.
 * Verified live 2026-07-28: sealing wedged hourly on the locked `daily/`
 * prefix. Treat the rejection as "object already exists" so retries and
 * replays fall through to byte comparison.
 */
export function isBucketLockPolicyPutError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error)
	return (
		message.includes('locked by the bucket policy') ||
		message.includes('(10069)')
	)
}

const SINGLE_QUOTE = 0x27
const SEMICOLON = 0x3b

/**
 * Streaming, quote-aware SQL statement-length scanner. D1's import path
 * rejects statements above {@link d1ImportMaxStatementBytes} with
 * SQLITE_TOOBIG, so a backup containing one is not restorable through the
 * D1 import API. Statement boundaries are semicolons outside single-quoted
 * string literals (doubled `''` escapes toggle twice and cancel out; dumps
 * do not contain comments).
 */
export function createSqlStatementScanner(limit = d1ImportMaxStatementBytes): {
	update: (chunk: Uint8Array) => void
	finish: () => SqlStatementStats
} {
	let inString = false
	let currentStatementBytes = 0
	let maxStatementBytes = 0
	let oversizedStatementCount = 0

	function closeStatement() {
		if (currentStatementBytes > maxStatementBytes) {
			maxStatementBytes = currentStatementBytes
		}
		if (currentStatementBytes > limit) oversizedStatementCount += 1
		currentStatementBytes = 0
	}

	return {
		update(chunk: Uint8Array) {
			let index = 0
			while (index < chunk.length) {
				if (inString) {
					const quote = chunk.indexOf(SINGLE_QUOTE, index)
					if (quote === -1) {
						currentStatementBytes += chunk.length - index
						return
					}
					currentStatementBytes += quote - index + 1
					inString = false
					index = quote + 1
					continue
				}
				const quote = chunk.indexOf(SINGLE_QUOTE, index)
				const semicolon = chunk.indexOf(SEMICOLON, index)
				if (semicolon !== -1 && (quote === -1 || semicolon < quote)) {
					currentStatementBytes += semicolon - index + 1
					closeStatement()
					index = semicolon + 1
					continue
				}
				if (quote !== -1) {
					currentStatementBytes += quote - index + 1
					inString = true
					index = quote + 1
					continue
				}
				currentStatementBytes += chunk.length - index
				return
			}
		},
		finish(): SqlStatementStats {
			if (currentStatementBytes > 0) closeStatement()
			return { maxStatementBytes, oversizedStatementCount, limit }
		},
	}
}

function hex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

async function digestBody(
	body: ReadableStream<Uint8Array>,
	expectedBytes?: number,
): Promise<{
	bytes: number
	sha256: string
	sqlStatementStats: SqlStatementStats
}> {
	// DigestStream is a Workers runtime extension exposed on crypto, not a
	// bare global (verified live: `DigestStream is not defined`).
	const digest = new (
		crypto as unknown as { DigestStream: typeof DigestStream }
	).DigestStream('SHA-256')
	const scanner = createSqlStatementScanner()
	const writer = digest.getWriter()
	const reader = body.getReader()
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			if (value === undefined) continue
			scanner.update(value)
			await writer.write(value)
		}
		await writer.close()
	} catch (error) {
		await writer.abort(error).catch(() => undefined)
		throw error
	}
	const bytes = Number(digest.bytesWritten)
	if (expectedBytes !== undefined && bytes !== expectedBytes) {
		throw new BackupError(
			'download-truncated',
			'download byte count did not match Content-Length',
			true,
		)
	}
	return {
		bytes,
		sha256: hex(await digest.digest),
		sqlStatementStats: scanner.finish(),
	}
}

interface SignedDownload {
	body: ReadableStream<Uint8Array>
	expectedBytes: number
}

async function fetchSignedDownload(
	signedUrl: string,
	fetcher: typeof fetch,
): Promise<SignedDownload> {
	let response: Response
	try {
		response = await fetcher(signedUrl)
	} catch {
		throw new BackupError(
			'download-interrupted',
			'signed export download was interrupted',
			true,
		)
	}
	if (!response.ok || response.body === null) {
		throw new BackupError(
			'download-http-error',
			`signed export download returned HTTP ${response.status}`,
			response.status === 429 || response.status >= 500,
		)
	}
	const contentLength = response.headers.get('content-length')
	if (contentLength === null || !/^\d+$/.test(contentLength)) {
		throw new BackupError(
			'download-missing-length',
			'signed export download lacked a valid Content-Length',
			true,
		)
	}
	const expectedBytes = Number(contentLength)
	if (!Number.isSafeInteger(expectedBytes)) {
		throw new BackupError(
			'download-invalid-length',
			'signed export Content-Length exceeded safe limits',
		)
	}
	if (expectedBytes === 0) {
		throw new BackupError('download-empty', 'export download is empty', true)
	}
	if (expectedBytes >= MAXIMUM_SINGLE_BACKUP_OBJECT_BYTES) {
		throw new BackupError(
			'download-too-large',
			'export exceeds the single-object backup size limit',
		)
	}

	let streamedBytes = 0
	const validated = response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				streamedBytes += chunk.byteLength
				if (streamedBytes > expectedBytes) {
					throw new BackupError(
						'download-truncated',
						'download byte count did not match Content-Length',
						true,
					)
				}
				controller.enqueue(chunk)
			},
			flush() {
				if (streamedBytes !== expectedBytes) {
					throw new BackupError(
						'download-truncated',
						'download byte count did not match Content-Length',
						true,
					)
				}
			},
		}),
	)
	return {
		body: validated.pipeThrough(new FixedLengthStream(expectedBytes)),
		expectedBytes,
	}
}

async function inspectExisting(
	bucket: R2Bucket,
	key: string,
	sourceDigestPromise: Promise<{ bytes: number; sha256: string }>,
): Promise<StoredBackup> {
	const object = await bucket.get(key)
	if (object === null) {
		await sourceDigestPromise.catch(() => undefined)
		throw new BackupError(
			'immutable-put-race',
			'immutable object lost after a failed precondition',
			true,
		)
	}
	if (object.size >= MAXIMUM_SINGLE_BACKUP_OBJECT_BYTES) {
		await sourceDigestPromise.catch(() => undefined)
		throw new BackupError(
			'download-too-large',
			'existing export is at or above the single-object backup size limit',
		)
	}
	let digest: {
		bytes: number
		sha256: string
		sqlStatementStats: SqlStatementStats
	}
	let sourceDigest: { bytes: number; sha256: string }
	try {
		;[digest, sourceDigest] = await Promise.all([
			digestBody(object.body, object.size),
			sourceDigestPromise,
		])
	} catch (error) {
		if (error instanceof BackupError) throw error
		throw new BackupError(
			'download-interrupted',
			'streaming the signed export for immutable comparison failed',
			true,
		)
	}
	if (
		digest.bytes !== sourceDigest.bytes ||
		digest.sha256 !== sourceDigest.sha256
	) {
		throw new BackupError(
			'existing-object-source-mismatch',
			'existing immutable object does not match the signed export source',
		)
	}
	return {
		bytes: digest.bytes,
		sha256: digest.sha256,
		sqlStatementStats: digest.sqlStatementStats,
		r2Etag: object.etag,
		alreadyExisted: true,
	}
}

/**
 * Verify the immutable object still matches the durable upload-step result
 * (size, ETag, and a full SHA-256 re-read). This is the finalization-time
 * integrity check: the upload step already proved the object matches the
 * signed export source, and D1 poll results are short-lived and may only be
 * refreshable by starting a new export of a *newer* database state, so
 * re-downloading from D1 cannot be used to re-verify the stored object.
 */
async function verifyStoredObjectMatches(
	bucket: R2Bucket,
	objectKey: string,
	stored: StoredBackup,
): Promise<void> {
	const object = await bucket.get(objectKey)
	if (object === null) {
		throw new BackupError(
			'stored-object-missing',
			'immutable backup object disappeared after the upload step',
		)
	}
	if (object.size !== stored.bytes || object.etag !== stored.r2Etag) {
		throw new BackupError(
			'stored-object-mismatch',
			'immutable backup object no longer matches the upload step result',
		)
	}
	let digest: { bytes: number; sha256: string }
	try {
		digest = await digestBody(object.body, object.size)
	} catch (error) {
		if (error instanceof BackupError) throw error
		throw new BackupError(
			'download-interrupted',
			'streaming the immutable object for finalization verification failed',
			true,
		)
	}
	if (digest.sha256 !== stored.sha256) {
		throw new BackupError(
			'stored-object-mismatch',
			'immutable backup object no longer matches the upload step result',
		)
	}
}

export async function storeSignedDownload(
	bucket: R2Bucket,
	key: string,
	signedUrl: string,
	fetcher: typeof fetch = fetch,
): Promise<StoredBackup> {
	const existing = await bucket.head(key)
	const download = await fetchSignedDownload(signedUrl, fetcher)
	if (existing !== null) {
		return inspectExisting(
			bucket,
			key,
			digestBody(download.body, download.expectedBytes),
		)
	}

	const [r2Body, digestBodyStream] = download.body.tee()
	const digestPromise = digestBody(digestBodyStream, download.expectedBytes)
	let object: R2Object | null
	try {
		;[object] = await Promise.all([
			bucket
				.put(key, r2Body, {
					onlyIf: { etagDoesNotMatch: '*' },
					httpMetadata: { contentType: 'application/sql' },
				})
				.catch((error: unknown) => {
					if (isBucketLockPolicyPutError(error)) return null
					throw error
				})
				.then(async (result) => {
					if (result === null && !r2Body.locked) await r2Body.cancel()
					return result
				}),
			digestPromise,
		])
	} catch (error) {
		if (error instanceof BackupError) throw error
		const cause = error instanceof Error ? error.message : String(error)
		throw new BackupError(
			'download-interrupted',
			`streaming the export to immutable storage failed: ${cause}`,
			true,
		)
	}
	if (object === null) return inspectExisting(bucket, key, digestPromise)
	const digest = await digestPromise
	return {
		bytes: digest.bytes,
		sha256: digest.sha256,
		sqlStatementStats: digest.sqlStatementStats,
		r2Etag: object.etag,
		alreadyExisted: false,
	}
}

export async function putImmutableManifest(
	bucket: R2Bucket,
	key: string,
	manifest: BackupManifest,
): Promise<void> {
	const body = serializeBackupManifest(manifest)
	const result = await bucket
		.put(key, body, {
			onlyIf: { etagDoesNotMatch: '*' },
			httpMetadata: { contentType: 'application/json' },
		})
		.catch((error: unknown) => {
			if (isBucketLockPolicyPutError(error)) return null
			throw error
		})
	if (result !== null) return
	const existing = await bucket.get(key)
	if (existing === null) {
		throw new BackupError(
			'manifest-put-race',
			'manifest disappeared after immutable put conflict',
			true,
		)
	}
	if ((await existing.text()) !== body) {
		throw new BackupError(
			'manifest-conflict',
			'immutable manifest differs from this workflow result',
		)
	}
}

export async function assertDuplicateMatchesManifest(
	bucket: R2Bucket,
	manifestKey: string,
	objectKey: string,
	stored: StoredBackup,
): Promise<void> {
	const manifest = await readManifest(bucket, manifestKey)
	if (manifest === null) {
		await verifyStoredObjectMatches(bucket, objectKey, stored)
		return
	}
	if (
		manifest.payload.sql.objectKey !== objectKey ||
		manifest.payload.sql.bytes !== stored.bytes ||
		manifest.payload.sql.sha256 !== stored.sha256 ||
		manifest.payload.sql.r2Etag !== stored.r2Etag
	) {
		throw new BackupError(
			'duplicate-object-manifest-mismatch',
			'immutable backup object does not match its existing manifest',
		)
	}
}

export async function readManifest(
	bucket: R2Bucket,
	key: string,
): Promise<BackupManifest | null> {
	const object = await bucket.get(key)
	if (object === null) return null
	try {
		const value = await object.json<unknown>()
		const manifest = parseBackupManifest(value)
		if (manifest.payload.sql.bytes >= MAXIMUM_SINGLE_BACKUP_OBJECT_BYTES) {
			throw new Error('backup manifest exceeds single-object size limit')
		}
		return manifest
	} catch {
		throw new BackupError('manifest-corrupt', 'backup manifest JSON is corrupt')
	}
}
