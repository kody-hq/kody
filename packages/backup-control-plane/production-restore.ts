import {
	pacedD1RetentionTierForDay,
	pacedD1SealedManifestKey,
} from '@kody-internal/shared/backup-d1-paced.ts'
import { sealedFullManifestKey } from '@kody-internal/shared/backup-staging.ts'

import {
	BackupError,
	absentConfiguredSourceNote,
	bindSourceDatabase,
	configuredSourceDatabases,
	pacedSourceDatabases,
	primarySourceDatabase,
	restoreImportOrder,
	safeLog,
	type SourceDatabase,
} from './backup-policy.ts'
import type { BackupEnvironment } from './backup-types.ts'
import {
	awaitExportReady,
	startD1Export,
	type ApiOptions,
} from './d1-export-api.ts'
import { verifyBackupFullManifestSignature } from './full-manifest-signing.ts'
import {
	bucketReader,
	importPacedTargetUnits,
	planPacedTargetRestore,
	preflightPacedTargetUnits,
	quickCheckPacedTarget,
	scanPacedTargetTable,
	type PacedTargetD1,
	type PacedTargetPlan,
	type PacedTargetStep,
} from './paced-d1-target-restore.ts'
import { readFullManifest } from './seal-full-backup.ts'

type DrRestoreChunkResponse = {
	done: boolean
	nextCursor?: string
	progress: unknown
	warnings: Array<string>
}

export type ProductionRestorePayload = {
	day: string
	requestedAt: string
}

type ProductionRestoreProgressValue =
	| string
	| number
	| boolean
	| null
	| Array<string>
	| { [key: string]: string | number | boolean | null | Array<string> }

export type ProductionRestoreProgress = {
	day: string
	phase:
		| 'validating'
		| 'capturing-safety-export'
		| 'importing-d1'
		| 'restoring-stores'
		| 'complete'
		| 'failed'
	d1ImportComplete: boolean
	storeRestoreComplete: boolean
	storeIterations: number
	warnings: Array<string>
	notes: Array<string>
	safetyExportKey?: string
	safetyExportBytes?: number
	safetyExports?: Array<{
		databaseId: string
		databaseName: string
		objectKey: string
		bytes: number
	}>
	errorCode?: string
	errorMessage?: string
	progress?: ProductionRestoreProgressValue
}

const MAX_STORE_RESTORE_ITERATIONS = 500
const DEFAULT_SAFETY_EXPORT_POLLS = 120
const DEFAULT_SAFETY_EXPORT_POLL_DELAY_MS = 15_000

function serializeRestoreProgress(
	value: unknown,
): ProductionRestoreProgressValue {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'boolean'
	) {
		return value
	}
	if (
		Array.isArray(value) &&
		value.every((entry) => typeof entry === 'string')
	) {
		return value
	}
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const record: {
			[key: string]: string | number | boolean | null | Array<string>
		} = {}
		for (const [key, entry] of Object.entries(value)) {
			if (
				entry === null ||
				typeof entry === 'string' ||
				typeof entry === 'number' ||
				typeof entry === 'boolean'
			) {
				record[key] = entry
				continue
			}
			if (
				Array.isArray(entry) &&
				entry.every((item) => typeof item === 'string')
			) {
				record[key] = entry
			}
		}
		return record
	}
	return null
}

function requireDrRestoreSecret(env: BackupEnvironment): string {
	const secret = env.DR_RESTORE_SECRET?.trim()
	if (!secret) {
		throw new BackupError(
			'dr-restore-secret-missing',
			'DR_RESTORE_SECRET is required',
		)
	}
	return secret
}

function requirePrimaryOrigin(env: BackupEnvironment): string {
	const origin = env.PRIMARY_WORKER_ORIGIN?.trim()
	if (!origin) {
		throw new BackupError(
			'primary-worker-origin-missing',
			'PRIMARY_WORKER_ORIGIN is required',
		)
	}
	return origin.replace(/\/$/, '')
}

export function restoreWorkflowInstanceId(
	day: string,
	expiresAt: string,
): string {
	const safeExpires = expiresAt.replaceAll(':', '-').replaceAll('.', '-')
	return `dr-restore-${day}-${safeExpires}`
}

