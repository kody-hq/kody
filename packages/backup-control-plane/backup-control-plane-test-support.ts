import { createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto'
import {
	backupManifestSchemaVersion,
	backupManifestSignatureAlgorithm,
	canonicalBackupManifestPayload,
	type BackupManifestPayload,
} from '@kody-internal/shared/backup-manifest.ts'
import {
	backupSqlStatsKey,
	backupSqlStatsSchemaVersion,
	type BackupSqlStats,
} from '@kody-internal/shared/backup-sql-stats.ts'
import { encodeJwtPartForTests } from './access-auth.ts'
import { type BackupRuntimeStep } from './backup-runtime.ts'
import { type DurableExportStep } from './durable-export.ts'
import { BackupError, objectKeyForBookmark } from './backup-policy.ts'
import { type BackupEnvironment, type BackupManifest } from './backup-types.ts'

/** `assert.rejects` predicate; `retryable` is only checked when provided. */
export function backupError(code: string, retryable?: boolean) {
	return (error: unknown) =>
		error instanceof BackupError &&
		error.code === code &&
		(retryable === undefined || error.retryable === retryable)
}

export function encodeNodeBytesAsBase64(bytes: ArrayBuffer | Uint8Array) {
	return Buffer.from(
		bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes,
	).toString('base64')
}

/** Self-signed RS256 Access JWKS; `headerKid` overrides the signed header kid. */
export function accessSigner(kid = 'test-kid') {
	const { privateKey, publicKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
	})
	const jwks = {
		keys: [
			{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' },
		],
	}
	return {
		jwks,
		fetcher: async () => Response.json(jwks),
		sign(payload: Record<string, unknown>, headerKid = kid) {
			const encoded = `${encodeJwtPartForTests({ alg: 'RS256', kid: headerKid })}.${encodeJwtPartForTests(payload)}`
			const signature = signBytes(
				'RSA-SHA256',
				Buffer.from(encoded),
				privateKey,
			)
			return `${encoded}.${Buffer.from(signature).toString('base64url')}`
		},
	}
}

/** Access claims that `environment()` accepts, with optional overrides. */
export function accessClaims(
	env: BackupEnvironment,
	overrides: Record<string, unknown> = {},
) {
	const now = Math.floor(Date.now() / 1000)
	return {
		iss: `https://${env.ACCESS_TEAM_DOMAIN}`,
		aud: env.ACCESS_APP_AUD,
		email: env.ACCESS_ALLOWED_EMAIL,
		iat: now - 10,
		exp: now + 3600,
		...overrides,
	}
}

class TestDigestStream extends WritableStream<Uint8Array> {
	readonly digest: Promise<ArrayBuffer>
	private readonly bytes: () => number

	constructor() {
		const hash = createHash('sha256')
		let byteCount = 0
		let resolveDigest: (value: ArrayBuffer) => void = () => undefined
		const digest = new Promise<ArrayBuffer>((resolve) => {
			resolveDigest = resolve
		})
		super({
			write(chunk) {
				const bytes = new Uint8Array(
					chunk.buffer,
					chunk.byteOffset,
					chunk.byteLength,
				)
				byteCount += bytes.byteLength
				hash.update(bytes)
			},
			close() {
				const result = hash.digest()
				resolveDigest(
					result.buffer.slice(
						result.byteOffset,
						result.byteOffset + result.byteLength,
					),
				)
			},
		})
		this.digest = digest
		this.bytes = () => byteCount
	}

	get bytesWritten(): number {
		return this.bytes()
	}
}

class TestFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
	constructor(expected: number | bigint) {
		let bytes = 0
		super({
			transform(chunk, controller) {
				bytes += chunk.byteLength
				if (bytes > Number(expected)) {
					throw new Error('stream exceeded expected length')
				}
				controller.enqueue(chunk)
			},
			flush() {
				if (bytes !== Number(expected)) {
					throw new Error('stream ended before expected length')
				}
			},
		})
	}
}

// Mirror the Workers runtime: DigestStream lives on crypto (not a bare
// global); FixedLengthStream is a global.
Object.assign(crypto as object, { DigestStream: TestDigestStream })
Object.assign(globalThis, {
	FixedLengthStream: TestFixedLengthStream,
})

export class MemoryBucket {
	readonly puts: Array<{ key: string; options: R2PutOptions }> = []
	private readonly objects = new Map<string, Uint8Array>()
	private readonly reportedSizes = new Map<string, number>()
	private readonly failedGets = new Set<string>()
	private nextPutRace: { key: string; bytes: Uint8Array } | undefined
	private lockPolicyEnabled = false

