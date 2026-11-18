import {
	assertBackupDay,
	backupBlobKey,
	backupR2BucketLabels,
	sealedFullPrefix,
	stagingArtifactsIndexKey,
	stagingPrefix,
	stagingR2IndexKey,
	stagingStorageDumpKey,
	stagingStorageIndexKey,
	type ArtifactsIndex,
	type BackupR2BucketLabel,
	type R2IndexEntry,
	type StorageDumpEntry,
	type StorageIndex,
} from '@kody-internal/shared/backup-staging.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	handleSecretMaintenanceRequest,
	MaintenanceFailureError,
} from '#worker/maintenance-handler.ts'
import { buildPublishedSourceSnapshotKvKey } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { storageRunnerRpc } from '#worker/storage-runner.ts'
import {
	createDrBackupS3Client,
	readDrBackupS3Config,
	type DrBackupS3Client,
} from '#worker/dr/backup-s3.ts'
import { sha256Hex } from '#worker/dr/sha256.ts'
import { decodeStorageIdentity } from '#worker/dr/storage-identity.ts'

export const drRestoreRunTimeBudgetMs = 20_000
const storageImportPageSize = 100

export type DrRestorePhase = 'storage' | 'r2' | 'artifacts' | 'done'

export type DrRestoreCursor = {
	phase: DrRestorePhase
	storageIndex: number
	/** Byte/line offset into the current storage NDJSON dump. */
	storageLineOffset: number
	/** Whether the current storage bucket has already been cleared. */
	storageReplaceStarted: boolean
	/**
	 * Whether the current dump object's full sha256 was verified against the
	 * sealed storage index before any importStorage page ran.
	 */
	storageDumpVerified: boolean
	r2LabelIndex: number
	r2LineOffset: number
	artifactsIndex: number
}

export type DrRestoreProgress = {
	day: string
	phase: DrRestorePhase
	storageRestored: number
	r2ObjectsRestored: number
	artifactsRestored: number
}

export type DrRestoreTickResult = {
	done: boolean
	nextCursor?: string
	progress: DrRestoreProgress
	warnings: Array<string>
}

function sealedObjectKey(day: string, stagingKey: string) {
	const staging = stagingPrefix(day)
	if (!stagingKey.startsWith(staging)) {
		throw new Error(`staging key ${stagingKey} is not under ${staging}`)
	}
	return `${sealedFullPrefix(day)}${stagingKey.slice(staging.length)}`
}

function encodeCursor(cursor: DrRestoreCursor): string {
	return btoa(JSON.stringify(cursor))
}

function requireNonNegativeSafeInteger(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`invalid cursor field ${field}`)
	}
	return value
}

function decodeCursor(raw: string | undefined): DrRestoreCursor {
	if (!raw) {
		return {
			phase: 'storage',
			storageIndex: 0,
			storageLineOffset: 0,
			storageReplaceStarted: false,
			storageDumpVerified: false,
			r2LabelIndex: 0,
			r2LineOffset: 0,
			artifactsIndex: 0,
		}
	}
	try {
		const parsed = JSON.parse(atob(raw)) as Partial<DrRestoreCursor>
		if (
			!parsed ||
			typeof parsed !== 'object' ||
			(parsed.phase !== 'storage' &&
				parsed.phase !== 'r2' &&
				parsed.phase !== 'artifacts' &&
				parsed.phase !== 'done')
		) {
			throw new Error('invalid cursor shape')
		}
		return {
			phase: parsed.phase,
			storageIndex: requireNonNegativeSafeInteger(
				parsed.storageIndex ?? 0,
				'storageIndex',
			),
			storageLineOffset: requireNonNegativeSafeInteger(
				parsed.storageLineOffset ?? 0,
				'storageLineOffset',
			),
			storageReplaceStarted: Boolean(parsed.storageReplaceStarted),
			storageDumpVerified: Boolean(parsed.storageDumpVerified),
			r2LabelIndex: requireNonNegativeSafeInteger(
				parsed.r2LabelIndex ?? 0,
				'r2LabelIndex',
			),
			r2LineOffset: requireNonNegativeSafeInteger(
				parsed.r2LineOffset ?? 0,
				'r2LineOffset',
			),
			artifactsIndex: requireNonNegativeSafeInteger(
				parsed.artifactsIndex ?? 0,
				'artifactsIndex',
			),
		}
	} catch (error) {
		throw new MaintenanceFailureError(
			`Invalid restore cursor: ${getErrorMessage(error)}`,
			{ progress: null, warnings: [] },
		)
	}
}

