import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	assertBackupDay,
	backupBlobKey,
	backupR2BucketLabels,
	backupStagingSchemaVersion,
	parseLegacyStagingSummary,
	parseStagingSummary,
	stagingArtifactsIndexKey,
	stagingMailboxDumpKey,
	stagingMailboxIndexKey,
	stagingPrefix,
	stagingR2IndexKey,
	stagingRunLogDumpKey,
	stagingRunLogIndexKey,
	stagingStorageDumpKey,
	stagingStorageIndexKey,
	stagingSummaryKey,
	type ArtifactsIndex,
	type ArtifactsIndexEntry,
	type BackupR2BucketLabel,
	type MailboxIndex,
	type OwnerIndexEntry,
	type RunLogDumpEntry,
	type RunLogIndex,
	type StagingFileSummary,
	type StagingSummary,
	type StorageDumpEntry,
	type StorageIndex,
	type StorageIndexEntry,
} from '@kody-internal/shared/backup-staging.ts'
import { mailboxRpc } from '#worker/email/mailbox-client.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { buildPublishedSourceSnapshotKvKey } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { runLogRpc } from '#worker/run-records/service.ts'
import { storageRunnerRpc } from '#worker/storage-runner.ts'
import {
	createDrBackupS3Client,
	DrBackupPreconditionFailedError,
	readDrBackupS3Config,
	type DrBackupS3Client,
} from '#worker/dr/backup-s3.ts'
import { sha256Hex } from '#worker/dr/sha256.ts'
import {
	loadPreviousR2Index,
	putImmutableOutput,
	putLinkedChunk,
	readLinkedChunkBody,
	readLinkedChunkEntries,
	resolvePreviousSealedDay,
	stagingChunkKey,
	stagingOwnerDumpChunkKey,
	stagingR2IndexChunkKey,
	stagingStorageDumpChunkKey,
	type IncrementalR2IndexEntry,
} from '#worker/dr/exporter-staging.ts'
import {
	listPlatformArtifactInventory,
	listPlatformOwnerInventory,
	listPlatformStorageInventory,
	type ArtifactInventoryEntry,
	type StorageInventoryEntry,
} from '#worker/dr/exporter-inventory.ts'
import {
	drExportCatchUpLookbackDays,
	isDrExportConfigured,
	shouldRunDrExportCatchUpCron,
	shouldRunDrExportCron,
} from '#worker/dr/exporter-schedule.ts'

export {
	drExportCatchUpLookbackDays,
	isDrExportConfigured,
	shouldRunDrExportCatchUpCron,
	shouldRunDrExportCron,
	shouldRunDrExportWatchdogCron,
} from '#worker/dr/exporter-schedule.ts'

/**
 * Wall budget for one cron tick. 45s is still a small slice of the 5-minute
 * cron, and the lease is 2 minutes, so a tick finishes before the next one
 * starts. Raised from 20s after 2026-10-16 spent ~15h in the mailbox phase:
 * at ~5s per owner a 20s tick finished about 4 owners, which cannot keep up
 * with one UTC day per day once the owner count is past ~700.
 */
export const drExportRunTimeBudgetMs = 45_000
/**
 * Mailbox and RunLog owners are independent. Fetch this many first pages at
 * once so a wave waits on the slowest Durable Object instead of the sum.
 * Commits stay serial so progress and the index tail stay single-writer.
 */
const ownerExportConcurrency = 8
/** Skip individual R2 objects larger than this (full-buffer ceiling). */
export const drExportMaxObjectBytes = 25 * 1024 * 1024
/** Cap for an assembled storage dump before it is admitted to the index. */
export const drExportMaxStorageDumpBufferBytes = 16 * 1024 * 1024
const storageExportPageSize = 250
const indexChunkEntryLimit = 100
const previousSealedDayLookbackDays = 35
const progressLeaseDurationMs = 2 * 60_000
/** Watchdog / catch-up: older stranded work is "active" if it advanced within this window. */
const strandedCatchUpActiveMs = 2 * 60 * 60_000
/**
 * Page even while catch-up is moving when the oldest stranded day is this
 * many UTC days behind today. One day behind is the normal queue (yesterday
 * still draining). Two days behind means throughput is losing to the calendar,
 * which the "deferred-for-older-stranded" path used to hide.
 */
const stagingLagAlertDays = 2
const exporterProgressSchemaVersion = 3 as const
const ownerExportPageSize = 250
const runLogInitialCursor = 'job-run-observability:'

export type DrExporterPhase =
	| 'mailbox'
	| 'run-log'
	| 'storage'
	| 'r2'
	| 'artifacts'
	| 'finalize'
	| 'done'

type OwnerLaneProgress = {
	/** Observability only; resume is identity-driven from index chunks. */
	ownerIndex: number
	pageStartAfter: string | null
	partialOwnerId: string | null
	dumpChunkCount: number
	dumpChunkHead: string | null
	partialEntryCount: number
	partialBytes: number
	entryChunkCount: number
	entryChunkHead: string | null
	pendingEntries: Array<OwnerIndexEntry>
}

export type DrExporterProgress = {
	schemaVersion: typeof exporterProgressSchemaVersion
	day: string
	startedAt: string
	phase: DrExporterPhase
	/** Monotonic counter bumped on every progress persist. */
	revision: number
	leaseId: string | null
	leaseExpiresAt: string | null
	/**
	 * Wall time of the latest progress persist. Survives lease release so the
	 * 06:15 watchdog can tell a healthy drain (recent tick, lease cleared)
	 * from a cold stranded day.
	 */
	advancedAt?: string | null
	/** Set while conditionally replacing a schema-v1 completion marker. */
	legacySummaryEtag?: string | null
	mailbox: OwnerLaneProgress
	runLog: OwnerLaneProgress
	/**
	 * Count of storage identities completed or skipped. The inventory is
	 * re-listed every tick and can drift mid-run (jobs registering new
	 * buckets), so resume is identity-driven, not positional; this field is
	 * observability only.
	 */
	storageIndex: number
	/**
	 * Within the current storage dump: key cursor for exportStorage paging.
	 * Null means the next storage identity has not started yet.
	 */
	storagePageStartAfter: string | null
	/**
	 * Identity the partial page state below belongs to. Guards resumed
	 * partial pages against inventory drift between ticks; absent/mismatched
	 * identity resets the partial state.
	 */
	storagePartialIdentity?: string | null
	/** Number of page chunks written for the in-progress storage dump. */
	storageDumpChunkCount: number
	storageDumpChunkHead: string | null
	storagePartialEntryCount: number
	storagePartialBytes: number
	storageEntryChunkCount: number
	storageEntryChunkHead: string | null
	/** Bounded tail; full chunks live under exporter/chunks/storage-index/. */
	storagePendingEntries: Array<StorageIndexEntry>
	/** Index into backupR2BucketLabels. */
	r2LabelIndex: number
	r2ListCursor: string | null
	r2ChunkCount: number
	r2ChunkHead: string | null
	r2FinalPageReady: boolean
	r2Completed: Partial<Record<BackupR2BucketLabel, StagingFileSummary>>
	previousSealedDayResolved: boolean
	previousSealedDay: string | null
	artifactsIndex: number
	artifactEntryChunkCount: number
	artifactEntryChunkHead: string | null
	/** Bounded tail; full chunks live under exporter/chunks/artifacts-index/. */
	artifactPendingEntries: Array<ArtifactsIndexEntry>
	blobsWritten: number
	blobsReused: number
	warnings: Array<string>
}

