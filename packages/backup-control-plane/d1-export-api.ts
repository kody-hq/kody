import {
	BackupError,
	assertRemoteDatabaseIdentity,
	safeLog,
} from './backup-policy.ts'
import {
	type BackupEnvironment,
	type ExportReady,
	type ExportState,
} from './backup-types.ts'

export interface ApiOptions {
	fetcher?: typeof fetch
	sleep?: (milliseconds: number) => Promise<void>
	maxRequestAttempts?: number
	maxPollAttempts?: number
	earlyPollCount?: number
	earlyPollDelayMs?: number
	pollDelayMs?: number
	maxExportRestarts?: number
}

interface JsonObject {
	[key: string]: unknown
}

const DEFAULT_REQUEST_ATTEMPTS = 5
const MAX_RETRY_DELAY = 60_000
const DEFAULT_MAX_POLL_ATTEMPTS = 120
const DEFAULT_EARLY_POLL_COUNT = 5
const DEFAULT_EARLY_POLL_DELAY_MS = 2_000
const DEFAULT_POLL_DELAY_MS = 15_000
const DEFAULT_MAX_EXPORT_RESTARTS = 3
export const DEFAULT_BACKUP_MAX_SOURCE_BYTES = 4_500_000_000
const EXPORT_RESULT_EXPIRED_ERROR = 'Not currently exporting anything.'

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function classifyHttpStatus(
	status: number,
): 'hard' | 'retry' | 'malformed' {
	if (status === 401 || status === 403) return 'hard'
	if (status === 429 || status >= 500) return 'retry'
	return 'malformed'
}

function retryDelay(response: Response, attempt: number): number {
	const retryAfter = response.headers.get('retry-after')
	if (retryAfter && /^\d+$/.test(retryAfter)) {
		return Math.min(Number(retryAfter) * 1_000, MAX_RETRY_DELAY)
	}
	return Math.min(1_000 * 2 ** (attempt - 1), MAX_RETRY_DELAY)
}

async function apiJson(
	url: string,
	init: RequestInit,
	options: ApiOptions,
): Promise<JsonObject> {
	const fetcher = options.fetcher ?? fetch
	const sleep =
		options.sleep ?? ((milliseconds) => scheduler.wait(milliseconds))
	const attempts = options.maxRequestAttempts ?? DEFAULT_REQUEST_ATTEMPTS
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		let response: Response
		try {
			response = await fetcher(url, init)
		} catch {
			if (attempt === attempts) {
				throw new BackupError(
					'api-network-failure',
					'Cloudflare API request failed',
					true,
				)
			}
			await sleep(Math.min(1_000 * 2 ** (attempt - 1), MAX_RETRY_DELAY))
			continue
		}
		if (!response.ok) {
			const classification = classifyHttpStatus(response.status)
			switch (classification) {
				case 'hard':
					throw new BackupError(
						'api-auth-failure',
						`Cloudflare API rejected credentials (${response.status})`,
					)
				case 'retry':
					if (attempt < attempts) {
						await sleep(retryDelay(response, attempt))
						continue
					}
					throw new BackupError(
						'api-retries-exhausted',
						`Cloudflare API remained unavailable (${response.status})`,
						true,
					)
				case 'malformed':
					throw new BackupError(
						'api-http-error',
						`Cloudflare API returned HTTP ${response.status}`,
					)
				default: {
					const exhaustive: never = classification
					throw exhaustive
				}
			}
		}
		let body: unknown
		try {
			body = await response.json()
		} catch {
			throw new BackupError(
				'api-malformed-json',
				'Cloudflare API returned malformed JSON',
			)
		}
		if (!isObject(body) || body.success !== true || !isObject(body.result)) {
			throw new BackupError(
				'api-malformed-response',
				'Cloudflare API response envelope was invalid',
			)
		}
		return body.result
	}
	throw new BackupError(
		'api-retries-exhausted',
		'Cloudflare API retry limit reached',
	)
}

function authHeaders(env: BackupEnvironment): HeadersInit {
	return {
		authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
		'content-type': 'application/json',
	}
}