function parseNdjsonLines(text: string): Array<string> {
	if (!text) return []
	const lines = text.split('\n')
	if (lines.length > 0 && lines[lines.length - 1] === '') {
		lines.pop()
	}
	return lines
}

function r2BindingForLabel(
	env: Pick<Env, 'EMAIL_BLOBS' | 'COMMUNITY_ASSETS'>,
	label: BackupR2BucketLabel,
): R2Bucket {
	switch (label) {
		case 'email-blobs':
			return env.EMAIL_BLOBS
		case 'community-assets':
			return env.COMMUNITY_ASSETS
		default: {
			const exhaustive: never = label
			throw new Error(`unknown R2 backup label: ${String(exhaustive)}`)
		}
	}
}

async function loadStorageIndex(
	s3: DrBackupS3Client,
	day: string,
): Promise<StorageIndex> {
	const key = sealedObjectKey(day, stagingStorageIndexKey(day))
	const loaded = await s3.getText(key)
	if (!loaded) {
		throw new MaintenanceFailureError(
			`sealed storage index missing at ${key}`,
			{
				progress: null,
				warnings: [],
			},
		)
	}
	const parsed = JSON.parse(loaded.text) as StorageIndex
	if (!parsed || !Array.isArray(parsed.entries)) {
		throw new MaintenanceFailureError(
			'sealed storage index has invalid shape',
			{
				progress: null,
				warnings: [],
			},
		)
	}
	return parsed
}

async function loadArtifactsIndex(
	s3: DrBackupS3Client,
	day: string,
): Promise<ArtifactsIndex> {
	const key = sealedObjectKey(day, stagingArtifactsIndexKey(day))
	const loaded = await s3.getText(key)
	if (!loaded) {
		throw new MaintenanceFailureError(
			`sealed artifacts index missing at ${key}`,
			{ progress: null, warnings: [] },
		)
	}
	const parsed = JSON.parse(loaded.text) as ArtifactsIndex
	if (!parsed || !Array.isArray(parsed.entries)) {
		throw new MaintenanceFailureError(
			'sealed artifacts index has invalid shape',
			{ progress: null, warnings: [] },
		)
	}
	return parsed
}

async function verifyAndFetchBlob(
	s3: DrBackupS3Client,
	sha256: string,
): Promise<Uint8Array> {
	const key = backupBlobKey(sha256)
	const bytes = await s3.getBytes(key)
	if (!bytes) {
		throw new MaintenanceFailureError(`backup blob missing: ${key}`, {
			progress: null,
			warnings: [],
		})
	}
	const actual = await sha256Hex(bytes)
	if (actual !== sha256) {
		throw new MaintenanceFailureError(
			`backup blob sha256 mismatch for ${key}: expected ${sha256}, got ${actual}`,
			{ progress: null, warnings: [] },
		)
	}
	return bytes
}