	/**
	 * Emulate an R2 bucket-lock rule: puts targeting an existing key are
	 * rejected with error 10069 before conditional headers are evaluated
	 * (matches live behavior on the locked backup prefixes).
	 */
	enableLockPolicy(): void {
		this.lockPolicyEnabled = true
	}

	async put(
		key: string,
		value: ReadableStream | string,
		options: R2PutOptions = {},
	): Promise<R2Object | null> {
		this.puts.push({ key, options })
		if (this.nextPutRace?.key === key) {
			this.objects.set(key, this.nextPutRace.bytes)
			this.nextPutRace = undefined
		}
		if (this.lockPolicyEnabled && this.objects.has(key)) {
			throw new Error('put: The object is locked by the bucket policy. (10069)')
		}
		if (
			options.onlyIf &&
			'etagDoesNotMatch' in options.onlyIf &&
			options.onlyIf.etagDoesNotMatch === '*' &&
			this.objects.has(key)
		) {
			return null
		}
		const bytes =
			typeof value === 'string'
				? new TextEncoder().encode(value)
				: new Uint8Array(await new Response(value).arrayBuffer())
		this.objects.set(key, bytes)
		return this.metadata(key)
	}

	async head(key: string): Promise<R2Object | null> {
		return this.objects.has(key) ? this.metadata(key) : null
	}

	async delete(key: string): Promise<void> {
		this.objects.delete(key)
	}

	async get(key: string): Promise<R2ObjectBody | null> {
		if (this.failedGets.has(key)) throw new Error('simulated R2 get failure')
		const bytes = this.objects.get(key)
		if (!bytes) return null
		const metadata = this.metadata(key)
		return {
			...metadata,
			body: new Response(bytes as unknown as BodyInit).body!,
			bodyUsed: false,
			arrayBuffer: async () => bytes.buffer.slice(0),
			bytes: async () => bytes.slice(),
			text: async () => new TextDecoder().decode(bytes),
			json: async <T>() => JSON.parse(new TextDecoder().decode(bytes)) as T,
			blob: async () => new Blob([bytes as unknown as BlobPart]),
			writeHttpMetadata: () => undefined,
		} as R2ObjectBody
	}

	corrupt(key: string, value: string): void {
		this.objects.set(key, new TextEncoder().encode(value))
	}

	setReportedSize(key: string, size: number): void {
		this.reportedSizes.set(key, size)
	}

	failGetFor(key: string): void {
		this.failedGets.add(key)
	}

	raceOnNextPut(key: string, value: string): void {
		this.nextPutRace = { key, bytes: new TextEncoder().encode(value) }
	}

	private metadata(key: string): R2Object {
		const bytes = this.objects.get(key)!
		return {
			key,
			version: '1',
			size: this.reportedSizes.get(key) ?? bytes.byteLength,
			etag: createHash('md5').update(bytes).digest('hex'),
			httpEtag: `"${createHash('md5').update(bytes).digest('hex')}"`,
			uploaded: new Date(0),
			checksums: {},
			customMetadata: {},
			writeHttpMetadata: () => undefined,
			storageClass: 'Standard',
			ssecKeyMd5: undefined,
		} as unknown as R2Object
	}
}

export const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111'
export const DATABASE_ID = '22222222-2222-4222-8222-222222222222'
const DRILL_ACCOUNT_ID = '33333333-3333-4333-8333-333333333333'
const BASELINE_SHA256 = 'b'.repeat(64)
const manifestSigningKeys = generateKeyPairSync('ed25519')

export function badSqlStatsFixture(
	day: string,
	objectKey: string,
): BackupSqlStats {
	return {
		schemaVersion: backupSqlStatsSchemaVersion,
		day,
		objectKey,
		maxStatementBytes: 1_495_663,
		oversizedStatementCount: 1,
		importStatementLimitBytes: 100_000,
	}
}

export async function putSqlStatsFixture(
	bucket: MemoryBucket,
	day: string,
	objectKey: string,
	options: { oversized?: boolean } = {},
): Promise<void> {
	const stats = options.oversized
		? badSqlStatsFixture(day, objectKey)
		: {
				...badSqlStatsFixture(day, objectKey),
				maxStatementBytes: 50_000,
				oversizedStatementCount: 0,
			}
	await bucket.put(backupSqlStatsKey(objectKey), JSON.stringify(stats))
}