type ProgressSession = {
	progress: DrExporterProgress
	/** ETag of the loaded progress object, or null when creating. */
	etag: string | null
}

export type DrExportTickMode = 'nightly' | 'catch-up' | 'operator'

export type DrExportTickResult = {
	day: string
	mode: DrExportTickMode
	phase: DrExporterPhase
	timeBudgetExhausted: boolean
	skipped: boolean
	reason?: string
	mailboxDumpsCompleted: number
	runLogDumpsCompleted: number
	storageDumpsCompleted: number
	r2ObjectsProcessed: number
	artifactsProcessed: number
	blobsWritten: number
	blobsReused: number
	warnings: number
	summaryWritten: boolean
}

function stagingProgressKey(day: string) {
	return `${stagingPrefix(day)}exporter/progress.json`
}

function formatUtcDay(date: Date) {
	return date.toISOString().slice(0, 10)
}

function utcDayMinus(day: string, daysBack: number) {
	const date = new Date(`${day}T00:00:00.000Z`)
	date.setUTCDate(date.getUTCDate() - daysBack)
	return date.toISOString().slice(0, 10)
}

function utcDayOffset(today: string, day: string) {
	const todayMs = Date.parse(`${today}T00:00:00.000Z`)
	const dayMs = Date.parse(`${day}T00:00:00.000Z`)
	return Math.round((todayMs - dayMs) / (24 * 60 * 60 * 1000))
}

/**
 * Oldest day in the lookback (furthest back first, then toward today) whose
 * staging has progress but no completion summary — a night the exporter
 * started and never finished because the window closed. Preferring the
 * oldest stranded day lets yesterday finish and seal before today's
 * nightly and catch-up ticks move on. Days with neither object
 * never started (for example before DR enablement) and are deliberately
 * not eligible: catch-up resumes staged work, it never starts a fresh
 * past-day export whose dumps would actually contain current data.
 */
async function findStrandedStagingDay(input: {
	s3: DrBackupS3Client
	today: string
	lookbackDays: number
}): Promise<string | null> {
	for (let offset = input.lookbackDays; offset >= 0; offset -= 1) {
		const candidate = utcDayMinus(input.today, offset)
		if ((await input.s3.head(stagingSummaryKey(candidate))).exists) continue
		if ((await input.s3.head(stagingProgressKey(candidate))).exists) {
			return candidate
		}
	}
	return null
}

function utf8ByteLength(value: string) {
	return new TextEncoder().encode(value).byteLength
}

function createInitialOwnerLaneProgress(): OwnerLaneProgress {
	return {
		ownerIndex: 0,
		pageStartAfter: null,
		partialOwnerId: null,
		dumpChunkCount: 0,
		dumpChunkHead: null,
		partialEntryCount: 0,
		partialBytes: 0,
		entryChunkCount: 0,
		entryChunkHead: null,
		pendingEntries: [],
	}
}

function createInitialProgress(day: string, now: Date): DrExporterProgress {
	return {
		schemaVersion: exporterProgressSchemaVersion,
		day,
		startedAt: now.toISOString(),
		phase: 'mailbox',
		revision: 0,
		leaseId: null,
		leaseExpiresAt: null,
		advancedAt: null,
		legacySummaryEtag: null,
		mailbox: createInitialOwnerLaneProgress(),
		runLog: createInitialOwnerLaneProgress(),
		storageIndex: 0,
		storagePageStartAfter: null,
		storagePartialIdentity: null,
		storageDumpChunkCount: 0,
		storageDumpChunkHead: null,
		storagePartialEntryCount: 0,
		storagePartialBytes: 0,
		storageEntryChunkCount: 0,
		storageEntryChunkHead: null,
		storagePendingEntries: [],
		r2LabelIndex: 0,
		r2ListCursor: null,
		r2ChunkCount: 0,
		r2ChunkHead: null,
		r2FinalPageReady: false,
		r2Completed: {},
		previousSealedDayResolved: false,
		previousSealedDay: null,
		artifactsIndex: 0,
		artifactEntryChunkCount: 0,
		artifactEntryChunkHead: null,
		artifactPendingEntries: [],
		blobsWritten: 0,
		blobsReused: 0,
		warnings: [],
	}
}

function parseProgress(value: unknown): DrExporterProgress | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const record = value as Record<string, unknown>
	if (record.schemaVersion !== exporterProgressSchemaVersion) return null
	if (typeof record.day !== 'string' || typeof record.startedAt !== 'string') {
		return null
	}
	const phase = record.phase
	if (
		phase !== 'mailbox' &&
		phase !== 'run-log' &&
		phase !== 'storage' &&
		phase !== 'r2' &&
		phase !== 'artifacts' &&
		phase !== 'finalize' &&
		phase !== 'done'
	) {
		return null
	}
	const revision =
		typeof record.revision === 'number' && Number.isSafeInteger(record.revision)
			? record.revision
			: 0
	if (
		!isOwnerLaneProgress(record.mailbox) ||
		!isOwnerLaneProgress(record.runLog)
	) {
		return null
	}
	return { ...(value as DrExporterProgress), revision }
}

function isNonNegativeInteger(candidate: unknown): candidate is number {
	return (
		typeof candidate === 'number' &&
		Number.isSafeInteger(candidate) &&
		candidate >= 0
	)
}

function isNullableString(candidate: unknown): candidate is string | null {
	return candidate === null || typeof candidate === 'string'
}

function isOwnerLaneProgress(value: unknown): value is OwnerLaneProgress {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const lane = value as Record<string, unknown>
	return (
		isNonNegativeInteger(lane.ownerIndex) &&
		isNullableString(lane.pageStartAfter) &&
		isNullableString(lane.partialOwnerId) &&
		isNonNegativeInteger(lane.dumpChunkCount) &&
		isNullableString(lane.dumpChunkHead) &&
		isNonNegativeInteger(lane.partialEntryCount) &&
		isNonNegativeInteger(lane.partialBytes) &&
		isNonNegativeInteger(lane.entryChunkCount) &&
		isNullableString(lane.entryChunkHead) &&
		Array.isArray(lane.pendingEntries)
	)
}

async function fileSummary(
	objectKey: string,
	body: string,
): Promise<StagingFileSummary> {
	const bytes = utf8ByteLength(body)
	return {
		objectKey,
		bytes,
		sha256: await sha256Hex(body),
	}
}

function ndjsonLine(value: unknown) {
	return `${JSON.stringify(value)}\n`
}

function ndjsonEntryCount(body: string) {
	return body.split('\n').filter(Boolean).length
}

async function flushStorageEntryChunk(input: {
	s3: DrBackupS3Client
	progress: DrExporterProgress
}) {
	if (input.progress.storagePendingEntries.length === 0) return
	const body = input.progress.storagePendingEntries.map(ndjsonLine).join('')
	input.progress.storageEntryChunkHead = await putLinkedChunk({
		s3: input.s3,
		keyPrefix: stagingChunkKey(input.progress.day, 'storage-index'),
		entriesBody: body,
		previousKey: input.progress.storageEntryChunkHead,
	})
	input.progress.storageEntryChunkCount += 1
	input.progress.storagePendingEntries = []
}