function sha256HexFromBuffer(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

function appendAbsentConfiguredSourceNotes(
	env: BackupEnvironment,
	declared: Array<SourceDatabase>,
	progress: ProductionRestoreProgress,
): void {
	const declaredIds = new Set(declared.map((source) => source.id.toLowerCase()))
	for (const source of configuredSourceDatabases(env)) {
		if (!declaredIds.has(source.id.toLowerCase())) {
			progress.notes.push(absentConfiguredSourceNote(source))
		}
	}
}

export function restoreProgressFailsWorkflow(
	progress: ProductionRestoreProgress,
): boolean {
	return progress.phase === 'failed' || progress.warnings.length > 0
}

export type ValidatedSealedDay = {
	fullManifestKey: string
	pacedSources: Array<SourceDatabase>
}

export async function validateSealedDayForRestore(
	env: BackupEnvironment,
	day: string,
): Promise<ValidatedSealedDay> {
	const fullManifestKey = sealedFullManifestKey(day)
	const fullManifest = await readFullManifest(
		env.BACKUP_BUCKET,
		fullManifestKey,
	).catch((error: unknown) => {
		if (
			error instanceof BackupError &&
			error.code === 'full-manifest-rest-era'
		) {
			throw new BackupError(
				'restore-rest-era-day',
				`${day} is a REST-era backup day (${error.message}); restore a schema-v3 paced day instead`,
			)
		}
		throw error
	})
	if (fullManifest === null) {
		throw new BackupError(
			'restore-full-manifest-missing',
			`sealed full manifest missing for ${day}`,
		)
	}
	if (!(await verifyBackupFullManifestSignature(env, fullManifest))) {
		throw new BackupError(
			'restore-full-manifest-signature-invalid',
			`sealed full manifest signature invalid for ${day}`,
		)
	}
	const configured = pacedSourceDatabases(env)
	const tier = pacedD1RetentionTierForDay(day)
	const pacedSources: Array<SourceDatabase> = []
	for (const entry of fullManifest.payload.d1Paced) {
		const source = configured.find(
			(candidate) =>
				candidate.id.toLowerCase() === entry.databaseId.toLowerCase(),
		)
		if (source === undefined) {
			throw new BackupError(
				'restore-d1-source-not-configured',
				`sealed paced source ${entry.databaseName} (${entry.databaseId}) is not a configured paced source`,
			)
		}
		if (entry.manifestKey !== pacedD1SealedManifestKey(tier, source.id, day)) {
			throw new BackupError(
				'restore-paced-manifest-key-mismatch',
				`sealed full manifest points ${source.name} at an unexpected paced manifest key`,
			)
		}
		const object = await env.BACKUP_BUCKET.get(entry.manifestKey)
		if (object === null) {
			throw new BackupError(
				'restore-paced-seal-missing',
				`no sealed paced manifest for ${source.name} on ${day}`,
			)
		}
		if (
			sha256HexFromBuffer(
				await crypto.subtle.digest('SHA-256', await object.arrayBuffer()),
			) !== entry.manifestSha256.toLowerCase()
		) {
			throw new BackupError(
				'restore-paced-manifest-digest-mismatch',
				`sealed paced manifest for ${source.name} on ${day} does not match the signed full manifest`,
			)
		}
		pacedSources.push(source)
	}
	if (
		!pacedSources.some(
			(source) =>
				source.id.toLowerCase() === env.SOURCE_DATABASE_ID.toLowerCase(),
		)
	) {
		throw new BackupError(
			'restore-d1-source-not-configured',
			'sealed paced D1 sources do not include the primary database',
		)
	}
	return { fullManifestKey, pacedSources }
}

async function callProductionDrRestore(
	env: BackupEnvironment,
	input: { day: string; cursor?: string },
	options: ApiOptions = {},
): Promise<DrRestoreChunkResponse> {
	const fetcher = options.fetcher ?? fetch
	const origin = requirePrimaryOrigin(env)
	const secret = requireDrRestoreSecret(env)
	let response: Response
	try {
		response = await fetcher(`${origin}/__maintenance/dr-restore`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${secret}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				day: input.day,
				...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
			}),
		})
	} catch {
		throw new BackupError(
			'dr-restore-network-failure',
			'production dr-restore request failed',
			true,
		)
	}
	if (!response.ok) {
		throw new BackupError(
			'dr-restore-http-error',
			`production dr-restore returned HTTP ${response.status}`,
			response.status === 429 || response.status >= 500,
		)
	}
	const body = (await response.json()) as unknown
	if (
		!body ||
		typeof body !== 'object' ||
		Array.isArray(body) ||
		typeof (body as { done?: unknown }).done !== 'boolean' ||
		!Array.isArray((body as { warnings?: unknown }).warnings) ||
		!(body as { warnings: unknown[] }).warnings.every(
			(warning) => typeof warning === 'string',
		)
	) {
		throw new BackupError(
			'dr-restore-malformed',
			'production dr-restore response was invalid',
		)
	}
	const record = body as {
		done: boolean
		nextCursor?: unknown
		progress: unknown
		warnings: Array<string>
	}
	if (
		record.nextCursor !== undefined &&
		typeof record.nextCursor !== 'string'
	) {
		throw new BackupError(
			'dr-restore-malformed',
			'production dr-restore nextCursor was invalid',
		)
	}
	return {
		done: record.done,
		nextCursor:
			typeof record.nextCursor === 'string' ? record.nextCursor : undefined,
		progress: record.progress,
		warnings: record.warnings,
	}
}