export function environment(bucket = new MemoryBucket()): BackupEnvironment {
	return {
		BACKUP_BUCKET: bucket as unknown as R2Bucket,
		BACKUP_WORKFLOW: {} as Workflow,
		RESTORE_WORKFLOW: {} as Workflow,
		SEAL_WORKFLOW: {} as Workflow,
		CLOUDFLARE_API_TOKEN: 'not-logged-secret',
		SOURCE_ACCOUNT_ID: ACCOUNT_ID,
		SOURCE_DATABASE_ID: DATABASE_ID,
		SOURCE_DATABASE_NAME: 'production-db',
		ALLOWED_SOURCE_ACCOUNT_IDS: ACCOUNT_ID,
		ALLOWED_SOURCE_DATABASE_IDS: DATABASE_ID,
		ENABLE_PRODUCTION_D1_BACKUPS: 'true',
		BACKUP_BENCHMARK_APPROVED: 'true',
		BUILD_COMMIT: 'abc123',
		BACKUP_MANIFEST_SIGNING_KEY_ID: 'backup-manifest-2026',
		BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64: encodeNodeBytesAsBase64(
			manifestSigningKeys.privateKey.export({ format: 'der', type: 'pkcs8' }),
		),
		BACKUP_MANIFEST_VERIFYING_PUBLIC_KEY_SPKI_BASE64: encodeNodeBytesAsBase64(
			manifestSigningKeys.publicKey.export({ format: 'der', type: 'spki' }),
		),
		TRUSTED_RESTORE_BASELINE_ID: 'production-baseline-2026',
		TRUSTED_RESTORE_BASELINE_SHA256: BASELINE_SHA256,
		ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
		ACCESS_APP_AUD: 'access-app-audience',
		ACCESS_ALLOWED_EMAIL: 'ops@example.com',
		DRILL_ACCOUNT_ID,
		PRIMARY_WORKER_ORIGIN: 'https://primary.example',
		DRILL_API_TOKEN: 'drill-token',
		RESTORE_CONFIRM_SECRET: 'restore-confirm-secret',
		DR_RESTORE_SECRET: 'dr-restore-secret',
		DR_OPS_SECRET: 'dr-ops-secret',
	}
}

export class ReplayStep implements DurableExportStep {
	readonly calls: string[] = []
	readonly executions: string[] = []
	readonly sleeps: string[] = []
	private readonly cache = new Map<string, unknown>()
	private interrupted = false
	private readonly interruptAfter: string | undefined

	constructor(interruptAfter?: string) {
		this.interruptAfter = interruptAfter
	}

	async do<T>(
		name: string,
		_config: Parameters<DurableExportStep['do']>[1],
		callback: () => Promise<T>,
	): Promise<T> {
		this.calls.push(name)
		if (this.cache.has(name)) return this.cache.get(name) as T
		this.executions.push(name)
		const value = await callback()
		this.cache.set(name, value)
		if (name === this.interruptAfter && !this.interrupted) {
			this.interrupted = true
			throw new Error('simulated workflow interruption after persisted step')
		}
		return value
	}

	async sleep(name: string): Promise<void> {
		this.sleeps.push(name)
	}
}

/**
 * Upload steps return `{ kind: 'stored', stored }` (or expired). Older doubles
 * also accepted a bare StoredBackup; keep both shapes readable in tests.
 */
function uploadAlreadyExisted(result: unknown): boolean {
	if (
		result !== null &&
		typeof result === 'object' &&
		'kind' in result &&
		(result as { kind: unknown }).kind === 'stored' &&
		'stored' in result
	) {
		const stored = (result as { stored: { alreadyExisted?: boolean } }).stored
		return stored.alreadyExisted === true
	}
	return (
		result !== null &&
		typeof result === 'object' &&
		(result as { alreadyExisted?: boolean }).alreadyExisted === true
	)
}

export class RetryAfterCommitStep implements BackupRuntimeStep {
	readonly uploadResults: boolean[] = []
	private readonly cache = new Map<string, unknown>()
	private readonly afterFirstUpload: (() => void) | undefined

	constructor(afterFirstUpload?: () => void) {
		this.afterFirstUpload = afterFirstUpload
	}