export async function verifySourceDatabaseIdentity(
	env: BackupEnvironment,
	options: ApiOptions = {},
): Promise<{ fileSize: number; maxSourceBytes: number }> {
	const configuredMax =
		env.BACKUP_MAX_SOURCE_BYTES ?? String(DEFAULT_BACKUP_MAX_SOURCE_BYTES)
	if (!/^\d+$/.test(configuredMax)) {
		throw new BackupError(
			'invalid-max-source-bytes',
			'BACKUP_MAX_SOURCE_BYTES must be a positive safe integer',
		)
	}
	const maxSourceBytes = Number(configuredMax)
	if (
		!Number.isSafeInteger(maxSourceBytes) ||
		maxSourceBytes <= 0 ||
		maxSourceBytes > DEFAULT_BACKUP_MAX_SOURCE_BYTES
	) {
		throw new BackupError(
			'invalid-max-source-bytes',
			`BACKUP_MAX_SOURCE_BYTES must be a positive safe integer no greater than ${String(DEFAULT_BACKUP_MAX_SOURCE_BYTES)}`,
		)
	}
	const database = await apiJson(
		`https://api.cloudflare.com/client/v4/accounts/${env.SOURCE_ACCOUNT_ID}/d1/database/${env.SOURCE_DATABASE_ID}`,
		{ headers: authHeaders(env) },
		options,
	)
	if (
		typeof database.uuid !== 'string' ||
		typeof database.name !== 'string' ||
		!Number.isSafeInteger(database.file_size) ||
		(database.file_size as number) < 0
	) {
		safeLog({
			event: 'source-size-failure',
			status: 'failure',
			errorCode: 'api-malformed-identity',
			sourceBytes:
				typeof database.file_size === 'number' ? database.file_size : undefined,
			maxSourceBytes,
		})
		throw new BackupError(
			'api-malformed-identity',
			'Cloudflare identity response was invalid',
		)
	}
	assertRemoteDatabaseIdentity(env, {
		uuid: database.uuid,
		name: database.name,
	})
	const fileSize = database.file_size as number
	if (fileSize === 0) {
		safeLog({
			event: 'source-size-failure',
			status: 'failure',
			errorCode: 'source-size-zero',
			sourceBytes: fileSize,
			maxSourceBytes,
		})
		throw new BackupError(
			'source-size-zero',
			'D1 source size was zero; retry after live metadata becomes available',
			true,
		)
	}
	if (fileSize >= maxSourceBytes) {
		safeLog({
			event: 'source-size-failure',
			status: 'failure',
			errorCode: 'source-size-limit-exceeded',
			sourceBytes: fileSize,
			maxSourceBytes,
		})
		throw new BackupError(
			'source-size-limit-exceeded',
			'D1 source size is at or above the configured backup ceiling',
		)
	}
	safeLog({
		event: 'source-size-success',
		status: 'success',
		sourceBytes: fileSize,
		maxSourceBytes,
	})
	return { fileSize, maxSourceBytes }
}

function isExportResultExpired(result: JsonObject): boolean {
	return (
		result.success === false && result.error === EXPORT_RESULT_EXPIRED_ERROR
	)
}

function parseExportState(result: JsonObject): ExportState {
	if (isExportResultExpired(result)) {
		return { kind: 'lost' }
	}
	if (
		result.type !== 'export' ||
		result.success !== true ||
		typeof result.at_bookmark !== 'string' ||
		result.at_bookmark.length === 0
	) {
		throw new BackupError(
			'export-malformed-response',
			'D1 export response was invalid',
		)
	}
	const status = result.status
	if (status === 'error') {
		throw new BackupError('export-failed', 'D1 reported an export failure')
	}
	if (status === 'complete') {
		const completed = result.result
		if (
			!isObject(completed) ||
			typeof completed.signed_url !== 'string' ||
			completed.signed_url.length === 0
		) {
			throw new BackupError(
				'export-malformed-response',
				'D1 completed without a signed URL',
			)
		}
		return {
			kind: 'complete',
			bookmark: result.at_bookmark,
			signedUrl: completed.signed_url,
		}
	}
	// Live D1 export polling returns status "active" while the export runs.
	// Older responses omitted status entirely; both mean pending.
	if (status === undefined || status === 'active') {
		return { kind: 'pending', bookmark: result.at_bookmark }
	}
	throw new BackupError(
		'export-malformed-response',
		'D1 export returned an unknown status',
	)
}