async function capturePreRestoreSafetyExport(
	env: BackupEnvironment,
	day: string,
	now: Date = new Date(),
	options: ApiOptions & {
		maxPollAttempts?: number
		pollDelayMs?: number
	} = {},
	sources: Array<SourceDatabase> = configuredSourceDatabases(env),
): Promise<{
	objectKey: string
	bytes: number
	exports: Array<{
		databaseId: string
		databaseName: string
		objectKey: string
		bytes: number
	}>
}> {
	const exports: Array<{
		databaseId: string
		databaseName: string
		objectKey: string
		bytes: number
	}> = []
	let primary: { objectKey: string; bytes: number } | undefined
	for (const source of sources) {
		const captured = await captureOneSourceSafetyExport(
			bindSourceDatabase(env, source),
			day,
			now,
			options,
		)
		exports.push({
			databaseId: source.id,
			databaseName: source.name,
			objectKey: captured.objectKey,
			bytes: captured.bytes,
		})
		if (source.id.toLowerCase() === env.SOURCE_DATABASE_ID.toLowerCase()) {
			primary = captured
		}
	}
	if (primary === undefined) {
		throw new BackupError(
			'pre-restore-download-failed',
			'pre-restore safety export missed the primary database',
		)
	}
	return { objectKey: primary.objectKey, bytes: primary.bytes, exports }
}