	async do<T>(
		name: string,
		config: unknown,
		callback: () => Promise<T>,
	): Promise<T>
	async do<T>(name: string, callback: () => Promise<T>): Promise<T>
	async do<T>(
		name: string,
		configOrCallback: unknown,
		callback?: () => Promise<T>,
	): Promise<T> {
		if (this.cache.has(name)) return this.cache.get(name) as T
		const execute =
			typeof configOrCallback === 'function'
				? (configOrCallback as () => Promise<T>)
				: callback!
		if (name.endsWith('stream-export-to-immutable-r2')) {
			try {
				const discarded = await execute()
				this.uploadResults.push(uploadAlreadyExisted(discarded))
				this.afterFirstUpload?.()
				throw new Error('simulated Workflow failure before step persistence')
			} catch (error) {
				if (
					!(error instanceof Error) ||
					error.message !== 'simulated Workflow failure before step persistence'
				) {
					throw error
				}
			}
			const retried = await execute()
			this.uploadResults.push(uploadAlreadyExisted(retried))
			this.cache.set(name, retried)
			return retried
		}
		const value = await execute()
		this.cache.set(name, value)
		return value
	}

	async sleep(): Promise<void> {}
}

export class CachedUploadStep implements BackupRuntimeStep {
	private readonly cache = new Map<string, unknown>()
	private readonly afterUpload: () => void | Promise<void>
	private readonly afterFinalization?: () => Promise<void>

	constructor(
		afterUpload: () => void | Promise<void>,
		afterFinalization?: () => Promise<void>,
	) {
		this.afterUpload = afterUpload
		this.afterFinalization = afterFinalization
	}

	async do<T>(
		name: string,
		config: unknown,
		callback: () => Promise<T>,
	): Promise<T>
	async do<T>(name: string, callback: () => Promise<T>): Promise<T>
	async do<T>(
		name: string,
		configOrCallback: unknown,
		callback?: () => Promise<T>,
	): Promise<T> {
		if (this.cache.has(name)) return this.cache.get(name) as T
		const execute =
			typeof configOrCallback === 'function'
				? (configOrCallback as () => Promise<T>)
				: callback!
		const value = await execute()
		this.cache.set(name, value)
		if (name.endsWith('stream-export-to-immutable-r2')) await this.afterUpload()
		if (
			name === 'verify-stored-object-and-write-immutable-manifest' &&
			this.afterFinalization
		) {
			await this.afterFinalization()
		}
		return value
	}

	async sleep(): Promise<void> {}
}

export class PreStatsUploadStep implements BackupRuntimeStep {
	private readonly cache = new Map<string, unknown>()

	async do<T>(
		name: string,
		config: unknown,
		callback: () => Promise<T>,
	): Promise<T>
	async do<T>(name: string, callback: () => Promise<T>): Promise<T>
	async do<T>(
		name: string,
		configOrCallback: unknown,
		callback?: () => Promise<T>,
	): Promise<T> {
		if (this.cache.has(name)) return this.cache.get(name) as T
		const execute =
			typeof configOrCallback === 'function'
				? (configOrCallback as () => Promise<T>)
				: callback!
		const value = await execute()
		const persisted = stripUploadSqlStatementStats(name, value)
		this.cache.set(name, persisted)
		return persisted as T
	}

	async sleep(): Promise<void> {}
}

/** Drop sqlStatementStats from an upload step result (flat or `{ kind: 'stored' }`). */
function stripUploadSqlStatementStats(name: string, value: unknown): unknown {
	if (
		!name.endsWith('stream-export-to-immutable-r2') ||
		value === null ||
		typeof value !== 'object'
	) {
		return value
	}
	if (
		'kind' in value &&
		(value as { kind: unknown }).kind === 'stored' &&
		'stored' in value &&
		(value as { stored: unknown }).stored !== null &&
		typeof (value as { stored: unknown }).stored === 'object'
	) {
		const stored = (value as { stored: Record<string, unknown> }).stored
		return {
			...value,
			stored: Object.fromEntries(
				Object.entries(stored).filter(([key]) => key !== 'sqlStatementStats'),
			),
		}
	}
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).filter(
			([key]) => key !== 'sqlStatementStats',
		),
	)
}

export class RetryUploadStep implements BackupRuntimeStep {
	readonly uploadAttempts: number[] = []
	private readonly cache = new Map<string, unknown>()

	async do<T>(
		name: string,
		config: unknown,
		callback: () => Promise<T>,
	): Promise<T>
	async do<T>(name: string, callback: () => Promise<T>): Promise<T>
	async do<T>(
		name: string,
		configOrCallback: unknown,
		callback?: () => Promise<T>,
	): Promise<T> {
		if (this.cache.has(name)) return this.cache.get(name) as T
		const execute =
			typeof configOrCallback === 'function'
				? (configOrCallback as () => Promise<T>)
				: callback!
		if (name.endsWith('stream-export-to-immutable-r2')) {
			for (let attempt = 1; attempt <= 2; attempt += 1) {
				this.uploadAttempts.push(attempt)
				try {
					const value = await execute()
					this.cache.set(name, value)
					return value
				} catch (error) {
					if (
						attempt === 2 ||
						!(error instanceof BackupError) ||
						!error.retryable
					) {
						throw error
					}
				}
			}
		}
		const value = await execute()
		this.cache.set(name, value)
		return value
	}