async function restoreStoragePhase(input: {
	env: Env
	s3: DrBackupS3Client
	day: string
	cursor: DrRestoreCursor
	warnings: Array<string>
	progress: DrRestoreProgress
	startedAtMs: number
	timeBudgetMs: number
}): Promise<boolean> {
	const storageIndex = await loadStorageIndex(input.s3, input.day)
	while (input.cursor.storageIndex < storageIndex.entries.length) {
		if (Date.now() - input.startedAtMs >= input.timeBudgetMs) return true
		const entry = storageIndex.entries[input.cursor.storageIndex]!
		const part = entry.part ?? 0
		const previous = storageIndex.entries[input.cursor.storageIndex - 1]
		if (
			part > 0 &&
			(previous?.storageId !== entry.storageId ||
				(previous.part ?? 0) !== part - 1)
		) {
			throw new MaintenanceFailureError(
				`storage dump part ${String(part)} of ${entry.storageId} does not follow part ${String(part - 1)}`,
				{
					progress: input.progress,
					warnings: input.warnings,
				},
			)
		}
		const dumpKey = sealedObjectKey(
			input.day,
			stagingStorageDumpKey(input.day, entry.storageId, part),
		)
		const loaded = await input.s3.getText(dumpKey)
		if (!loaded) {
			throw new MaintenanceFailureError(
				`Missing sealed storage dump ${dumpKey}`,
				{
					progress: input.progress,
					warnings: input.warnings,
				},
			)
		}
		// Verify the full dump against the sealed index before any destructive
		// importStorage page. Each part is bounded by the exporter's dump buffer.
		if (!input.cursor.storageDumpVerified) {
			const actual = await sha256Hex(loaded.text)
			if (actual !== entry.sha256) {
				throw new MaintenanceFailureError(
					`storage dump sha256 mismatch for ${dumpKey}: expected ${entry.sha256}, got ${actual}`,
					{
						progress: input.progress,
						warnings: input.warnings,
					},
				)
			}
			input.cursor.storageDumpVerified = true
		}
		const lines = parseNdjsonLines(loaded.text)
		const { userId, storageId } = decodeStorageIdentity(entry.storageId)
		const runner = storageRunnerRpc({
			env: input.env,
			userId,
			storageId,
		})
		while (input.cursor.storageLineOffset < lines.length) {
			if (Date.now() - input.startedAtMs >= input.timeBudgetMs) return true
			const slice = lines.slice(
				input.cursor.storageLineOffset,
				input.cursor.storageLineOffset + storageImportPageSize,
			)
			const entries: Array<StorageDumpEntry> = slice.map((line) => {
				const parsed = JSON.parse(line) as StorageDumpEntry
				if (
					!parsed ||
					typeof parsed.key !== 'string' ||
					typeof parsed.valueJson !== 'string'
				) {
					throw new MaintenanceFailureError(
						`invalid storage dump line in ${dumpKey}`,
						{
							progress: input.progress,
							warnings: input.warnings,
						},
					)
				}
				return parsed
			})
			const replacePage =
				input.cursor.storageReplaceStarted || part > 0 ? 'continue' : 'first'
			await runner.importStorage({
				mode: 'replace',
				replacePage,
				entries,
			})
			input.cursor.storageReplaceStarted = true
			input.cursor.storageLineOffset += slice.length
		}
		// Empty dump: still clear via a first page with no entries.
		if (!input.cursor.storageReplaceStarted && part === 0) {
			await runner.importStorage({
				mode: 'replace',
				replacePage: 'first',
				entries: [],
			})
		}
		input.cursor.storageIndex += 1
		input.cursor.storageLineOffset = 0
		input.cursor.storageReplaceStarted = false
		input.cursor.storageDumpVerified = false
		input.progress.storageRestored += 1
	}
	input.cursor.phase = 'r2'
	input.progress.phase = 'r2'
	return false
}

async function restoreR2Phase(input: {
	env: Env
	s3: DrBackupS3Client
	day: string
	cursor: DrRestoreCursor
	warnings: Array<string>
	progress: DrRestoreProgress
	startedAtMs: number
	timeBudgetMs: number
}): Promise<boolean> {
	while (input.cursor.r2LabelIndex < backupR2BucketLabels.length) {
		if (Date.now() - input.startedAtMs >= input.timeBudgetMs) return true
		const label = backupR2BucketLabels[input.cursor.r2LabelIndex]!
		const indexKey = sealedObjectKey(
			input.day,
			stagingR2IndexKey(input.day, label),
		)
		const loaded = await input.s3.getText(indexKey)
		if (!loaded) {
			throw new MaintenanceFailureError(`Missing sealed R2 index ${indexKey}`, {
				progress: input.progress,
				warnings: input.warnings,
			})
		}
		const lines = parseNdjsonLines(loaded.text)
		const bucket = r2BindingForLabel(input.env, label)
		while (input.cursor.r2LineOffset < lines.length) {
			if (Date.now() - input.startedAtMs >= input.timeBudgetMs) return true
			const line = lines[input.cursor.r2LineOffset]!
			const entry = JSON.parse(line) as R2IndexEntry
			if (
				!entry ||
				typeof entry.key !== 'string' ||
				typeof entry.sha256 !== 'string'
			) {
				throw new MaintenanceFailureError(
					`invalid R2 index line in ${indexKey}`,
					{
						progress: input.progress,
						warnings: input.warnings,
					},
				)
			}
			const bytes = await verifyAndFetchBlob(input.s3, entry.sha256)
			await bucket.put(entry.key, bytes)
			input.progress.r2ObjectsRestored += 1
			input.cursor.r2LineOffset += 1
		}
		input.cursor.r2LabelIndex += 1
		input.cursor.r2LineOffset = 0
	}
	input.cursor.phase = 'artifacts'
	input.progress.phase = 'artifacts'
	return false
}