async function exportRequest(
	env: BackupEnvironment,
	bookmark: string | undefined,
	options: ApiOptions,
): Promise<ExportState> {
	const payload =
		bookmark === undefined
			? { output_format: 'polling' }
			: { output_format: 'polling', current_bookmark: bookmark }
	const result = await apiJson(
		`https://api.cloudflare.com/client/v4/accounts/${env.SOURCE_ACCOUNT_ID}/d1/database/${env.SOURCE_DATABASE_ID}/export`,
		{
			method: 'POST',
			headers: authHeaders(env),
			body: JSON.stringify(payload),
		},
		options,
	)
	return parseExportState(result)
}

export async function startD1Export(
	env: BackupEnvironment,
	options: ApiOptions = {},
): Promise<ExportState> {
	return exportRequest(env, undefined, options)
}

export async function pollD1Export(
	env: BackupEnvironment,
	bookmark: string,
	options: ApiOptions = {},
): Promise<ExportState> {
	if (!bookmark) {
		throw new BackupError(
			'export-missing-bookmark',
			'D1 export polling requires a bookmark',
		)
	}
	return exportRequest(env, bookmark, options)
}

function pollSleepMs(pollIndex: number, options: ApiOptions): number {
	const earlyCount = options.earlyPollCount ?? DEFAULT_EARLY_POLL_COUNT
	const earlyDelay = options.earlyPollDelayMs ?? DEFAULT_EARLY_POLL_DELAY_MS
	const laterDelay = options.pollDelayMs ?? DEFAULT_POLL_DELAY_MS
	return pollIndex <= earlyCount ? earlyDelay : laterDelay
}

/**
 * Drive an export from a start/pending/lost state to completion using the
 * live-API-aware cadence: poll immediately, ~2s for the first few waits, then
 * the longer interval. Restarts bare exports when the result expires.
 */
export async function awaitExportReady(
	env: BackupEnvironment,
	initial: ExportState,
	options: ApiOptions = {},
): Promise<ExportReady> {
	const sleep =
		options.sleep ?? ((milliseconds) => scheduler.wait(milliseconds))
	const maxPolls = options.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS
	const maxRestarts = options.maxExportRestarts ?? DEFAULT_MAX_EXPORT_RESTARTS
	let state = initial
	let restarts = 0
	let polls = 0

	while (true) {
		switch (state.kind) {
			case 'complete':
				return state
			case 'lost': {
				if (restarts >= maxRestarts) {
					throw new BackupError(
						'export-restart-limit',
						'D1 export result expired too many times',
					)
				}
				restarts += 1
				state = await startD1Export(env, options)
				continue
			}
			case 'pending': {
				if (polls >= maxPolls) {
					throw new BackupError(
						'export-poll-limit',
						'D1 export did not complete within the bounded polling window',
					)
				}
				polls += 1
				state = await pollD1Export(env, state.bookmark, options)
				if (state.kind === 'complete') return state
				if (state.kind === 'lost') continue
				if (polls < maxPolls) {
					await sleep(pollSleepMs(polls, options))
				}
				continue
			}
			default: {
				const exhaustive: never = state
				throw exhaustive
			}
		}
	}
}

export async function refreshCompletedD1Export(
	env: BackupEnvironment,
	bookmark: string,
	options: ApiOptions = {},
): Promise<ExportReady> {
	const state = await pollD1Export(env, bookmark, options)
	switch (state.kind) {
		case 'complete':
			if (state.bookmark !== bookmark) {
				throw new BackupError(
					'export-bookmark-mismatch',
					'D1 export refresh returned a different bookmark',
				)
			}
			return state
		case 'pending':
			throw new BackupError(
				'export-refresh-pending',
				'D1 export refresh did not return a completed signed URL',
				true,
			)
		case 'lost':
			// The poll result for this bookmark has expired. Starting a fresh
			// export here would block the source database a second time inside
			// one upload step, so fail the instance instead and let the normal
			// instance retry (catch-up restart) run a single new export.
			throw new BackupError(
				'export-result-expired',
				'D1 export result expired before upload; the instance retry will start a new export',
			)
		default: {
			const exhaustive: never = state
			throw exhaustive
		}
	}
}