async function captureOneSourceSafetyExport(
	env: BackupEnvironment,
	day: string,
	now: Date,
	options: ApiOptions & {
		maxPollAttempts?: number
		pollDelayMs?: number
	},
): Promise<{ objectKey: string; bytes: number }> {
	const fetcher = options.fetcher ?? fetch
	const sleep =
		options.sleep ?? ((milliseconds) => scheduler.wait(milliseconds))
	const maxPollAttempts = options.maxPollAttempts ?? DEFAULT_SAFETY_EXPORT_POLLS
	const pollDelayMs = options.pollDelayMs ?? DEFAULT_SAFETY_EXPORT_POLL_DELAY_MS

	const started = await startD1Export(env, options)
	const completed = await awaitExportReady(env, started, {
		...options,
		maxPollAttempts,
		pollDelayMs,
		earlyPollDelayMs: Math.min(pollDelayMs, 2_000),
		sleep,
	})

	let download: Response
	try {
		download = await fetcher(completed.signedUrl)
	} catch {
		throw new BackupError(
			'pre-restore-download-failed',
			'pre-restore safety export download failed',
			true,
		)
	}
	if (!download.ok || download.body === null) {
		throw new BackupError(
			'pre-restore-download-http-error',
			`pre-restore safety export download returned HTTP ${download.status}`,
			download.status === 429 || download.status >= 500,
		)
	}
	const contentLength = download.headers.get('content-length')
	const objectKey = `pre-restore/${day}/${env.SOURCE_DATABASE_ID}/${now.toISOString()}.sql`
	if (contentLength !== null && /^\d+$/.test(contentLength)) {
		const bytes = Number(contentLength)
		if (!Number.isSafeInteger(bytes) || bytes <= 0) {
			throw new BackupError(
				'pre-restore-download-invalid-length',
				'pre-restore safety export Content-Length is invalid',
			)
		}
		await env.BACKUP_BUCKET.put(objectKey, download.body, {
			httpMetadata: { contentType: 'application/sql' },
		})
		return { objectKey, bytes }
	}
	// Some runtimes rewrite Content-Length on constructed Response bodies;
	// fall back to buffering so the safety snapshot still records exact bytes.
	const buffer = new Uint8Array(await download.arrayBuffer())
	if (buffer.byteLength === 0) {
		throw new BackupError(
			'pre-restore-download-empty',
			'pre-restore safety export download was empty',
			true,
		)
	}
	await env.BACKUP_BUCKET.put(objectKey, buffer, {
		httpMetadata: { contentType: 'application/sql' },
	})
	return { objectKey, bytes: buffer.byteLength }
}

const inlineStep: PacedTargetStep = {
	do: async (_name, callback) => callback(),
}

/**
 * Replay one sealed paced chain into its production D1 database, then require
 * every table's target count and re-hashed checksum to match the tip manifest.
 */
async function restorePacedSourceIntoProduction(
	env: BackupEnvironment,
	day: string,
	source: SourceDatabase,
	input: { step: PacedTargetStep; api: ApiOptions; plan: PacedTargetPlan },
): Promise<void> {
	const reader = bucketReader(env.BACKUP_BUCKET)
	const target: PacedTargetD1 = {
		accountId: env.SOURCE_ACCOUNT_ID,
		databaseId: source.id,
		token: env.CLOUDFLARE_API_TOKEN,
		options: input.api,
	}
	const { plan } = input
	await importPacedTargetUnits({
		reader,
		source,
		day,
		step: input.step,
		plan,
		target,
		onUnit: async () => undefined,
	})
	const quickCheck = await quickCheckPacedTarget({
		source,
		step: input.step,
		target,
	})
	const failing: Array<string> = []
	for (const [tableIndex, table] of plan.tables.entries()) {
		const scan = await scanPacedTargetTable({
			source,
			step: input.step,
			target,
			table,
			tableIndex,
		})
		if (
			scan.count !== table.manifestCount ||
			scan.checksum !== table.manifestChecksum
		) {
			failing.push(
				`${table.table} (manifest ${String(table.manifestCount)}, restored ${String(scan.count)})`,
			)
		}
	}
	if (quickCheck !== 'ok' || failing.length > 0) {
		throw new BackupError(
			'restore-paced-verify-mismatch',
			`${source.name}: ${quickCheck === 'ok' ? `count or checksum mismatch: ${failing.join(', ')}` : `PRAGMA quick_check returned ${quickCheck}`}`,
		)
	}
}