async function flushArtifactEntryChunk(input: {
	s3: DrBackupS3Client
	progress: DrExporterProgress
}) {
	if (input.progress.artifactPendingEntries.length === 0) return
	const body = input.progress.artifactPendingEntries.map(ndjsonLine).join('')
	input.progress.artifactEntryChunkHead = await putLinkedChunk({
		s3: input.s3,
		keyPrefix: stagingChunkKey(input.progress.day, 'artifacts-index'),
		entriesBody: body,
		previousKey: input.progress.artifactEntryChunkHead,
	})
	input.progress.artifactEntryChunkCount += 1
	input.progress.artifactPendingEntries = []
}

async function putBlobIfAbsent(input: {
	s3: DrBackupS3Client
	sha256: string
	bytes: Uint8Array
	progress: DrExporterProgress
}): Promise<'written' | 'reused'> {
	const key = backupBlobKey(input.sha256)
	const head = await input.s3.head(key)
	if (head.exists) {
		input.progress.blobsReused += 1
		return 'reused'
	}
	await input.s3.put(key, input.bytes, {
		contentType: 'application/octet-stream',
	})
	input.progress.blobsWritten += 1
	return 'written'
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

/**
 * Persist progress with a conditional PUT so overlapping cron ticks cannot
 * last-write-wins corrupt the day. R2's S3 API honors If-Match / If-None-Match
 * on PutObject (412 PreconditionFailed on conflict).
 */
async function persistProgress(s3: DrBackupS3Client, session: ProgressSession) {
	if (session.progress.leaseId) {
		session.progress.leaseExpiresAt = new Date(
			Date.now() + progressLeaseDurationMs,
		).toISOString()
	}
	session.progress.advancedAt = new Date().toISOString()
	session.progress.revision += 1
	const body = JSON.stringify(session.progress)
	const key = stagingProgressKey(session.progress.day)
	const result = await s3.put(key, body, {
		contentType: 'application/json',
		...(session.etag ? { ifMatch: session.etag } : { ifNoneMatch: '*' }),
	})
	session.etag = result.etag ?? session.etag
}

async function loadOrCreateProgress(input: {
	s3: DrBackupS3Client
	day: string
	now: Date
}): Promise<ProgressSession> {
	const loaded = await input.s3.getText(stagingProgressKey(input.day))
	if (loaded) {
		try {
			const parsed = parseProgress(JSON.parse(loaded.text) as unknown)
			if (parsed && parsed.day === input.day) {
				return { progress: parsed, etag: loaded.etag }
			}
		} catch {
			// Fall through and replace corrupt progress under If-Match.
		}
		return {
			progress: createInitialProgress(input.day, input.now),
			etag: loaded.etag,
		}
	}
	return {
		progress: createInitialProgress(input.day, input.now),
		etag: null,
	}
}

const oversizedMailboxDumpWarningPrefix = 'mailbox dump too large: '
const oversizedRunLogDumpWarningPrefix = 'run-log dump too large: '

function resetPartialOwnerState(lane: OwnerLaneProgress) {
	lane.pageStartAfter = null
	lane.partialOwnerId = null
	lane.dumpChunkCount = 0
	lane.dumpChunkHead = null
	lane.partialEntryCount = 0
	lane.partialBytes = 0
}

async function flushOwnerIndexChunk(input: {
	s3: DrBackupS3Client
	day: string
	kind: 'mailbox-index' | 'run-log-index'
	lane: OwnerLaneProgress
}) {
	if (input.lane.pendingEntries.length === 0) return
	const body = input.lane.pendingEntries.map(ndjsonLine).join('')
	input.lane.entryChunkHead = await putLinkedChunk({
		s3: input.s3,
		keyPrefix: stagingChunkKey(input.day, input.kind),
		entriesBody: body,
		previousKey: input.lane.entryChunkHead,
	})
	input.lane.entryChunkCount += 1
	input.lane.pendingEntries = []
}

async function collectHandledOwnerIds(input: {
	s3: DrBackupS3Client
	progress: DrExporterProgress
	lane: OwnerLaneProgress
	oversizedWarningPrefix: string
}) {
	const chunkEntries = await readLinkedChunkEntries<OwnerIndexEntry>({
		s3: input.s3,
		headKey: input.lane.entryChunkHead,
		chunkCount: input.lane.entryChunkCount,
	})
	const handled = new Set([
		...chunkEntries.map((entry) => entry.ownerId),
		...input.lane.pendingEntries.map((entry) => entry.ownerId),
	])
	for (const warning of input.progress.warnings) {
		if (warning.startsWith(input.oversizedWarningPrefix)) {
			handled.add(warning.slice(input.oversizedWarningPrefix.length))
		}
	}
	return handled
}

type OwnerExportPage = {
	entries: Array<unknown>
	nextStartAfter: string | null
	truncated: boolean
}

async function exportOwnerPhase(input: {
	s3: DrBackupS3Client
	session: ProgressSession
	owners: Array<OwnerId>
	startedAtMs: number
	timeBudgetMs: number
	lane: OwnerLaneProgress
	laneName: 'mailbox' | 'run-log'
	indexKind: 'mailbox-index' | 'run-log-index'
	initialCursor: string | null
	oversizedWarningPrefix: string
	dumpKey: (day: string, ownerId: OwnerId) => string
	fetchPage: (
		ownerId: OwnerId,
		startAfter: string | null,
	) => Promise<OwnerExportPage>
	onDumpCompleted: () => void
	nextPhase: DrExporterPhase
}): Promise<boolean> {
	const { progress } = input.session
	const handledOwnerIds = await collectHandledOwnerIds({
		s3: input.s3,
		progress,
		lane: input.lane,
		oversizedWarningPrefix: input.oversizedWarningPrefix,
	})
	const budgetExhausted = () =>
		Date.now() - input.startedAtMs >= input.timeBudgetMs
	// First pages already fetched for truncated owners. Progress only tracks
	// one partial dump, so the rest stay in memory until this tick commits
	// them. A crash refetches them; a healthy tick does not.
	const heldFirstPages: Array<{ ownerId: OwnerId; page: OwnerExportPage }> = []

	async function consumeOwnerPage(
		ownerId: OwnerId,
		page: OwnerExportPage,
	): Promise<'complete' | 'truncated'> {
		if (input.lane.partialOwnerId !== ownerId) {
			resetPartialOwnerState(input.lane)
			input.lane.partialOwnerId = ownerId
		}
		const pageBody = page.entries.map(ndjsonLine).join('')
		const pageBytes = utf8ByteLength(pageBody)
		input.lane.partialEntryCount += page.entries.length
		if (
			input.lane.partialBytes + pageBytes >
			drExportMaxStorageDumpBufferBytes
		) {
			progress.warnings.push(`${input.oversizedWarningPrefix}${ownerId}`)
			input.lane.ownerIndex += 1
			resetPartialOwnerState(input.lane)
			handledOwnerIds.add(ownerId)
			return 'complete'
		}
		if (pageBody.length > 0) {
			input.lane.dumpChunkHead = await putLinkedChunk({
				s3: input.s3,
				keyPrefix: stagingOwnerDumpChunkKey(
					progress.day,
					input.laneName,
					ownerId,
				),
				entriesBody: pageBody,
				previousKey: input.lane.dumpChunkHead,
			})
			input.lane.dumpChunkCount += 1
			input.lane.partialBytes += pageBytes
		}
		if (page.truncated && page.nextStartAfter) {
			input.lane.pageStartAfter = page.nextStartAfter
			return 'truncated'
		}
		const objectKey = input.dumpKey(progress.day, ownerId)
		const body = await readLinkedChunkBody({
			s3: input.s3,
			headKey: input.lane.dumpChunkHead,
			chunkCount: input.lane.dumpChunkCount,
		})
		const storedBody = await putImmutableOutput({
			s3: input.s3,
			key: objectKey,
			body,
			contentType: 'application/x-ndjson',
		})
		const summary = await fileSummary(objectKey, storedBody)
		input.lane.pendingEntries.push({
			ownerId,
			objectKey,
			entryCount: ndjsonEntryCount(storedBody),
			bytes: summary.bytes,
			sha256: summary.sha256,
		})
		if (input.lane.pendingEntries.length >= indexChunkEntryLimit) {
			await flushOwnerIndexChunk({
				s3: input.s3,
				day: progress.day,
				kind: input.indexKind,
				lane: input.lane,
			})
		}
		handledOwnerIds.add(ownerId)
		input.lane.ownerIndex += 1
		resetPartialOwnerState(input.lane)
		input.onDumpCompleted()
		return 'complete'
	}

	for (;;) {
		if (budgetExhausted()) return true
		const partialOwnerId = input.lane.partialOwnerId
		if (
			partialOwnerId &&
			!handledOwnerIds.has(partialOwnerId as OwnerId) &&
			input.owners.includes(partialOwnerId as OwnerId)
		) {
			// Finish the in-progress dump before any newly inserted owner.
			// Inventory drift used to reset this cursor and rewrite the dump.
			const page = await input.fetchPage(
				partialOwnerId as OwnerId,
				input.lane.pageStartAfter ?? input.initialCursor,
			)
			await consumeOwnerPage(partialOwnerId as OwnerId, page)
			await persistProgress(input.s3, input.session)
			continue
		}
		if (partialOwnerId && !input.owners.includes(partialOwnerId as OwnerId)) {
			resetPartialOwnerState(input.lane)
		}

		const held = heldFirstPages.shift()
		if (held) {
			await consumeOwnerPage(held.ownerId, held.page)
			await persistProgress(input.s3, input.session)
			continue
		}

		const heldOwnerIds = new Set(heldFirstPages.map((page) => page.ownerId))
		const batch: Array<OwnerId> = []
		for (const candidate of input.owners) {
			if (batch.length >= ownerExportConcurrency) break
			if (handledOwnerIds.has(candidate) || heldOwnerIds.has(candidate)) {
				continue
			}
			batch.push(candidate)
		}
		if (batch.length === 0) break
		const settled = await Promise.allSettled(
			batch.map(async (ownerId) => ({
				ownerId,
				page: await input.fetchPage(ownerId, input.initialCursor),
			})),
		)
		const pages: Array<{ ownerId: OwnerId; page: OwnerExportPage }> = []
		let fetchFailure: unknown = null
		for (const result of settled) {
			if (result.status === 'fulfilled') {
				pages.push(result.value)
				continue
			}
			if (fetchFailure === null) fetchFailure = result.reason
		}
		const truncated: Array<{ ownerId: OwnerId; page: OwnerExportPage }> = []
		let consumed = false
		for (const item of pages) {
			if (item.page.truncated && item.page.nextStartAfter) {
				truncated.push(item)
				continue
			}
			await consumeOwnerPage(item.ownerId, item.page)
			consumed = true
		}
		const continued = truncated.shift()
		if (continued) {
			await consumeOwnerPage(continued.ownerId, continued.page)
			consumed = true
		}
		heldFirstPages.push(...truncated)
		if (consumed) await persistProgress(input.s3, input.session)
		if (fetchFailure) throw fetchFailure
	}
	await flushOwnerIndexChunk({
		s3: input.s3,
		day: progress.day,
		kind: input.indexKind,
		lane: input.lane,
	})
	progress.phase = input.nextPhase
	await persistProgress(input.s3, input.session)
	return false
}

function runLogDumpEntries(page: {
	jobRunObservability: Array<unknown>
	packageRunSuccesses: Array<unknown>
	activationMilestones: Array<unknown>
}): Array<RunLogDumpEntry> {
	return [
		...page.jobRunObservability.map((row) => ({
			kind: 'jobRunObservability' as const,
			row,
		})),
		...page.packageRunSuccesses.map((row) => ({
			kind: 'packageRunSuccess' as const,
			row,
		})),
		...page.activationMilestones.map((row) => ({
			kind: 'activationMilestone' as const,
			row,
		})),
	]
}

const oversizedStorageDumpWarningPrefix = 'storage dump too large: '

function resetPartialStorageState(progress: DrExporterProgress) {
	progress.storagePageStartAfter = null
	progress.storagePartialIdentity = null
	progress.storageDumpChunkCount = 0
	progress.storageDumpChunkHead = null
	progress.storagePartialEntryCount = 0
	progress.storagePartialBytes = 0
}

function skipOversizedStorageDump(
	progress: DrExporterProgress,
	identity: string,
) {
	progress.warnings.push(`${oversizedStorageDumpWarningPrefix}${identity}`)
	progress.storageIndex += 1
	resetPartialStorageState(progress)
}

async function collectHandledStorageIdentities(input: {
	s3: DrBackupS3Client
	progress: DrExporterProgress
}) {
	const chunkEntries = await readLinkedChunkEntries<StorageIndexEntry>({
		s3: input.s3,
		headKey: input.progress.storageEntryChunkHead,
		chunkCount: input.progress.storageEntryChunkCount,
	})
	const handled = new Set([
		...chunkEntries.map((entry) => entry.storageId),
		...input.progress.storagePendingEntries.map((entry) => entry.storageId),
	])
	for (const warning of input.progress.warnings) {
		if (warning.startsWith(oversizedStorageDumpWarningPrefix)) {
			handled.add(warning.slice(oversizedStorageDumpWarningPrefix.length))
		}
	}
	return handled
}

async function exportMailboxPhase(input: {
	env: Env
	s3: DrBackupS3Client
	session: ProgressSession
	owners: Array<OwnerId>
	startedAtMs: number
	timeBudgetMs: number
	counts: { mailboxDumpsCompleted: number }
}) {
	return exportOwnerPhase({
		s3: input.s3,
		session: input.session,
		owners: input.owners,
		startedAtMs: input.startedAtMs,
		timeBudgetMs: input.timeBudgetMs,
		lane: input.session.progress.mailbox,
		laneName: 'mailbox',
		indexKind: 'mailbox-index',
		initialCursor: null,
		oversizedWarningPrefix: oversizedMailboxDumpWarningPrefix,
		dumpKey: stagingMailboxDumpKey,
		async fetchPage(ownerId, startAfter) {
			const page = await mailboxRpc({
				env: input.env,
				userId: ownerId,
			}).exportMailbox({
				pageSize: ownerExportPageSize,
				startAfter,
			})
			return { ...page, entries: page.rows }
		},
		onDumpCompleted: () => {
			input.counts.mailboxDumpsCompleted += 1
		},
		nextPhase: 'run-log',
	})
}

async function exportRunLogPhase(input: {
	env: Env
	s3: DrBackupS3Client
	session: ProgressSession
	owners: Array<OwnerId>
	startedAtMs: number
	timeBudgetMs: number
	counts: { runLogDumpsCompleted: number }
}) {
	return exportOwnerPhase({
		s3: input.s3,
		session: input.session,
		owners: input.owners,
		startedAtMs: input.startedAtMs,
		timeBudgetMs: input.timeBudgetMs,
		lane: input.session.progress.runLog,
		laneName: 'run-log',
		indexKind: 'run-log-index',
		initialCursor: runLogInitialCursor,
		oversizedWarningPrefix: oversizedRunLogDumpWarningPrefix,
		dumpKey: stagingRunLogDumpKey,
		async fetchPage(ownerId, startAfter) {
			const page = await runLogRpc({
				env: input.env,
				userId: ownerId,
			}).exportRuns({
				pageSize: ownerExportPageSize,
				startAfter,
			})
			return {
				entries: runLogDumpEntries(page),
				nextStartAfter: page.nextStartAfter,
				truncated: page.truncated,
			}
		},
		onDumpCompleted: () => {
			input.counts.runLogDumpsCompleted += 1
		},
		nextPhase: 'storage',
	})
}

async function exportStoragePhase(input: {
	env: Env
	s3: DrBackupS3Client
	session: ProgressSession
	inventory: Array<StorageInventoryEntry>
	startedAtMs: number
	timeBudgetMs: number
	counts: { storageDumpsCompleted: number }
}): Promise<boolean> {
	const { session, inventory, s3, env } = input
	const { progress } = session
	// Identity-driven resume: the inventory is re-listed every tick and can
	// drift mid-run (jobs registering new buckets during the export window),
	// which shifts positions in the sorted list. A positional cursor then
	// dumps the same identity twice — producing duplicate storage-index
	// entries that later wedge sealing — or silently skips identities.
	const handledIdentities = await collectHandledStorageIdentities({
		s3,
		progress,
	})
	let inventoryIndex = 0
	for (;;) {
		if (Date.now() - input.startedAtMs >= input.timeBudgetMs) return true
		let item: StorageInventoryEntry | undefined
		while (inventoryIndex < inventory.length) {
			const candidate = inventory[inventoryIndex]!
			inventoryIndex += 1
			if (!handledIdentities.has(candidate.identity)) {
				item = candidate
				break
			}
		}
		if (!item) break
		if (progress.storagePartialIdentity !== item.identity) {
			// The persisted partial page state belongs to a different (drifted)
			// identity; restart this identity's dump from its first page.
			resetPartialStorageState(progress)
			progress.storagePartialIdentity = item.identity
		}
		const page = await storageRunnerRpc({
			env,
			userId: item.userId,
			storageId: item.storageId,
		}).exportStorage({
			pageSize: storageExportPageSize,
			startAfter: progress.storagePageStartAfter,
		})
		let pageBody = ''
		for (const entry of page.entries) {
			const dumpEntry = {
				key: entry.key,
				valueJson: JSON.stringify(entry.value),
			} satisfies StorageDumpEntry
			pageBody += ndjsonLine(dumpEntry)
			progress.storagePartialEntryCount += 1
		}
		const pageBytes = utf8ByteLength(pageBody)
		if (
			progress.storagePartialBytes + pageBytes >
			drExportMaxStorageDumpBufferBytes
		) {
			skipOversizedStorageDump(progress, item.identity)
			handledIdentities.add(item.identity)
			await persistProgress(s3, session)
			continue
		}
		if (pageBody.length > 0) {
			progress.storageDumpChunkHead = await putLinkedChunk({
				s3,
				keyPrefix: stagingStorageDumpChunkKey(progress.day, item.identity),
				entriesBody: pageBody,
				previousKey: progress.storageDumpChunkHead,
			})
			progress.storageDumpChunkCount += 1
			progress.storagePartialBytes += pageBytes
		}
		if (page.truncated && page.nextStartAfter) {
			progress.storagePageStartAfter = page.nextStartAfter
			await persistProgress(s3, session)
			continue
		}
		const objectKey = stagingStorageDumpKey(progress.day, item.identity)
		const body = await readLinkedChunkBody({
			s3,
			headKey: progress.storageDumpChunkHead,
			chunkCount: progress.storageDumpChunkCount,
		})
		const storedBody = await putImmutableOutput({
			s3,
			key: objectKey,
			body,
			contentType: 'application/x-ndjson',
		})
		const summary = await fileSummary(objectKey, storedBody)
		progress.storagePendingEntries.push({
			storageId: item.identity,
			objectKey,
			entryCount: ndjsonEntryCount(storedBody),
			bytes: summary.bytes,
			sha256: summary.sha256,
		})
		if (progress.storagePendingEntries.length >= indexChunkEntryLimit) {
			await flushStorageEntryChunk({ s3, progress })
		}
		handledIdentities.add(item.identity)
		progress.storageIndex += 1
		resetPartialStorageState(progress)
		input.counts.storageDumpsCompleted += 1
		await persistProgress(s3, session)
	}
	await flushStorageEntryChunk({ s3, progress })
	progress.phase = 'r2'
	await persistProgress(s3, session)
	return false
}

async function exportR2Phase(input: {
	env: Env
	s3: DrBackupS3Client
	session: ProgressSession
	startedAtMs: number
	timeBudgetMs: number
	counts: { r2ObjectsProcessed: number }
}): Promise<boolean> {
	const { session, s3, env } = input
	const { progress } = session
	if (!progress.previousSealedDayResolved) {
		progress.previousSealedDay = await resolvePreviousSealedDay({
			s3,
			day: progress.day,
			lookbackDays: previousSealedDayLookbackDays,
		})
		progress.previousSealedDayResolved = true
		await persistProgress(s3, session)
	}
	while (progress.r2LabelIndex < backupR2BucketLabels.length) {
		const label = backupR2BucketLabels[progress.r2LabelIndex]!
		const bucket = r2BindingForLabel(env, label)
		if (!progress.r2FinalPageReady) {
			const previousEntries = await loadPreviousR2Index({
				s3,
				day: progress.previousSealedDay,
				label,
			})
			for (;;) {
				if (Date.now() - input.startedAtMs >= input.timeBudgetMs) return true
				const listed = await bucket.list({
					cursor: progress.r2ListCursor ?? undefined,
					limit: 100,
				})
				// Finish the whole list page before checking the tick budget.
				// Persisting mid-page without advancing r2ListCursor would replay
				// its index lines. List pages are bounded (≤100).
				let pageIndexBody = ''
				for (const object of listed.objects) {
					if (object.size > drExportMaxObjectBytes) {
						progress.warnings.push(
							`Skipped ${label} object ${object.key}: size ${object.size} exceeds ${drExportMaxObjectBytes} bytes`,
						)
						input.counts.r2ObjectsProcessed += 1
						continue
					}
					const uploaded = object.uploaded.toISOString()
					const previous = previousEntries.get(object.key)
					if (
						previous &&
						previous.size === object.size &&
						previous.etag === object.etag &&
						previous.uploaded === uploaded &&
						(await s3.head(backupBlobKey(previous.sha256))).exists
					) {
						const indexEntry = {
							key: object.key,
							size: object.size,
							sha256: previous.sha256,
							etag: object.etag,
							uploaded,
						} satisfies IncrementalR2IndexEntry
						pageIndexBody += ndjsonLine(indexEntry)
						progress.blobsReused += 1
						input.counts.r2ObjectsProcessed += 1
						continue
					}
					const body = await bucket.get(object.key)
					if (!body) {
						progress.warnings.push(
							`Missing ${label} object during export: ${object.key}`,
						)
						input.counts.r2ObjectsProcessed += 1
						continue
					}
					const bytes = new Uint8Array(await body.arrayBuffer())
					const digest = await sha256Hex(bytes)
					await putBlobIfAbsent({ s3, sha256: digest, bytes, progress })
					const indexEntry = {
						key: object.key,
						size: bytes.byteLength,
						sha256: digest,
						etag: object.etag,
						uploaded,
					} satisfies IncrementalR2IndexEntry
					pageIndexBody += ndjsonLine(indexEntry)
					input.counts.r2ObjectsProcessed += 1
				}
				if (pageIndexBody.length > 0) {
					progress.r2ChunkHead = await putLinkedChunk({
						s3,
						keyPrefix: stagingR2IndexChunkKey(progress.day, label),
						entriesBody: pageIndexBody,
						previousKey: progress.r2ChunkHead,
					})
					progress.r2ChunkCount += 1
				}
				if (listed.truncated) {
					progress.r2ListCursor = listed.cursor
					await persistProgress(s3, session)
					continue
				}
				progress.r2FinalPageReady = true
				await persistProgress(s3, session)
				break
			}
		}
		const objectKey = stagingR2IndexKey(progress.day, label)
		const body = await readLinkedChunkBody({
			s3,
			headKey: progress.r2ChunkHead,
			chunkCount: progress.r2ChunkCount,
		})
		const storedBody = await putImmutableOutput({
			s3,
			key: objectKey,
			body,
			contentType: 'application/x-ndjson',
		})
		progress.r2Completed[label] = await fileSummary(objectKey, storedBody)
		progress.r2LabelIndex += 1
		progress.r2ListCursor = null
		progress.r2ChunkCount = 0
		progress.r2ChunkHead = null
		progress.r2FinalPageReady = false
		await persistProgress(s3, session)
	}
	progress.phase = 'artifacts'
	await persistProgress(s3, session)
	return false
}

async function exportArtifactsPhase(input: {
	env: Env
	s3: DrBackupS3Client
	session: ProgressSession
	inventory: Array<ArtifactInventoryEntry>
	startedAtMs: number
	timeBudgetMs: number
	counts: { artifactsProcessed: number }
}): Promise<boolean> {
	const { session, s3, env, inventory } = input
	const { progress } = session
	while (progress.artifactsIndex < inventory.length) {
		if (Date.now() - input.startedAtMs >= input.timeBudgetMs) return true
		const item = inventory[progress.artifactsIndex]!
		const kvKey = buildPublishedSourceSnapshotKvKey({
			sourceId: item.sourceId,
			publishedCommit: item.publishedCommit,
		})
		const snapshotText = await env.BUNDLE_ARTIFACTS_KV.get(kvKey)
		if (snapshotText === null) {
			progress.warnings.push(
				`Missing source snapshot KV key ${kvKey} for source ${item.sourceId}`,
			)
			progress.artifactsIndex += 1
			input.counts.artifactsProcessed += 1
			await persistProgress(s3, session)
			continue
		}
		const bytes = new TextEncoder().encode(snapshotText)
		const digest = await sha256Hex(bytes)
		await putBlobIfAbsent({ s3, sha256: digest, bytes, progress })
		progress.artifactPendingEntries.push({
			sourceId: item.sourceId,
			entityKind: item.entityKind,
			entityId: item.entityId,
			userId: item.userId,
			publishedCommit: item.publishedCommit,
			snapshotSha256: digest,
		})
		if (progress.artifactPendingEntries.length >= indexChunkEntryLimit) {
			await flushArtifactEntryChunk({ s3, progress })
		}
		progress.artifactsIndex += 1
		input.counts.artifactsProcessed += 1
		await persistProgress(s3, session)
	}
	await flushArtifactEntryChunk({ s3, progress })
	progress.phase = 'finalize'
	await persistProgress(s3, session)
	return false
}

async function putCompletionSummary(input: {
	s3: DrBackupS3Client
	key: string
	body: string
	legacyEtag: string | null | undefined
}) {
	if (input.legacyEtag) {
		await input.s3.put(input.key, input.body, {
			contentType: 'application/json',
			ifMatch: input.legacyEtag,
		})
		return
	}
	await putImmutableOutput({
		s3: input.s3,
		key: input.key,
		body: input.body,
		contentType: 'application/json',
	})
}

async function finalizeExport(input: {
	env: Env
	s3: DrBackupS3Client
	session: ProgressSession
	now: Date
}): Promise<StagingSummary> {
	const { session, s3, env, now } = input
	const { progress } = session
	const mailboxEntries = await readLinkedChunkEntries<OwnerIndexEntry>({
		s3,
		headKey: progress.mailbox.entryChunkHead,
		chunkCount: progress.mailbox.entryChunkCount,
	})
	const mailboxIndexKey = stagingMailboxIndexKey(progress.day)
	const storedMailboxIndexBody = await putImmutableOutput({
		s3,
		key: mailboxIndexKey,
		body: JSON.stringify({
			schemaVersion: backupStagingSchemaVersion,
			day: progress.day,
			entries: mailboxEntries,
		} satisfies MailboxIndex),
		contentType: 'application/json',
	})
	const mailboxIndex = await fileSummary(
		mailboxIndexKey,
		storedMailboxIndexBody,
	)

	const runLogEntries = await readLinkedChunkEntries<OwnerIndexEntry>({
		s3,
		headKey: progress.runLog.entryChunkHead,
		chunkCount: progress.runLog.entryChunkCount,
	})
	const runLogIndexKey = stagingRunLogIndexKey(progress.day)
	const storedRunLogIndexBody = await putImmutableOutput({
		s3,
		key: runLogIndexKey,
		body: JSON.stringify({
			schemaVersion: backupStagingSchemaVersion,
			day: progress.day,
			entries: runLogEntries,
		} satisfies RunLogIndex),
		contentType: 'application/json',
	})
	const runLogIndex = await fileSummary(runLogIndexKey, storedRunLogIndexBody)

	const storageEntries = await readLinkedChunkEntries<StorageIndexEntry>({
		s3,
		headKey: progress.storageEntryChunkHead,
		chunkCount: progress.storageEntryChunkCount,
	})
	const storageIndexBody = JSON.stringify({
		schemaVersion: backupStagingSchemaVersion,
		day: progress.day,
		entries: storageEntries,
	} satisfies StorageIndex)
	const storageIndexKey = stagingStorageIndexKey(progress.day)
	const storedStorageIndexBody = await putImmutableOutput({
		s3,
		key: storageIndexKey,
		body: storageIndexBody,
		contentType: 'application/json',
	})
	const storageIndex = await fileSummary(
		storageIndexKey,
		storedStorageIndexBody,
	)

	const artifactEntries = await readLinkedChunkEntries<ArtifactsIndexEntry>({
		s3,
		headKey: progress.artifactEntryChunkHead,
		chunkCount: progress.artifactEntryChunkCount,
	})
	const artifactsIndexBody = JSON.stringify({
		schemaVersion: backupStagingSchemaVersion,
		day: progress.day,
		entries: artifactEntries,
	} satisfies ArtifactsIndex)
	const artifactsIndexKey = stagingArtifactsIndexKey(progress.day)
	const storedArtifactsIndexBody = await putImmutableOutput({
		s3,
		key: artifactsIndexKey,
		body: artifactsIndexBody,
		contentType: 'application/json',
	})
	const artifactsIndex = await fileSummary(
		artifactsIndexKey,
		storedArtifactsIndexBody,
	)

	const summary: StagingSummary = {
		schemaVersion: backupStagingSchemaVersion,
		day: progress.day,
		startedAt: progress.startedAt,
		completedAt: now.toISOString(),
		buildCommit: env.APP_COMMIT_SHA?.trim() || 'unknown',
		mailboxIndex,
		runLogIndex,
		storageIndex,
		r2Indexes: progress.r2Completed,
		artifactsIndex,
		blobsWritten: progress.blobsWritten,
		blobsReused: progress.blobsReused,
		warnings: progress.warnings,
	}
	await putCompletionSummary({
		s3,
		key: stagingSummaryKey(progress.day),
		body: JSON.stringify(summary),
		legacyEtag: progress.legacySummaryEtag,
	})
	progress.phase = 'done'
	await persistProgress(s3, session)
	return summary
}

export async function runDrExportTick(input: {
	env: Env
	now?: Date
	timeBudgetMs?: number
	s3?: DrBackupS3Client
	/**
	 * Operator override: resume and finish one specific UTC day's staging
	 * regardless of the nightly window and catch-up cadence. Resume-only —
	 * the tick skips (`no-staged-progress`) when the day never staged any
	 * progress, so it cannot start a fresh export of a past day.
	 */
	day?: string
}): Promise<DrExportTickResult> {
	const now = input.now ?? new Date()
	const today = formatUtcDay(now)
	if (input.day !== undefined) {
		assertBackupDay(input.day)
		if (input.day > today) {
			throw new Error(`DR export day ${input.day} is in the future`)
		}
	}
	const mode: DrExportTickMode =
		input.day !== undefined
			? 'operator'
			: shouldRunDrExportCron(now)
				? 'nightly'
				: 'catch-up'
	let day = input.day ?? today
	const empty = (reason: string): DrExportTickResult => ({
		day,
		mode,
		phase: 'done',
		timeBudgetExhausted: false,
		skipped: true,
		reason,
		mailboxDumpsCompleted: 0,
		runLogDumpsCompleted: 0,
		storageDumpsCompleted: 0,
		r2ObjectsProcessed: 0,
		artifactsProcessed: 0,
		blobsWritten: 0,
		blobsReused: 0,
		warnings: 0,
		summaryWritten: false,
	})

	if (mode === 'catch-up' && !shouldRunDrExportCatchUpCron(now)) {
		return empty('outside-nightly-window')
	}
	if (!isDrExportConfigured(input.env)) {
		return empty('not-configured')
	}
	const config = readDrBackupS3Config(input.env)
	if (!config) return empty('not-configured')
	const s3 = input.s3 ?? createDrBackupS3Client(config)

	if (mode === 'nightly' || mode === 'catch-up') {
		const stranded = await findStrandedStagingDay({
			s3,
			today,
			lookbackDays: drExportCatchUpLookbackDays,
		})
		if (stranded) {
			if (mode === 'nightly' && stranded !== today) {
				// Nightly defers today while draining an older stranded day; seed
				// today's progress so catch-up can resume it later (resume-only).
				const todaySummaryHead = await s3.head(stagingSummaryKey(today))
				if (!todaySummaryHead.exists) {
					const todayProgressHead = await s3.head(stagingProgressKey(today))
					if (!todayProgressHead.exists) {
						const initial = createInitialProgress(today, now)
						try {
							await s3.put(stagingProgressKey(today), JSON.stringify(initial), {
								contentType: 'application/json',
								ifNoneMatch: '*',
							})
						} catch (error) {
							if (!(error instanceof DrBackupPreconditionFailedError)) {
								throw error
							}
						}
					}
				}
			}
			day = stranded
		} else if (mode === 'catch-up') {
			return empty('no-stranded-day')
		}
	}
	if (mode === 'operator') {
		const progressHead = await s3.head(stagingProgressKey(day))
		if (!progressHead.exists) {
			const summaryHead = await s3.head(stagingSummaryKey(day))
			if (summaryHead.exists) return empty('already-complete')
			return empty('no-staged-progress')
		}
	}

	const existingSummary = await s3.getText(stagingSummaryKey(day))
	let legacySummaryEtag: string | null = null
	if (existingSummary) {
		let parsed: unknown
		try {
			parsed = JSON.parse(existingSummary.text) as unknown
			const summary = parseStagingSummary(parsed)
			if (summary.day === day) return empty('already-complete')
			return empty('already-complete')
		} catch {
			try {
				const summary = parseLegacyStagingSummary(parsed)
				if (summary.day !== day || !existingSummary.etag) {
					return empty('already-complete')
				}
				legacySummaryEtag = existingSummary.etag
			} catch {
				return empty('already-complete')
			}
		}
	}

	const timeBudgetMs = input.timeBudgetMs ?? drExportRunTimeBudgetMs
	const startedAtMs = Date.now()
	const session = await loadOrCreateProgress({ s3, day, now })
	const { progress } = session
	progress.legacySummaryEtag = legacySummaryEtag
	const counts = {
		mailboxDumpsCompleted: 0,
		runLogDumpsCompleted: 0,
		storageDumpsCompleted: 0,
		r2ObjectsProcessed: 0,
		artifactsProcessed: 0,
	}
	let timeBudgetExhausted = false

	try {
		const leaseExpiresAtMs = Date.parse(progress.leaseExpiresAt ?? '')
		if (
			progress.leaseId &&
			Number.isFinite(leaseExpiresAtMs) &&
			leaseExpiresAtMs > Date.now()
		) {
			return empty('progress-lease-active')
		}
		progress.leaseId = crypto.randomUUID()
		await persistProgress(s3, session)

		const owners =
			progress.phase === 'mailbox' || progress.phase === 'run-log'
				? await listPlatformOwnerInventory(input.env.APP_DB)
				: []
		if (progress.phase === 'mailbox') {
			timeBudgetExhausted = await exportMailboxPhase({
				env: input.env,
				s3,
				session,
				owners,
				startedAtMs,
				timeBudgetMs,
				counts,
			})
		}
		if (!timeBudgetExhausted && progress.phase === 'run-log') {
			timeBudgetExhausted = await exportRunLogPhase({
				env: input.env,
				s3,
				session,
				owners,
				startedAtMs,
				timeBudgetMs,
				counts,
			})
		}
		if (!timeBudgetExhausted && progress.phase === 'storage') {
			const inventory = await listPlatformStorageInventory({
				db: input.env.APP_DB,
				jobs: jobsData(input.env),
			})
			timeBudgetExhausted = await exportStoragePhase({
				env: input.env,
				s3,
				session,
				inventory,
				startedAtMs,
				timeBudgetMs,
				counts,
			})
		}
		if (!timeBudgetExhausted && progress.phase === 'r2') {
			timeBudgetExhausted = await exportR2Phase({
				env: input.env,
				s3,
				session,
				startedAtMs,
				timeBudgetMs,
				counts,
			})
		}
		if (!timeBudgetExhausted && progress.phase === 'artifacts') {
			const inventory = await listPlatformArtifactInventory(input.env.APP_DB)
			timeBudgetExhausted = await exportArtifactsPhase({
				env: input.env,
				s3,
				session,
				inventory,
				startedAtMs,
				timeBudgetMs,
				counts,
			})
		}
		let summaryWritten = false
		if (!timeBudgetExhausted && progress.phase === 'finalize') {
			await finalizeExport({ env: input.env, s3, session, now })
			summaryWritten = true
		}
		progress.leaseId = null
		progress.leaseExpiresAt = null
		await persistProgress(s3, session)

		const result: DrExportTickResult = {
			day,
			mode,
			phase: progress.phase,
			timeBudgetExhausted,
			skipped: false,
			mailboxDumpsCompleted: counts.mailboxDumpsCompleted,
			runLogDumpsCompleted: counts.runLogDumpsCompleted,
			storageDumpsCompleted: counts.storageDumpsCompleted,
			r2ObjectsProcessed: counts.r2ObjectsProcessed,
			artifactsProcessed: counts.artifactsProcessed,
			blobsWritten: progress.blobsWritten,
			blobsReused: progress.blobsReused,
			warnings: progress.warnings.length,
			summaryWritten,
		}
		console.info('dr_export_tick', JSON.stringify(result))
		return result
	} catch (error) {
		if (error instanceof DrBackupPreconditionFailedError) {
			// Another scheduled invocation owns this day's progress.json.
			console.info(
				'dr_export_tick',
				JSON.stringify({
					day,
					mode,
					skipped: true,
					reason: 'progress-precondition-failed',
				}),
			)
			return empty('progress-precondition-failed')
		}
		throw error
	}
}

export type DrExportWatchdogResult = {
	day: string
	skipped: boolean
	reason?: string
	summaryPresent: boolean
}

/**
 * Post-window health check for the nightly staging exporter. Throws when the
 * day's `exporter/summary.json` is missing and no older stranded day explains
 * the deferral — an incomplete night is otherwise silent (the exporter stops
 * getting ticks when the window closes). When earlier stranded days exist and
 * tonight has no summary yet (nightly deferred to drain backlog), returns
 * without paging only while the oldest stranded day is still yesterday.
 * Two or more UTC days of backlog pages even if the cursor is moving, because
 * that pace loses to the calendar. Throws when tonight has a summary but
 * earlier days are still stranded: catch-up prefers the oldest stranded day,
 * so that combination means catch-up is stuck and should stay loud once per day.
 */
export async function runDrExportWatchdogTick(input: {
	env: Env
	now?: Date
	s3?: DrBackupS3Client
}): Promise<DrExportWatchdogResult> {
	const now = input.now ?? new Date()
	const day = formatUtcDay(now)
	if (!isDrExportConfigured(input.env)) {
		return {
			day,
			skipped: true,
			reason: 'not-configured',
			summaryPresent: false,
		}
	}
	const config = readDrBackupS3Config(input.env)
	if (!config) {
		return {
			day,
			skipped: true,
			reason: 'not-configured',
			summaryPresent: false,
		}
	}
	const s3 = input.s3 ?? createDrBackupS3Client(config)
	const summary = await s3.getText(stagingSummaryKey(day))
	const strandedPreviousDays: Array<string> = []
	for (let offset = drExportCatchUpLookbackDays; offset >= 1; offset -= 1) {
		const candidate = utcDayMinus(day, offset)
		if ((await s3.head(stagingSummaryKey(candidate))).exists) continue
		if ((await s3.head(stagingProgressKey(candidate))).exists) {
			strandedPreviousDays.push(candidate)
		}
	}
	if (summary && strandedPreviousDays.length === 0) {
		console.info(
			'dr_export_watchdog',
			JSON.stringify({ day, summaryPresent: true }),
		)
		return { day, skipped: false, summaryPresent: true }
	}
	if (!summary && strandedPreviousDays.length > 0) {
		const nowMs = now.getTime()
		let olderCatchUpActive = false
		for (const strandedDay of strandedPreviousDays) {
			const progressText = await s3.getText(stagingProgressKey(strandedDay))
			if (!progressText) continue
			let parsed: unknown
			try {
				parsed = JSON.parse(progressText.text) as unknown
			} catch {
				continue
			}
			const progress = parseProgress(parsed)
			if (!progress) continue
			// Prefer advancedAt (survives lease clear after a successful tick).
			// Fall back to lease-derived activity for older progress.json files.
			const advancedAtMs = Date.parse(progress.advancedAt ?? '')
			const leaseExpiresAtMs = Date.parse(progress.leaseExpiresAt ?? '')
			const activityAtMs = Number.isFinite(advancedAtMs)
				? advancedAtMs
				: Number.isFinite(leaseExpiresAtMs)
					? leaseExpiresAtMs - progressLeaseDurationMs
					: NaN
			if (
				Number.isFinite(activityAtMs) &&
				nowMs - activityAtMs < strandedCatchUpActiveMs
			) {
				olderCatchUpActive = true
				break
			}
		}
		if (olderCatchUpActive) {
			const oldest = strandedPreviousDays[0]
			if (oldest && utcDayOffset(day, oldest) >= stagingLagAlertDays) {
				throw new Error(
					`DR staging lag: oldest stranded day ${oldest} is ${utcDayOffset(day, oldest)} UTC days behind ${day} and still has no summary. Catch-up is advancing, but it is not keeping up with one day per day. Resume the oldest via POST /__maintenance/dr-export.`,
				)
			}
			console.info(
				'dr_export_watchdog',
				JSON.stringify({
					day,
					summaryPresent: false,
					reason: 'deferred-for-older-stranded',
					strandedPreviousDays,
				}),
			)
			return {
				day,
				skipped: false,
				summaryPresent: false,
				reason: 'deferred-for-older-stranded',
			}
		}
		throw new Error(
			`DR staging catch-up is stuck. Earlier staging days are still stranded despite catch-up and have not advanced recently: ${strandedPreviousDays.join(', ')}. Resume the oldest via POST /__maintenance/dr-export.`,
		)
	}
	const strandedDetail =
		strandedPreviousDays.length > 0
			? ` Earlier staging days are still stranded despite catch-up: ${strandedPreviousDays.join(', ')}.`
			: ''
	if (summary) {
		throw new Error(
			`DR staging catch-up is stuck.${strandedDetail} Each listed day has exporter progress but no summary; resume it via POST /__maintenance/dr-export.`,
		)
	}
	const progressText = await s3.getText(stagingProgressKey(day))
	let phase = 'missing'
	let detail = ''
	if (progressText) {
		const progress = parseProgress(JSON.parse(progressText.text) as unknown)
		if (progress) {
			phase = progress.phase
			detail = ` mailboxOwnerIndex=${progress.mailbox.ownerIndex} runLogOwnerIndex=${progress.runLog.ownerIndex} storageIndex=${progress.storageIndex} artifactsIndex=${progress.artifactsIndex} revision=${progress.revision} warnings=${progress.warnings.length}`
		}
	}
	throw new Error(
		`DR staging summary missing for ${day} after the export window closed (progress phase=${phase}${detail}). The night's non-D1 backup is incomplete and the day cannot be sealed. Daytime catch-up ticks resume the oldest stranded day in the lookback first; if a day stays stranded, finish it via POST /__maintenance/dr-export.${strandedDetail}`,
	)
}

export function __testOnlyCreateInitialProgress(day: string, now: Date) {
	return createInitialProgress(day, now)
}

export function __testOnlyParseProgress(value: unknown) {
	return parseProgress(value)
}
