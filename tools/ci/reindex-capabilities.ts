import {
	capabilityReindexPhases,
	type CapabilityReindexPhase as CapabilityReindexPhaseName,
} from '#worker/vectorize/reindex-sweep.ts'
import { isExecutedDirectly } from '../node-runtime.ts'
import { fail } from './resource-utils.ts'

export type CapabilityReindexOptions = {
	baseUrl: string
	secret: string
	/** Omit for a full sweep (every phase). */
	phases?: ReadonlyArray<CapabilityReindexPhaseName>
	force?: boolean
	maxSweeps?: number
	/**
	 * Keep retrying a first-sweep 401/503 for this long. A secret set by
	 * `wrangler secret bulk` reaches the edge a few seconds after the command
	 * returns, so callers that just rotated the secret pass a short window.
	 */
	authRetrySeconds?: number
	fetcher?: typeof fetch
	sleep?: (ms: number) => Promise<void>
	now?: () => number
	log?: (line: string) => void
}

const authRetryDelayMs = 5_000

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]'])

const workersDevScriptNotFound = /(?:\b1042\b|workers_dev_script_not_found)/i

/** First-sweep failures that usually clear once secrets or the workers.dev route land. */
export function isRetryableFirstSweepReindexFailure(
	status: number,
	body: string,
) {
	if (status === 401 || status === 502 || status === 503 || status === 530) {
		return true
	}
	return workersDevScriptNotFound.test(body)
}

/** The bearer secret must never cross the network in cleartext. */
function assertSecretSafeOrigin(baseUrl: string) {
	let parsed: URL
	try {
		parsed = new URL(baseUrl)
	} catch {
		throw new Error(`Invalid --url "${baseUrl}".`)
	}
	if (parsed.protocol === 'https:') return
	if (parsed.protocol === 'http:' && loopbackHosts.has(parsed.hostname)) return
	throw new Error(
		`Refusing to send the reindex secret to ${parsed.origin}; use an https:// origin (plain http is only allowed for localhost).`,
	)
}

/**
 * Drive `POST /__maintenance/reindex-capabilities` until it reports
 * `complete: true`, passing each sweep's cursor to the next. Throws on a
 * non-2xx sweep, an incomplete sweep without a cursor, or `maxSweeps`.
 */
export async function runCapabilityReindex(options: CapabilityReindexOptions) {
	const fetcher = options.fetcher ?? fetch
	const log = options.log ?? ((line: string) => console.log(line))
	const maxSweeps = options.maxSweeps ?? 8
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
	const now = options.now ?? Date.now
	assertSecretSafeOrigin(options.baseUrl)
	const url = `${options.baseUrl.replace(/\/+$/, '')}/__maintenance/reindex-capabilities`
	const authRetryUntil = now() + (options.authRetrySeconds ?? 0) * 1000
	let cursor: unknown
	for (let sweep = 1; sweep <= maxSweeps; sweep += 1) {
		const body = {
			...(options.phases ? { phases: options.phases } : {}),
			...(options.force ? { force: true } : {}),
			...(cursor === undefined ? {} : { cursor }),
		}
		log(`POST ${url} (sweep ${sweep}) ${JSON.stringify(body)}`)
		const send = () =>
			fetcher(url, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${options.secret}`,
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(120_000),
			})
		let response = await send()
		let text = await response.text()
		log(text)
		while (
			sweep === 1 &&
			isRetryableFirstSweepReindexFailure(response.status, text) &&
			now() + authRetryDelayMs <= authRetryUntil
		) {
			const reason = workersDevScriptNotFound.test(text)
				? 'the preview workers.dev script may still be binding'
				: 'the reindex secret may still be propagating'
			log(
				`HTTP ${response.status}; ${reason}. Retrying in ${authRetryDelayMs / 1000}s.`,
			)
			await sleep(authRetryDelayMs)
			response = await send()
			text = await response.text()
			log(text)
		}
		if (!response.ok) {
			throw new Error(`Capability reindex failed with HTTP ${response.status}.`)
		}
		const payload = JSON.parse(text) as {
			complete?: boolean
			cursor?: unknown
		}
		if (payload.complete === true) {
			log(`Capability reindex complete after ${sweep} sweep(s).`)
			return { sweeps: sweep }
		}
		if (payload.cursor === undefined || payload.cursor === null) {
			throw new Error(
				'Capability reindex is incomplete but returned no cursor.',
			)
		}
		cursor = payload.cursor
	}
	throw new Error(
		`Capability reindex did not finish after ${maxSweeps} sweeps.`,
	)
}

export function parseReindexArgs(argv: ReadonlyArray<string>) {
	let baseUrl = ''
	let phases: Array<CapabilityReindexPhaseName> | undefined
	let force = false
	let maxSweeps: number | undefined
	let authRetrySeconds: number | undefined
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		const value = argv[index + 1] ?? ''
		if (
			(arg === '--url' ||
				arg === '--phases' ||
				arg === '--max-sweeps' ||
				arg === '--auth-retry-seconds') &&
			(!value || value.startsWith('-'))
		) {
			fail(`Missing value for ${arg}.`)
		}
		switch (arg) {
			case '--url':
				baseUrl = value
				index += 1
				break
			case '--phases': {
				const requested = value.split(',').filter(Boolean)
				for (const phase of requested) {
					if (
						!(capabilityReindexPhases as ReadonlyArray<string>).includes(phase)
					) {
						fail(
							`Unknown --phases entry "${phase}". Use ${capabilityReindexPhases.join(', ')}.`,
						)
					}
				}
				phases = requested as Array<CapabilityReindexPhaseName>
				index += 1
				break
			}
			case '--force':
				force = true
				break
			case '--max-sweeps':
				maxSweeps = Number(value)
				if (!Number.isInteger(maxSweeps) || maxSweeps < 1) {
					fail('--max-sweeps must be a positive integer.')
				}
				index += 1
				break
			case '--auth-retry-seconds':
				authRetrySeconds = Number(value)
				if (!Number.isInteger(authRetrySeconds) || authRetrySeconds < 0) {
					fail('--auth-retry-seconds must be a non-negative integer.')
				}
				index += 1
				break
			default:
				fail(
					`Unknown flag: ${arg}. Usage: node tools/ci/reindex-capabilities.ts --url <origin> [--phases capabilities,memories,jobs,packages] [--force] [--max-sweeps <n>] [--auth-retry-seconds <n>] (reads CAPABILITY_REINDEX_SECRET)`,
				)
		}
	}
	if (!baseUrl) fail('Missing required flag: --url <origin>')
	return { baseUrl, phases, force, maxSweeps, authRetrySeconds }
}

if (isExecutedDirectly(import.meta.url)) {
	const args = parseReindexArgs(process.argv.slice(2))
	const secret = process.env.CAPABILITY_REINDEX_SECRET?.trim()
	if (!secret) fail('Missing CAPABILITY_REINDEX_SECRET.')
	try {
		await runCapabilityReindex({ ...args, secret })
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error))
	}
}