export async function runProductionRestore(
	env: BackupEnvironment,
	payload: ProductionRestorePayload,
	options: ApiOptions & {
		maxPollAttempts?: number
		pollDelayMs?: number
		onProgress?: (progress: ProductionRestoreProgress) => Promise<void> | void
		step?: PacedTargetStep
		now?: Date
	} = {},
): Promise<ProductionRestoreProgress> {
	const progress: ProductionRestoreProgress = {
		day: payload.day,
		phase: 'validating',
		d1ImportComplete: false,
		storeRestoreComplete: false,
		storeIterations: 0,
		warnings: [],
		notes: [],
	}
	const publish = async () => {
		await options.onProgress?.(progress)
	}
	const step = options.step ?? inlineStep
	try {
		await publish()
		const validated = await step.do('restore-validate', async () =>
			validateSealedDayForRestore(env, payload.day),
		)
		const restoredSources = validated.pacedSources
		const pacedPlans = new Map<string, PacedTargetPlan>()
		const reader = bucketReader(env.BACKUP_BUCKET)
		for (const source of restoredSources) {
			const plan = await planPacedTargetRestore({
				reader,
				source,
				day: payload.day,
				step,
				missingCode: 'restore-paced-seal-missing',
			})
			await preflightPacedTargetUnits({
				reader,
				source,
				day: payload.day,
				step,
				plan,
			})
			pacedPlans.set(source.id, plan)
		}

		progress.phase = 'capturing-safety-export'
		await publish()
		safeLog({
			event: 'production-restore-safety-export-started',
			status: 'success',
			day: payload.day,
		})
		const safety = await step.do('restore-safety-export', async () =>
			capturePreRestoreSafetyExport(
				env,
				payload.day,
				options.now ?? new Date(),
				options,
				restoredSources,
			),
		)
		progress.safetyExportKey = safety.objectKey
		progress.safetyExportBytes = safety.bytes
		progress.safetyExports = safety.exports
		await publish()
		safeLog({
			event: 'production-restore-safety-export-complete',
			status: 'success',
			day: payload.day,
			objectKey: safety.objectKey,
			bytes: safety.bytes,
		})
		progress.phase = 'importing-d1'
		await publish()
		safeLog({
			event: 'production-restore-d1-import-started',
			status: 'success',
			day: payload.day,
		})
		const importOrder = restoreImportOrder(
			restoredSources,
			primarySourceDatabase(env),
		)
		for (const source of importOrder) {
			await restorePacedSourceIntoProduction(env, payload.day, source, {
				step,
				api: options,
				plan: pacedPlans.get(source.id)!,
			})
		}
		progress.d1ImportComplete = true
		progress.phase = 'restoring-stores'
		await publish()
		safeLog({
			event: 'production-restore-d1-import-complete',
			status: 'success',
			day: payload.day,
		})

		let cursor: string | undefined
		for (
			let iteration = 1;
			iteration <= MAX_STORE_RESTORE_ITERATIONS;
			iteration += 1
		) {
			progress.storeIterations = iteration
			const from = cursor
			const chunk = await step.do(
				`restore-stores:${String(iteration)}`,
				async () =>
					callProductionDrRestore(
						env,
						{ day: payload.day, cursor: from },
						options,
					),
			)
			progress.warnings.push(...chunk.warnings)
			progress.progress = serializeRestoreProgress(chunk.progress)
			await publish()
			if (chunk.done) {
				progress.storeRestoreComplete = true
				if (progress.warnings.length > 0) {
					progress.phase = 'failed'
					progress.errorCode = 'dr-restore-warnings'
					progress.errorMessage = `dr-restore completed with ${String(progress.warnings.length)} warning(s)`
					appendAbsentConfiguredSourceNotes(env, restoredSources, progress)
					await publish()
					safeLog({
						event: 'production-restore-failure',
						status: 'failure',
						day: payload.day,
						errorCode: progress.errorCode,
					})
					return progress
				}
				appendAbsentConfiguredSourceNotes(env, restoredSources, progress)
				progress.phase = 'complete'
				await publish()
				safeLog({
					event: 'production-restore-complete',
					status: 'success',
					day: payload.day,
				})
				return progress
			}
			cursor = chunk.nextCursor
			if (cursor === undefined) {
				throw new BackupError(
					'dr-restore-missing-cursor',
					'production dr-restore returned incomplete without nextCursor',
				)
			}
		}
		throw new BackupError(
			'dr-restore-iteration-budget',
			'production dr-restore exceeded iteration budget',
		)
	} catch (error) {
		progress.phase = 'failed'
		progress.errorCode =
			error instanceof BackupError ? error.code : 'unexpected-error'
		progress.errorMessage =
			error instanceof Error ? error.message : 'unexpected restore failure'
		await publish()
		safeLog({
			event: 'production-restore-failure',
			status: 'failure',
			day: payload.day,
			errorCode: progress.errorCode,
		})
		throw error
	}
}