	async sleep(): Promise<void> {}
}

/** Cloudflare's default when a step passes no retry config. */
const engineDefaultRetryLimit = 5

/**
 * The Workflows engine's terminal-failure rule: it checks the name (or a
 * message prefix), not `instanceof`, because the error crosses an RPC boundary.
 */
function engineTreatsAsTerminal(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === 'NonRetryableError' ||
			error.message.startsWith('NonRetryableError'))
	)
}

/** Workflow engine double that retries like the engine and records every attempt. */
export class RetryingWorkflowStep implements BackupRuntimeStep {
	attempts = 0
	readonly names: string[] = []

	async do<T>(
		name: string,
		configOrCallback: unknown,
		callback?: () => Promise<T>,
	): Promise<T> {
		this.names.push(name)
		const execute = callback ?? (configOrCallback as () => Promise<T>)
		const retryLimit = callback
			? ((configOrCallback as { retries?: { limit: number } }).retries?.limit ??
				engineDefaultRetryLimit)
			: engineDefaultRetryLimit
		for (let attempt = 0; ; attempt += 1) {
			this.attempts += 1
			try {
				return await execute()
			} catch (error) {
				if (engineTreatsAsTerminal(error) || attempt >= retryLimit) {
					throw error
				}
			}
		}
	}

	async sleep(): Promise<void> {}
}

export function exportEnvelope(
	status?: 'complete' | 'error' | 'active' | 'lost',
	bookmark = 'bookmark-1',
	signedUrl = 'https://download.example/export.sql',
): Response {
	if (status === 'lost') {
		return Response.json({
			success: true,
			result: {
				success: false,
				error: 'Not currently exporting anything.',
			},
		})
	}
	return Response.json({
		success: true,
		result: {
			type: 'export',
			success: true,
			at_bookmark: bookmark,
			status,
			...(status === 'complete' ? { result: { signed_url: signedUrl } } : {}),
			...(status === 'error' ? { error: 'internal detail' } : {}),
		},
	})
}

export function identityEnvelope(
	fileSize: unknown,
	includeSize = true,
): Response {
	return Response.json({
		success: true,
		result: {
			uuid: DATABASE_ID,
			name: 'production-db',
			...(includeSize ? { file_size: fileSize } : {}),
		},
	})
}

export function identityApi(fileSize = 1_000) {
	return {
		fetcher: async () => identityEnvelope(fileSize),
		sleep: async () => undefined,
	}
}

export function manifest(stored: {
	bytes: number
	sha256: string
	r2Etag: string
}): BackupManifest {
	const payload: BackupManifestPayload = {
		schemaVersion: backupManifestSchemaVersion,
		source: {
			accountId: ACCOUNT_ID,
			databaseId: DATABASE_ID,
			databaseName: 'production-db',
		},
		export: {
			bookmark: 'bookmark-1',
			scheduledAt: '2026-07-22T02:15:00.000Z',
			startedAt: '2026-07-22T02:15:01.000Z',
			completedAt: '2026-07-22T02:16:00.000Z',
		},
		sql: {
			objectKey: objectKeyForBookmark(
				`daily/d1/${DATABASE_ID}/2026-07-22`,
				'bookmark-1',
			),
			bytes: stored.bytes,
			sha256: stored.sha256,
			r2Etag: stored.r2Etag,
		},
		buildCommit: 'abc123',
		retentionTier: 'daily',
		restoreBaseline: {
			id: 'production-baseline-2026',
			sha256: BASELINE_SHA256,
		},
		signing: {
			algorithm: backupManifestSignatureAlgorithm,
			keyId: 'backup-manifest-2026',
		},
	}
	return signedManifest(payload)
}

export function signedManifest(payload: BackupManifestPayload): BackupManifest {
	return {
		schemaVersion: backupManifestSchemaVersion,
		payload,
		signature: {
			algorithm: backupManifestSignatureAlgorithm,
			keyId: payload.signing.keyId,
			value: encodeNodeBytesAsBase64(
				signBytes(
					null,
					Buffer.from(canonicalBackupManifestPayload(payload)),
					manifestSigningKeys.privateKey,
				),
			),
		},
	}
}