async function restoreArtifactsPhase(input: {
	env: Env
	s3: DrBackupS3Client
	day: string
	cursor: DrRestoreCursor
	warnings: Array<string>
	progress: DrRestoreProgress
	startedAtMs: number
	timeBudgetMs: number
}): Promise<boolean> {
	const artifactsIndex = await loadArtifactsIndex(input.s3, input.day)
	while (input.cursor.artifactsIndex < artifactsIndex.entries.length) {
		if (Date.now() - input.startedAtMs >= input.timeBudgetMs) return true
		const entry = artifactsIndex.entries[input.cursor.artifactsIndex]!
		const bytes = await verifyAndFetchBlob(input.s3, entry.snapshotSha256)
		const kvKey = buildPublishedSourceSnapshotKvKey({
			sourceId: entry.sourceId,
			publishedCommit: entry.publishedCommit,
		})
		await input.env.BUNDLE_ARTIFACTS_KV.put(
			kvKey,
			new TextDecoder().decode(bytes),
		)
		input.progress.artifactsRestored += 1
		input.cursor.artifactsIndex += 1
	}
	input.cursor.phase = 'done'
	input.progress.phase = 'done'
	return false
}

export async function runDrRestoreTick(input: {
	env: Env
	day: string
	cursor?: string
	timeBudgetMs?: number
	s3?: DrBackupS3Client
}): Promise<DrRestoreTickResult> {
	assertBackupDay(input.day)
	const config = readDrBackupS3Config(input.env)
	if (!config) {
		throw new MaintenanceFailureError(
			'DR backup credentials are not configured',
			{
				progress: null,
				warnings: [],
			},
		)
	}
	const s3 = input.s3 ?? createDrBackupS3Client(config)
	const cursor = decodeCursor(input.cursor)
	const warnings: Array<string> = []
	const progress: DrRestoreProgress = {
		day: input.day,
		phase: cursor.phase,
		storageRestored: 0,
		r2ObjectsRestored: 0,
		artifactsRestored: 0,
	}
	const timeBudgetMs = input.timeBudgetMs ?? drRestoreRunTimeBudgetMs
	const startedAtMs = Date.now()
	let budgetExhausted = false

	if (cursor.phase === 'storage') {
		budgetExhausted = await restoreStoragePhase({
			env: input.env,
			s3,
			day: input.day,
			cursor,
			warnings,
			progress,
			startedAtMs,
			timeBudgetMs,
		})
	}
	if (!budgetExhausted && cursor.phase === 'r2') {
		budgetExhausted = await restoreR2Phase({
			env: input.env,
			s3,
			day: input.day,
			cursor,
			warnings,
			progress,
			startedAtMs,
			timeBudgetMs,
		})
	}
	if (!budgetExhausted && cursor.phase === 'artifacts') {
		budgetExhausted = await restoreArtifactsPhase({
			env: input.env,
			s3,
			day: input.day,
			cursor,
			warnings,
			progress,
			startedAtMs,
			timeBudgetMs,
		})
	}

	const done = cursor.phase === 'done' && !budgetExhausted
	progress.phase = cursor.phase
	return {
		done,
		...(done ? {} : { nextCursor: encodeCursor(cursor) }),
		progress,
		warnings,
	}
}

export async function handleDrRestoreRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	return handleSecretMaintenanceRequest({
		request,
		secret: env.DR_RESTORE_SECRET,
		notConfiguredMessage: 'DR restore is not configured',
		run: async () => {
			let body: { day?: unknown; cursor?: unknown }
			try {
				body = (await request.json()) as { day?: unknown; cursor?: unknown }
			} catch {
				throw new MaintenanceFailureError('Request body must be JSON', {
					progress: null,
					warnings: [],
				})
			}
			if (typeof body.day !== 'string') {
				throw new MaintenanceFailureError('Request body requires day: string', {
					progress: null,
					warnings: [],
				})
			}
			const cursor = typeof body.cursor === 'string' ? body.cursor : undefined
			return await runDrRestoreTick({
				env,
				day: body.day,
				cursor,
			})
		},
	})
}

export function __testOnlyEncodeCursor(cursor: DrRestoreCursor) {
	return encodeCursor(cursor)
}

export function __testOnlyDecodeCursor(raw: string | undefined) {
	return decodeCursor(raw)
}

export function __testOnlySealedObjectKey(day: string, stagingKey: string) {
	return sealedObjectKey(day, stagingKey)
}
