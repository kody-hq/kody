import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse as parsePublicSuffix } from 'tldts'
import { resolveLocalBinary } from '../node-runtime.ts'

type WranglerEnvName = 'preview' | 'production'

type WranglerMigration = {
	tag: string
	deleted_classes?: Array<string>
	new_sqlite_classes?: Array<string>
	renamed_classes?: Array<{
		from: string
		to: string
	}>
}

type D1DatabaseListEntry = {
	uuid: string
	name: string
}

type KvNamespaceListEntry = {
	id: string
	title: string
}

type CloudflareApiEnvelope<T> = {
	success?: boolean
	result?: T
	errors?: Array<{ code?: number | string; message?: string }>
	result_info?: { total_pages?: number; cursor?: string }
}

export type CloudflareQueue = {
	queue_id: string
	queue_name: string
}

const cloudflareApiRetryMaxAttempts = 4
const cloudflareApiRetryBaseDelayMs = 250

function sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export class CloudflareResourceError extends Error {
	readonly kind: string
	readonly resource: string

	constructor(
		kind: string,
		resource: string,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options)
		this.name = 'CloudflareResourceError'
		this.kind = kind
		this.resource = resource
	}
}

/**
 * Permanent Cloudflare auth failures must not be retried. 401/403 and
 * wrangler "Authentication error [code: 10000]" stay in this set so a bad
 * token cannot burn the preview cleanup budget.
 *
 * Cloudflare also returns HTTP 500 with
 * "Internal authentication error: internal server error" as a transient
 * platform blip (seen on scheduled preview sweeps). That phrasing matches a
 * naive `/authentication error/i` check, so 5xx envelopes and the Internal
 * wording (when not on 401/403) are excluded here and stay retryable via
 * `isRetryableCloudflareFailure`. Explicit 401/403 always win over wording.
 */
export function isPermanentCloudflareAuthFailure(message: string) {
	if (
		/Cloudflare API request failed \(401\)/.test(message) ||
		/Cloudflare API request failed \(403\)/.test(message)
	) {
		return true
	}
	if (
		/Cloudflare API request failed \(5\d\d\)/.test(message) ||
		/internal authentication error/i.test(message)
	) {
		return false
	}
	return (
		/authentication error/i.test(message) || /\[code:\s*10000\]/.test(message)
	)
}

export function isRetryableCloudflareFailure(message: string) {
	if (isPermanentCloudflareAuthFailure(message)) return false
	return (
		(message.includes('Malformed Cloudflare response') &&
			!/Malformed Cloudflare response \(200\).*--/u.test(message)) ||
		// Wrangler uses this phrasing for truncated JSON on 200 GET /deployments,
		// not only 5xx connect resets. Keep the multipart-200 exclusion above.
		message.includes('Received a malformed response from the API') ||
		message.includes('upstream connect error') ||
		message.includes('Cloudflare API request failed (429)') ||
		/Cloudflare API request failed \(5\d\d\)/.test(message) ||
		// Cloudflare platform blip (also appears in wrangler stderr without an
		// HTTP status envelope). Distinct from permanent "Authentication error".
		/internal authentication error/i.test(message) ||
		/504 Gateway Timeout/i.test(message) ||
		/Gateway Timeout/i.test(message) ||
		message.includes('fetch failed') ||
		message.includes('ECONNRESET') ||
		message.includes('ETIMEDOUT') ||
		message.includes('socket hang up')
	)
}

export function isRetryableCloudflareApiError(error: unknown) {
	if (!(error instanceof Error)) return false
	if (error.name === 'AbortError') return true
	return isRetryableCloudflareFailure(error.message)
}

/**
 * Cloudflare answered 404 or 410 for a resource that was just created, listed,
 * or deleted. Vectorize recycled preview names keep answering 410
 * `vectorize.index.deleted` for a while after create (#3674 #3712 #3718);
 * Queues can 404 by id after a concurrent delete (#3693). Callers wait or
 * recreate under a deadline — these are not permanent "does not exist"
 * outcomes for ensure-style flows.
 */
export function isTransientCloudflareGone(error: unknown) {
	if (!(error instanceof Error)) return false
	return /Cloudflare API request failed \((404|410)\)/.test(error.message)
}

/**
 * Account / service quota failures that must surface as a distinct class
 * (not a generic ensure flake). Cloudflare 10067 is the Durable Object
 * namespace cap (~500); 10090 is the broader Workers service limit (#3707).
 */
export function isCloudflareQuotaExceededFailure(message: string) {
	return (
		/\[code:\s*10067\]/.test(message) ||
		/\[code:\s*10090\]/.test(message) ||
		/Cloudflare API request failed \(\d+\):.*\b10067\b/.test(message) ||
		/Cloudflare API request failed \(\d+\):.*\b10090\b/.test(message)
	)
}

/** Account Durable Object namespace cap that preview leftovers fill (#3396). */
const cloudflareDurableObjectNamespaceLimit = 500

/**
 * Namespaces one fresh preview fleet typically creates (platform + runtime +
 * jobs owned classes, plus a small cushion for origin/highlight/workflow
 * bindings). Ensure refuses to start when remaining headroom is below this.
 */
const previewDurableObjectNamespaceHeadroom = 40

/**
 * Count Durable Object namespaces on the account. The listing has answered
 * both `[...]` and `{ namespaces: [...] }` (same as preview-sweep /
 * origin-production-deploy-state).
 */
async function countCloudflareDurableObjectNamespaces(input: {
	accountId: string
	apiToken: string
	apiBaseUrl?: string
	fetcher?: typeof fetch
	sleep?: (ms: number) => Promise<void>
	deadlineMs?: number
	now?: () => number
	maxAttempts?: number
}) {
	let count = 0
	let page = 1
	for (;;) {
		const payload = await cloudflareApiRequest<unknown>({
			...input,
			pathname: `/workers/durable_objects/namespaces?page=${String(page)}&per_page=100`,
		})
		const result = payload.result
		const batch = Array.isArray(result)
			? result
			: result &&
				  typeof result === 'object' &&
				  Array.isArray((result as { namespaces?: unknown }).namespaces)
				? (result as { namespaces: Array<unknown> }).namespaces
				: null
		if (!batch) {
			throw new Error(
				'Cloudflare Durable Object namespace listing returned a malformed result.',
			)
		}
		count += batch.length
		const totalPages = payload.result_info?.total_pages
		if (typeof totalPages === 'number') {
			if (page >= totalPages) break
		} else if (batch.length < 100) {
			break
		}
		page += 1
		if (page > 100) break
	}
	return count
}

/**
 * Fail before preview ensure provisions more Workers when the account is near
 * the Durable Object namespace cap. Reports remaining vs required headroom so
 * the job points at sweep/quota rather than a later opaque 10067 mid-deploy.
 */
export async function assertDurableObjectNamespaceHeadroom(input: {
	accountId: string
	apiToken: string
	requiredHeadroom?: number
	limit?: number
	apiBaseUrl?: string
	fetcher?: typeof fetch
	sleep?: (ms: number) => Promise<void>
	deadlineMs?: number
	now?: () => number
	maxAttempts?: number
}) {
	const limit = input.limit ?? cloudflareDurableObjectNamespaceLimit
	const required =
		input.requiredHeadroom ?? previewDurableObjectNamespaceHeadroom
	const count = await countCloudflareDurableObjectNamespaces(input)
	const remaining = limit - count
	if (remaining >= required) {
		console.error(
			`Durable Object namespace headroom: ${String(remaining)} free of ${String(limit)} (${String(count)} in use; need ${String(required)}).`,
		)
		return { count, remaining, limit, required }
	}
	throw new CloudflareResourceError(
		'durable-object-namespaces',
		'account',
		`Cloudflare Durable Object namespace headroom exhausted: ${String(count)} of ${String(limit)} in use (${String(remaining)} free, need ${String(required)}). Wait for preview-sweep or close leftover previews (quota codes 10067/10090).`,
	)
}

type CloudflareEventSubscription = {
	id: string
	name: string
	enabled: boolean
	events: Array<string>
	source: Record<string, unknown>
	destination: {
		type: string
		queue_id: string
	}
}

export const emailSendingEventTypes = [
	'message.delivered',
	'message.deferred',
	'message.bounced',
	'message.failed',
	'message.rejected',
	'message.complained',
] as const

const artifactsAccountEventTypes = [
	'repo.created',
	'repo.deleted',
	'repo.pushed',
] as const

type ArtifactsNamespaceInfo = {
	namespace: string
	repo_count?: number
	created_at?: string
	updated_at?: string
}

type ArtifactsRepoListEntry = {
	id?: string
	name: string
}

/**
 * Point a Wrangler env's ARTIFACTS binding and ARTIFACTS_NAMESPACE var at the
 * same namespace name. Preview generate/ensure call this so origin, platform,
 * and runtime all share the per-PR Artifacts namespace.
 */
export function setArtifactsNamespaceOnWranglerEnv(
	envRecord: Record<string, unknown>,
	namespace: string,
) {
	const existingVars = envRecord.vars
	if (
		existingVars &&
		typeof existingVars === 'object' &&
		!Array.isArray(existingVars)
	) {
		;(existingVars as Record<string, unknown>).ARTIFACTS_NAMESPACE = namespace
	} else {
		envRecord.vars = { ARTIFACTS_NAMESPACE: namespace }
	}

	const artifacts = envRecord.artifacts
	if (!Array.isArray(artifacts)) return
	for (const entry of artifacts) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
		const record = entry as Record<string, unknown>
		if (record.binding === 'ARTIFACTS') {
			record.namespace = namespace
		}
	}
}

function isArtifactsNamespaceAlreadyExistsMessage(message: string) {
	return (
		/already exists/i.test(message) ||
		/namespace.*(exists|taken)/i.test(message)
	)
}

function isArtifactsNamespaceNotFoundMessage(message: string) {
	return (
		/not found/i.test(message) ||
		/does not exist/i.test(message) ||
		/Cloudflare API request failed \(404\)/.test(message)
	)
}

/**
 * Ensure a Cloudflare Artifacts namespace exists (create if missing). Idempotent.
 * Namespaces are account-scoped containers for Artifacts repos; preview uses
 * one per PR (`kody-pr-<n>` / `kody-branch-<slug>`).
 */
export async function ensureArtifactsNamespace(input: {
	accountId: string
	apiToken: string
	namespace: string
	dryRun: boolean
	apiBaseUrl?: string
	fetcher?: typeof fetch
	sleep?: (ms: number) => Promise<void>
	maxAttempts?: number
	deadlineMs?: number
	now?: () => number
}) {
	if (input.dryRun) {
		console.error(`[dry-run] ensure Artifacts namespace: ${input.namespace}`)
		return { namespace: input.namespace }
	}
	try {
		const existing = await cloudflareApiRequest<ArtifactsNamespaceInfo>({
			...input,
			pathname: `/artifacts/namespaces/${encodeURIComponent(input.namespace)}`,
			method: 'GET',
		})
		if (existing.result?.namespace) {
			console.error(`Artifacts namespace exists: ${existing.result.namespace}`)
			return { namespace: existing.result.namespace }
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (!isArtifactsNamespaceNotFoundMessage(message)) {
			throw new CloudflareResourceError(
				'artifacts',
				input.namespace,
				`Failed to look up Artifacts namespace ${input.namespace}: ${message}`,
				{ cause: error },
			)
		}
	}

	try {
		const created = await cloudflareApiRequest<ArtifactsNamespaceInfo>({
			...input,
			pathname: '/artifacts/namespaces',
			method: 'POST',
			body: { namespace: input.namespace },
		})
		const name = created.result?.namespace ?? input.namespace
		console.error(`Created Artifacts namespace: ${name}`)
		return { namespace: name }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (isArtifactsNamespaceAlreadyExistsMessage(message)) {
			console.error(`Artifacts namespace exists: ${input.namespace}`)
			return { namespace: input.namespace }
		}
		throw new CloudflareResourceError(
			'artifacts',
			input.namespace,
			`Failed to create Artifacts namespace ${input.namespace}: ${message}`,
			{ cause: error },
		)
	}
}

async function listArtifactsNamespaceRepos(input: {
	accountId: string
	apiToken: string
	namespace: string
	apiBaseUrl?: string
	fetcher?: typeof fetch
	sleep?: (ms: number) => Promise<void>
	maxAttempts?: number
	deadlineMs?: number
	now?: () => number
}) {
	const repos: Array<ArtifactsRepoListEntry> = []
	let cursor: string | undefined
	for (;;) {
		const pathname = cursor
			? `/artifacts/namespaces/${encodeURIComponent(input.namespace)}/repos?limit=200&cursor=${encodeURIComponent(cursor)}`
			: `/artifacts/namespaces/${encodeURIComponent(input.namespace)}/repos?limit=200`
		const payload = await cloudflareApiRequest<Array<ArtifactsRepoListEntry>>({
			...input,
			pathname,
			method: 'GET',
		})
		for (const repo of payload.result ?? []) {
			if (repo?.name) repos.push(repo)
		}
		const nextCursor = payload.result_info?.cursor
		if (!nextCursor || (payload.result ?? []).length === 0) break
		cursor = nextCursor
	}
	return repos
}

/**
 * Empty then delete a Cloudflare Artifacts namespace. Used by preview cleanup
 * for per-PR namespaces. Callers must assert the name is a preview resource
 * before invoking.
 */
export async function deleteArtifactsNamespace(input: {
	accountId: string
	apiToken: string
	namespace: string
	dryRun: boolean
	apiBaseUrl?: string
	fetcher?: typeof fetch
	sleep?: (ms: number) => Promise<void>
	maxAttempts?: number
	deadlineMs?: number
	now?: () => number
}) {
	if (input.dryRun) {
		console.error(`[dry-run] delete Artifacts namespace: ${input.namespace}`)
		return
	}

	let repos: Array<ArtifactsRepoListEntry>
	try {
		repos = await listArtifactsNamespaceRepos(input)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (isArtifactsNamespaceNotFoundMessage(message)) {
			console.error(`Artifacts namespace already deleted: ${input.namespace}`)
			return
		}
		throw new CloudflareResourceError(
			'artifacts',
			input.namespace,
			`Failed to list Artifacts repos in namespace ${input.namespace}: ${message}`,
			{ cause: error },
		)
	}

	for (const repo of repos) {
		try {
			await cloudflareApiRequest<{ id: string }>({
				...input,
				pathname: `/artifacts/namespaces/${encodeURIComponent(input.namespace)}/repos/${encodeURIComponent(repo.name)}`,
				method: 'DELETE',
			})
			console.error(`Deleted Artifacts repo: ${input.namespace}/${repo.name}`)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (isArtifactsNamespaceNotFoundMessage(message)) {
				console.error(
					`Artifacts repo already deleted: ${input.namespace}/${repo.name}`,
				)
				continue
			}
			throw new CloudflareResourceError(
				'artifacts',
				input.namespace,
				`Failed to delete Artifacts repo ${input.namespace}/${repo.name}: ${message}`,
				{ cause: error },
			)
		}
	}

	try {
		await cloudflareApiRequest<{ namespace?: string } | null>({
			...input,
			pathname: `/artifacts/namespaces/${encodeURIComponent(input.namespace)}`,
			method: 'DELETE',
		})
		console.error(`Deleted Artifacts namespace: ${input.namespace}`)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (isArtifactsNamespaceNotFoundMessage(message)) {
			console.error(`Artifacts namespace already deleted: ${input.namespace}`)
			return
		}
		// Namespace DELETE is not always documented; after emptying repos the
		// preview isolation goal is met even if the empty namespace remains.
		if (
			/Cloudflare API request failed \(40[05]\)/.test(message) ||
			/method not allowed/i.test(message) ||
			/not supported/i.test(message)
		) {
			console.error(
				`Artifacts namespace ${input.namespace} emptied (${repos.length} repo(s)); namespace delete unavailable (${message}).`,
			)
			return
		}
		throw new CloudflareResourceError(
			'artifacts',
			input.namespace,
			`Failed to delete Artifacts namespace ${input.namespace}: ${message}`,
			{ cause: error },
		)
	}
}

export function fail(message: string): never {
	console.error(message)
	process.exit(1)
}

function renderArg(value: string) {
	if (!value) return '""'
	if (/^[a-zA-Z0-9_./:-]+$/.test(value)) return value
	return JSON.stringify(value)
}

export function runWrangler(
	args: Array<string>,
	options?: { input?: string; quiet?: boolean; timeoutMs?: number },
) {
	const wranglerBin = resolveLocalBinary('wrangler')
	const result = spawnSync(wranglerBin, args, {
		encoding: 'utf8',
		stdio: 'pipe',
		input: options?.input,
		env: process.env,
		timeout: options?.timeoutMs,
		killSignal: 'SIGTERM',
	})

	const status = result.status ?? 1
	const stdout = result.stdout ?? ''
	const stderr = result.stderr ?? ''
	const timeoutMessage =
		result.error?.message ??
		(result.signal === 'SIGTERM' && options?.timeoutMs
			? `wrangler timed out after ${String(options.timeoutMs)}ms`
			: '')

	if (!options?.quiet) {
		const rendered = args.map(renderArg).join(' ')
		console.error(`wrangler: ${wranglerBin} ${rendered}`)
	}

	if (status !== 0) {
		if (options?.quiet) {
			const rendered = args.map(renderArg).join(' ')
			console.error(`wrangler (failed): ${wranglerBin} ${rendered}`)
		}
		const output = `${stdout}${stderr}`.trim()
		if (output) {
			console.error(output)
		}
		if (timeoutMessage && !output.includes(timeoutMessage)) {
			console.error(timeoutMessage)
		}
	}

	return { status, stdout, stderr, errorMessage: timeoutMessage }
}

type WranglerRetryInput = {
	input?: string
	quiet?: boolean
	timeoutMs?: number
	sleep?: (ms: number) => Promise<void>
	maxAttempts?: number
	deadlineMs?: number
	now?: () => number
}

export async function runWranglerWithRetry(
	args: Array<string>,
	options?: WranglerRetryInput,
) {
	const maxAttempts = options?.maxAttempts ?? cloudflareApiRetryMaxAttempts
	const wait = options?.sleep ?? sleep
	const now = options?.now ?? Date.now
	const timeoutMs = options?.timeoutMs ?? 30_000
	let lastResult = runWrangler(args, {
		input: options?.input,
		quiet: options?.quiet,
		timeoutMs,
	})
	for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
		if (lastResult.status === 0) return lastResult
		const output =
			`${lastResult.stdout}${lastResult.stderr} ${lastResult.errorMessage}`.trim()
		const timeLeft =
			options?.deadlineMs === undefined
				? Number.POSITIVE_INFINITY
				: options.deadlineMs - now()
		if (
			!isRetryableCloudflareFailure(output) ||
			timeLeft < cloudflareApiRetryBaseDelayMs
		) {
			return lastResult
		}
		console.error(
			`Retrying wrangler ${args.map(renderArg).join(' ')} (attempt ${attempt + 1}/${maxAttempts})`,
		)
		await wait(
			Math.min(cloudflareApiRetryBaseDelayMs * 2 ** (attempt - 1), timeLeft),
		)
		lastResult = runWrangler(args, {
			input: options?.input,
			quiet: options?.quiet,
			timeoutMs,
		})
	}
	return lastResult
}

export function truncateWithSuffix(
	base: string,
	suffix: string,
	maxLen: number,
) {
	if (base.length + suffix.length <= maxLen) {
		return `${base}${suffix}`
	}
	const cut = Math.max(1, maxLen - suffix.length)
	const trimmed = base.slice(0, cut).replace(/-+$/g, '')
	return `${trimmed}${suffix}`
}

/** Cloudflare Workflow binding `name` max length (wrangler rejects longer). */
export const cloudflareWorkflowNameMaxLength = 64

const dynamicCallableWorkflowNameSuffix = '-dynamic-callable-workflows'

/** Hex chars kept from a digest when a workflow name must be truncated. */
const dynamicCallableWorkflowNameDigestLength = 8

/**
 * Per-worker dynamic-callable workflow name, within Cloudflare's 64-char
 * limit so long branch preview names (e.g. local-execute-parity-0092) still
 * deploy. When truncation is required, a short digest of the full runtime
 * worker name is embedded so two long slugs that share a prefix do not
 * collide. Runtime and platform/main configs must use the same helper so the
 * cross-script binding name matches.
 */
export function dynamicCallableWorkflowName(runtimeWorkerName: string) {
	const suffix = dynamicCallableWorkflowNameSuffix
	if (
		runtimeWorkerName.length + suffix.length <=
		cloudflareWorkflowNameMaxLength
	) {
		return `${runtimeWorkerName}${suffix}`
	}
	const digest = createHash('sha256')
		.update(runtimeWorkerName)
		.digest('hex')
		.slice(0, dynamicCallableWorkflowNameDigestLength)
	const digestPart = `-${digest}`
	const maxBase = Math.max(
		1,
		cloudflareWorkflowNameMaxLength - digestPart.length - suffix.length,
	)
	const trimmed = runtimeWorkerName.slice(0, maxBase).replace(/-+$/g, '')
	return `${trimmed}${digestPart}${suffix}`
}

export function listD1Databases(): Array<D1DatabaseListEntry> {
	const result = runWrangler(['d1', 'list', '--json'], { quiet: true })
	if (result.status !== 0) {
		throw new Error('Failed to list D1 databases (wrangler d1 list --json).')
	}
	try {
		return JSON.parse(result.stdout) as Array<D1DatabaseListEntry>
	} catch {
		throw new Error('Could not parse JSON output from wrangler d1 list --json.')
	}
}

export function listKvNamespaces(): Array<KvNamespaceListEntry> {
	const result = runWrangler(['kv', 'namespace', 'list'], { quiet: true })
	if (result.status !== 0) {
		throw new Error(
			'Failed to list KV namespaces (wrangler kv namespace list).',
		)
	}
	try {
		return JSON.parse(result.stdout) as Array<KvNamespaceListEntry>
	} catch {
		throw new Error(
			'Failed to parse JSON output from wrangler kv namespace list.',
		)
	}
}

export function isWranglerNotFoundOutput(output: string) {
	const lower = output.toLowerCase()
	return (
		lower.includes('not found') ||
		lower.includes("couldn't find") ||
		lower.includes('no such') ||
		lower.includes('does not exist')
	)
}

export async function deleteWorkerScript({
	name,
	dryRun,
	sleep: wait,
	maxAttempts,
	deadlineMs,
	now,
}: {
	name: string
	dryRun: boolean
	sleep?: (ms: number) => Promise<void>
	maxAttempts?: number
	deadlineMs?: number
	now?: () => number
}) {
	if (dryRun) {
		console.error(`[dry-run] delete Worker script: ${name}`)
		return
	}

	// Delete by script name only. Passing --config/--env makes Wrangler resolve
	// bindings from wrangler.jsonc (including KV namespaces without ids) and
	// can fail even when the token can delete the Worker and preview resources.
	const result = await runWranglerWithRetry(['delete', name, '--force'], {
		quiet: true,
		sleep: wait,
		maxAttempts,
		deadlineMs,
		now,
	})
	const output =
		`${result.stdout}${result.stderr} ${result.errorMessage}`.trim()

	if (result.status === 0) {
		if (output) {
			console.error(output)
		}
		console.error(`Deleted Worker script: ${name}`)
		return
	}

	if (isWranglerNotFoundOutput(output)) {
		console.error(`Worker script already deleted: ${name}`)
		return
	}

	throw new CloudflareResourceError(
		'worker',
		name,
		`Failed to delete Worker script: ${name}${output ? `: ${output}` : ''}`,
	)
}

/**
 * The Cloudflare API behind `wrangler r2 bucket list` returns a single
 * unpaginated page, so once an account holds more buckets than one page the
 * listing silently omits some of them. Never use the list as an existence
 * oracle; rely on the create/delete outcome for the specific bucket instead.
 */
export function isR2BucketAlreadyExistsOutput(output: string) {
	return (
		output.includes('[code: 10004]') ||
		output.toLowerCase().includes('already exists')
	)
}

export function ensureR2Bucket({
	name,
	dryRun,
}: {
	name: string
	dryRun: boolean
}): { name: string } {
	if (dryRun) {
		console.error(`[dry-run] ensure R2 bucket: ${name}`)
		return { name }
	}

	const createResult = runWrangler(['r2', 'bucket', 'create', name], {
		quiet: true,
	})
	if (createResult.status === 0) {
		console.error(`Created R2 bucket: ${name}`)
		return { name }
	}

	const output = `${createResult.stdout}${createResult.stderr}`.trim()
	if (isR2BucketAlreadyExistsOutput(output)) {
		console.error(`R2 bucket exists: ${name}`)
		return { name }
	}

	if (output) {
		console.error(output)
	}
	fail(`Failed to create R2 bucket: ${name}`)
}

export type R2LifecyclePolicyDocument = {
	rules: Array<Record<string, unknown>>
}

export function ensureR2BucketLifecycle({
	name,
	policy,
	dryRun,
}: {
	name: string
	policy: R2LifecyclePolicyDocument
	dryRun: boolean
}): { name: string; policy: R2LifecyclePolicyDocument } {
	if (dryRun) {
		console.error(`[dry-run] set R2 lifecycle for ${name}`)
		return { name, policy }
	}

	const tempDir = mkdtempSync(path.join(os.tmpdir(), 'kody-r2-lifecycle-'))
	const policyPath = path.join(tempDir, 'lifecycle.json')
	writeFileSync(policyPath, `${JSON.stringify(policy, null, '\t')}\n`)
	try {
		const result = runWrangler(
			[
				'r2',
				'bucket',
				'lifecycle',
				'set',
				name,
				'--file',
				policyPath,
				'--force',
			],
			{ quiet: true },
		)
		if (result.status === 0) {
			console.error(`Set R2 lifecycle for ${name}`)
			return { name, policy }
		}

		const output = `${result.stdout}${result.stderr}`.trim()
		if (output) {
			console.error(output)
		}
		fail(`Failed to set R2 lifecycle for ${name}`)
	} finally {
		rmSync(tempDir, { recursive: true, force: true })
	}
}

export function isR2BucketNotEmptyOutput(output: string) {
	const lower = output.toLowerCase()
	return (
		lower.includes('not empty') ||
		lower.includes('must be empty') ||
		output.includes('[code: 10008]') ||
		output.includes('[code: 10014]')
	)
}

type R2ObjectListEntry = {
	key?: string
	name?: string
}

function readR2ObjectKey(entry: R2ObjectListEntry) {
	if (typeof entry.key === 'string' && entry.key.length > 0) return entry.key
	if (typeof entry.name === 'string' && entry.name.length > 0) return entry.name
	return null
}

/**
 * Cloudflare R2 Delete Object requires slashes in the key to stay literal.
 * `encodeURIComponent` on the whole key turns `/` into `%2F` and nested
 * preview objects then fail to delete, leaving a non-empty bucket leftover.
 * Other reserved characters are still percent-encoded per segment.
 */
export function encodeR2ObjectKey(key: string) {
	return key.split('/').map(encodeURIComponent).join('/')
}

async function listR2BucketObjects(input: {
	accountId: string
	apiToken: string
	name: string
	apiBaseUrl?: string
	fetcher?: typeof fetch
	sleep?: (ms: number) => Promise<void>
	deadlineMs?: number
	now?: () => number
	maxAttempts?: number
}) {
	const objects: Array<string> = []
	let cursor: string | undefined
	let previousCursor: string | undefined
	for (let page = 0; page < 50; page += 1) {
		const search = new URLSearchParams({ per_page: '1000' })
		if (cursor) search.set('cursor', cursor)
		const payload = await cloudflareApiRequest<
			Array<R2ObjectListEntry> | { objects?: Array<R2ObjectListEntry> }
		>({
			accountId: input.accountId,
			apiToken: input.apiToken,
			apiBaseUrl: input.apiBaseUrl,
			fetcher: input.fetcher,
			sleep: input.sleep,
			deadlineMs: input.deadlineMs,
			now: input.now,
			maxAttempts: input.maxAttempts,
			pathname: `/r2/buckets/${encodeURIComponent(input.name)}/objects?${search.toString()}`,
		})
		const listed = Array.isArray(payload.result)
			? payload.result
			: (payload.result?.objects ?? [])
		for (const entry of listed) {
			const key = readR2ObjectKey(entry)
			if (key) objects.push(key)
		}
		previousCursor = cursor
		cursor = payload.result_info?.cursor
		if (!cursor || cursor === previousCursor) break
	}
	return objects
}

/**
 * Delete every object in an R2 bucket. Callers must already have proven the
 * bucket is preview-only (or otherwise safe to empty). Production and shared
 * buckets are never emptied from this helper's call sites.
 */
export async function emptyR2Bucket(input: {
	accountId: string
	apiToken: string
	name: string
	apiBaseUrl?: string
	fetcher?: typeof fetch
	sleep?: (ms: number) => Promise<void>
	deadlineMs?: number
	now?: () => number
	maxAttempts?: number
}) {
	let objects: Array<string>
	try {
		objects = await listR2BucketObjects(input)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (isWranglerNotFoundOutput(message) || /\(404\)/.test(message)) {
			console.error(`R2 bucket already deleted: ${input.name}`)
			return 0
		}
		throw error
	}
	for (const key of objects) {
		await cloudflareApiRequest({
			accountId: input.accountId,
			apiToken: input.apiToken,
			apiBaseUrl: input.apiBaseUrl,
			fetcher: input.fetcher,
			sleep: input.sleep,
			deadlineMs: input.deadlineMs,
			now: input.now,
			maxAttempts: input.maxAttempts,
			pathname: `/r2/buckets/${encodeURIComponent(input.name)}/objects/${encodeR2ObjectKey(key)}`,
			method: 'DELETE',
		})
		console.error(`Deleted R2 object: ${input.name}/${key}`)
	}
	return objects.length
}

export async function deleteR2Bucket({
	name,
	dryRun,
	emptyIfNonEmpty,
	accountId,
	apiToken,
	apiBaseUrl,
	fetcher,
	sleep: wait,
	maxAttempts,
	deadlineMs,
	now,
}: {
	name: string
	dryRun: boolean
	emptyIfNonEmpty?: boolean
	accountId?: string
	apiToken?: string
	apiBaseUrl?: string
	fetcher?: typeof fetch
	sleep?: (ms: number) => Promise<void>
	maxAttempts?: number
	deadlineMs?: number
	now?: () => number
}) {
	if (dryRun) {
		console.error(`[dry-run] delete R2 bucket: ${name}`)
		return
	}

	const retryOptions = {
		quiet: true,
		sleep: wait,
		maxAttempts,
		deadlineMs,
		now,
	} as const
	const result = await runWranglerWithRetry(
		['r2', 'bucket', 'delete', name],
		retryOptions,
	)
	if (result.status === 0) {
		console.error(`Deleted R2 bucket: ${name}`)
		return
	}

	const output =
		`${result.stdout}${result.stderr} ${result.errorMessage}`.trim()
	if (isWranglerNotFoundOutput(output)) {
		console.error(`R2 bucket already deleted: ${name}`)
		return
	}

	if (emptyIfNonEmpty && isR2BucketNotEmptyOutput(output)) {
		const resolvedAccountId = accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID
		const resolvedApiToken = apiToken ?? process.env.CLOUDFLARE_API_TOKEN
		if (!resolvedAccountId || !resolvedApiToken) {
			throw new CloudflareResourceError(
				'r2',
				name,
				`Failed to empty R2 bucket ${name}: missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN.`,
			)
		}
		console.error(`R2 bucket ${name} is not empty; deleting objects first.`)
		await emptyR2Bucket({
			accountId: resolvedAccountId,
			apiToken: resolvedApiToken,
			name,
			apiBaseUrl,
			fetcher,
			sleep: wait,
			maxAttempts,
			deadlineMs,
			now,
		})
		const emptied = await runWranglerWithRetry(
			['r2', 'bucket', 'delete', name],
			retryOptions,
		)
		if (emptied.status === 0) {
			console.error(`Deleted R2 bucket: ${name}`)
			return
		}
		const emptiedOutput =
			`${emptied.stdout}${emptied.stderr} ${emptied.errorMessage}`.trim()
		if (isWranglerNotFoundOutput(emptiedOutput)) {
			console.error(`R2 bucket already deleted: ${name}`)
			return
		}
		throw new CloudflareResourceError(
			'r2',
			name,
			`Failed to delete R2 bucket ${name} after emptying${emptiedOutput ? `: ${emptiedOutput}` : ''}`,
		)
	}

	throw new CloudflareResourceError(
		'r2',
		name,
		`Failed to delete R2 bucket ${name}${output ? `: ${output}` : ''}`,
	)
}

type CloudflareApiRequestInput = {
	accountId: string
	apiToken: string
	pathname: string
	method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
	/**
	 * Some Cloudflare DELETE endpoints document `result` as optional. Opt in
	 * only for those callers so other requests still require a result.
	 */
	allowMissingResult?: boolean
	body?: Record<string, unknown>
	apiBaseUrl?: string
	fetcher?: typeof fetch
	sleep?: (ms: number) => Promise<void>
	maxAttempts?: number
	deadlineMs?: number
	now?: () => number
}

async function cloudflareApiRequestOnce<T>(input: CloudflareApiRequestInput) {
	const baseUrl = input.apiBaseUrl ?? 'https://api.cloudflare.com/client/v4'
	const url = `${baseUrl.replace(/\/$/, '')}/accounts/${encodeURIComponent(input.accountId)}${input.pathname}`
	const abortController = new AbortController()
	const timeout = setTimeout(() => abortController.abort(), 30_000)
	try {
		const response = await (input.fetcher ?? fetch)(url, {
			method: input.method ?? 'GET',
			headers: {
				Authorization: `Bearer ${input.apiToken}`,
				Accept: 'application/json',
				...(input.body ? { 'Content-Type': 'application/json' } : {}),
			},
			...(input.body ? { body: JSON.stringify(input.body) } : {}),
			signal: abortController.signal,
		})
		const text = await response.text()
		const preview = text.trim().slice(0, 200) || '(empty body)'
		let parsed: unknown
		try {
			parsed = JSON.parse(text)
		} catch {
			throw new Error(
				`Malformed Cloudflare response (${response.status}) for ${input.pathname}: ${preview}`,
			)
		}
		if (
			parsed === null ||
			typeof parsed !== 'object' ||
			Array.isArray(parsed)
		) {
			throw new Error(
				`Malformed Cloudflare response (${response.status}) for ${input.pathname}: ${preview}`,
			)
		}
		const payload = parsed as CloudflareApiEnvelope<T>
		if (
			!response.ok ||
			payload.success !== true ||
			(payload.result === undefined && !input.allowMissingResult)
		) {
			const error = payload.errors?.[0]
			throw new Error(
				`Cloudflare API request failed (${response.status}): ${error?.message ?? error?.code ?? input.pathname}`,
			)
		}
		return payload
	} finally {
		clearTimeout(timeout)
	}
}

export async function cloudflareApiRequest<T>(
	input: CloudflareApiRequestInput,
) {
	const maxAttempts = input.maxAttempts ?? cloudflareApiRetryMaxAttempts
	const wait = input.sleep ?? sleep
	const now = input.now ?? Date.now
	let lastError: unknown
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			return await cloudflareApiRequestOnce<T>(input)
		} catch (error) {
			lastError = error
			const timeLeft =
				input.deadlineMs === undefined
					? Number.POSITIVE_INFINITY
					: input.deadlineMs - now()
			if (
				!isRetryableCloudflareApiError(error) ||
				attempt === maxAttempts ||
				timeLeft < cloudflareApiRetryBaseDelayMs
			) {
				throw error
			}
			console.error(
				`Retrying Cloudflare API ${input.method ?? 'GET'} ${input.pathname} (attempt ${attempt + 1}/${maxAttempts})`,
			)
			await wait(
				Math.min(cloudflareApiRetryBaseDelayMs * 2 ** (attempt - 1), timeLeft),
			)
		}
	}
	throw lastError
}

type CloudflareRootApiRequestInput = {
	apiToken: string
	pathname: string
	method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
	body?: Record<string, unknown>
	apiBaseUrl?: string
	fetcher?: typeof fetch
	sleep?: (ms: number) => Promise<void>
	maxAttempts?: number
}

async function cloudflareRootApiRequestOnce<T>(
	input: CloudflareRootApiRequestInput,
) {
	const baseUrl = input.apiBaseUrl ?? 'https://api.cloudflare.com/client/v4'
	const url = `${baseUrl.replace(/\/$/, '')}${input.pathname}`
	const abortController = new AbortController()
	const timeout = setTimeout(() => abortController.abort(), 30_000)
	try {
		const response = await (input.fetcher ?? fetch)(url, {
			method: input.method ?? 'GET',
			headers: {
				Authorization: `Bearer ${input.apiToken}`,
				Accept: 'application/json',
				...(input.body ? { 'Content-Type': 'application/json' } : {}),
			},
			...(input.body ? { body: JSON.stringify(input.body) } : {}),
			signal: abortController.signal,
		})
		const text = await response.text()
		const preview = text.trim().slice(0, 200) || '(empty body)'
		let parsed: unknown
		try {
			parsed = JSON.parse(text)
		} catch {
			throw new Error(
				`Malformed Cloudflare response (${response.status}) for ${input.pathname}: ${preview}`,
			)
		}
		if (
			parsed === null ||
			typeof parsed !== 'object' ||
			Array.isArray(parsed)
		) {
			throw new Error(
				`Malformed Cloudflare response (${response.status}) for ${input.pathname}: ${preview}`,
			)
		}
		const payload = parsed as CloudflareApiEnvelope<T>
		if (
			!response.ok ||
			payload.success !== true ||
			payload.result === undefined
		) {
			const error = payload.errors?.[0]
			throw new Error(
				`Cloudflare API request failed (${response.status}): ${error?.message ?? error?.code ?? input.pathname}`,
			)
		}
		return payload
	} finally {
		clearTimeout(timeout)
	}
}

async function cloudflareRootApiRequest<T>(
	input: CloudflareRootApiRequestInput,
) {
	// Non-idempotent methods are never retried automatically: a create whose
	// response was lost may have succeeded, and repeating it fails on the
	// duplicate instead of converging. Callers are ensure-style, so the next
	// deploy run reconciles an ambiguous outcome.
	const method = input.method ?? 'GET'
	const maxAttempts =
		method === 'GET' ? (input.maxAttempts ?? cloudflareApiRetryMaxAttempts) : 1
	const wait = input.sleep ?? sleep
	let lastError: unknown
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			return await cloudflareRootApiRequestOnce<T>(input)
		} catch (error) {
			lastError = error
			if (!isRetryableCloudflareApiError(error) || attempt === maxAttempts) {
				throw error
			}
			console.error(
				`Retrying Cloudflare API ${method} ${input.pathname} (attempt ${attempt + 1}/${maxAttempts})`,
			)
			await wait(cloudflareApiRetryBaseDelayMs * 2 ** (attempt - 1))
		}
	}
	throw lastError
}

type CloudflareZoneSummary = {
	id: string
	name: string
}

type CloudflareDnsRecord = {
	id: string
	type: string
	name: string
	content: string
	proxied?: boolean
}

const packageAppWildcardDnsContent = '100::'

export function readPackageAppZoneName(packageAppHostname: string) {
	// Default tldts parse (no `allowPrivateDomains`): a future PSL PRIVATE
	// listing for this apex must not change the zone name the deploy attaches.
	const parsed = parsePublicSuffix(packageAppHostname)
	return parsed.domain ?? null
}

export function packageAppApexRoutePattern(packageAppHostname: string) {
	return `${packageAppHostname}/*`
}

export function packageAppWildcardRoutePattern(packageAppHostname: string) {
	return `*.${packageAppHostname}/*`
}

/**
 * Catch-all route for Cloudflare for SaaS custom hostnames on the package-app
 * zone (ADR 0071). More-specific `apex/*` and `*.apex/*` routes stay ahead of
 * this pattern for first-party package-app traffic.
 */
export function packageAppCustomHostnameCatchAllRoutePattern() {
	return '*/*'
}

function packageAppWildcardDnsRecordName(packageAppHostname: string) {
	return `*.${packageAppHostname}`
}

/**
 * SaaS origin + customer CNAME target (`domains.<apex>`). Must be an explicit
 * proxied DNS record — Cloudflare for SaaS rejects a fallback origin that is
 * only covered by the wildcard.
 */
function packageAppCustomDomainsOriginDnsRecordName(
	packageAppHostname: string,
) {
	return `domains.${packageAppHostname}`
}

/**
 * DNS record names the package-app zone needs: the apex, the per-user
 * wildcard, and the SaaS origin (`domains.<apex>`). All are served by zone
 * routes, which do not create DNS records, so each needs a proxied
 * placeholder record. None may be a Workers custom domain: a custom domain in
 * a zone whose route table the deploy also publishes gets detached (and its
 * DNS record deleted) when the routes are replaced.
 */
function packageAppDnsRecordNames(packageAppHostname: string) {
	return [
		packageAppHostname,
		packageAppWildcardDnsRecordName(packageAppHostname),
		packageAppCustomDomainsOriginDnsRecordName(packageAppHostname),
	]
}

/**
 * Canonical `PACKAGE_APP_BASE_URL` hostname plus any
 * `PACKAGE_APP_LEGACY_HOSTS` entries, de-duplicated. Used by production DNS
 * ensure and runtime zone-route generation so every dual-served package-app
 * zone stays in the published set (omitting a listed host detaches it).
 */
export function listPackageAppHostnames(input: {
	packageAppBaseUrl?: string | null
	packageAppLegacyHosts?: string | null
}) {
	const hostnames: Array<string> = []
	const configured = input.packageAppBaseUrl?.trim()
	if (configured) {
		const hostname = new URL(configured).hostname
			.toLowerCase()
			.replace(/\.$/, '')
		if (hostname) hostnames.push(hostname)
	}
	for (const hostname of parseCommaSeparatedHostnames(
		input.packageAppLegacyHosts,
	)) {
		if (!hostnames.includes(hostname)) hostnames.push(hostname)
	}
	return hostnames
}

async function lookupCloudflareZoneId(input: {
	accountId: string
	apiToken: string
	zoneName: string
	apiBaseUrl?: string
	fetcher?: typeof fetch
	sleep?: (ms: number) => Promise<void>
}) {
	const payload = await cloudflareRootApiRequest<Array<CloudflareZoneSummary>>({
		apiToken: input.apiToken,
		apiBaseUrl: input.apiBaseUrl,
		fetcher: input.fetcher,
		sleep: input.sleep,
		pathname: `/zones?name=${encodeURIComponent(input.zoneName)}&account.id=${encodeURIComponent(input.accountId)}&status=active`,
	})
	const zones = payload.result ?? []
	const zone = zones.find((entry) => entry.name === input.zoneName)
	return zone?.id ?? null
}

function isRequiredPackageAppDnsRecord(input: {
	record: CloudflareDnsRecord
	recordName: string
}) {
	return (
		input.record.type === 'AAAA' &&
		input.record.name === input.recordName &&
		input.record.content === packageAppWildcardDnsContent &&
		input.record.proxied === true
	)
}

/**
 * Idempotently ensure the proxied placeholder AAAA records the package-app
 * zone routes need: one at the apex and one at the per-user wildcard (see
 * `packageAppDnsRecordNames` for why neither may be a custom domain).
 */
export async function ensurePackageAppDnsRecords(input: {
	accountId: string
	apiToken: string
	packageAppHostname: string
	dryRun: boolean
	apiBaseUrl?: string
	fetcher?: typeof fetch
	sleep?: (ms: number) => Promise<void>
}) {
	const zoneName = readPackageAppZoneName(input.packageAppHostname)
	if (!zoneName) {
		return fail(
			`Could not derive a registrable zone name from PACKAGE_APP_BASE_URL host "${input.packageAppHostname}". Use a hostname on a public suffix (for example kody.run).`,
		)
	}
	const recordNames = packageAppDnsRecordNames(input.packageAppHostname)
	if (input.dryRun) {
		for (const recordName of recordNames) {
			console.error(
				`[dry-run] ensure package-app DNS: ${recordName} AAAA ${packageAppWildcardDnsContent} (proxied) in zone ${zoneName}`,
			)
		}
		return
	}

	const zoneId = await lookupCloudflareZoneId({
		accountId: input.accountId,
		apiToken: input.apiToken,
		zoneName,
		apiBaseUrl: input.apiBaseUrl,
		fetcher: input.fetcher,
		sleep: input.sleep,
	})
	if (!zoneId) {
		return fail(
			`Package-app zone "${zoneName}" was not found in Cloudflare account ${input.accountId}. Create the zone, add proxied DNS records (${recordNames.join(' and ')} AAAA ${packageAppWildcardDnsContent}), then re-run deploy. See docs/contributing/setup-manifest.md.`,
		)
	}

	for (const recordName of recordNames) {
		// List every record type at the name: filtering to AAAA would hide a
		// conflicting A or CNAME record and turn the actionable conflict error
		// below into an opaque create failure.
		const listed = await cloudflareRootApiRequest<Array<CloudflareDnsRecord>>({
			apiToken: input.apiToken,
			apiBaseUrl: input.apiBaseUrl,
			fetcher: input.fetcher,
			sleep: input.sleep,
			pathname: `/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(recordName)}`,
		})
		// Conflicts are checked before accepting the required record: a stray A,
		// CNAME, or extra AAAA at the name must fail the deploy even when the
		// proxied AAAA also exists, otherwise resolution stays ambiguous.
		const conflicting = (listed.result ?? []).find(
			(record) =>
				record.name === recordName &&
				!isRequiredPackageAppDnsRecord({ record, recordName }),
		)
		if (conflicting) {
			return fail(
				`Package-app DNS record "${recordName}" exists in zone "${zoneName}" but is not a proxied AAAA ${packageAppWildcardDnsContent} record (found ${conflicting.type} ${conflicting.content}, proxied=${String(conflicting.proxied)}). Fix it in the Cloudflare dashboard, then re-run deploy.`,
			)
		}

		const existing = (listed.result ?? []).find((record) =>
			isRequiredPackageAppDnsRecord({ record, recordName }),
		)
		if (existing) {
			console.error(`Package-app DNS exists: ${existing.name} (${existing.id})`)
			continue
		}

		const created = await cloudflareRootApiRequest<CloudflareDnsRecord>({
			apiToken: input.apiToken,
			apiBaseUrl: input.apiBaseUrl,
			fetcher: input.fetcher,
			sleep: input.sleep,
			pathname: `/zones/${encodeURIComponent(zoneId)}/dns_records`,
			method: 'POST',
			body: {
				type: 'AAAA',
				name: recordName,
				content: packageAppWildcardDnsContent,
				proxied: true,
				ttl: 1,
			},
		})
		console.error(
			`Created package-app DNS: ${created.result?.name} (${created.result?.id})`,
		)
	}
}

/** Local-part for DMARC aggregate reports (rua) on the system email domain. */
const dmarcReportMailboxLocal = 'dmarc'

export const defaultDmarcReportForwardTo = 'me@kentcdodds.com'

function dmarcReportMailboxAddress(systemEmailDomain: string) {
	return `${dmarcReportMailboxLocal}@${systemEmailDomain}`
}

export function dmarcReportingTxtContent(systemEmailDomain: string) {
	return `v=DMARC1; p=reject; rua=mailto:${dmarcReportMailboxAddress(systemEmailDomain)}`
}

export function dmarcReportingRecordNames(input: {
	systemEmailDomain: string
	userEmailDomain: string
}) {
	const names = [`_dmarc.${input.systemEmailDomain}`]
	if (input.userEmailDomain !== input.systemEmailDomain) {
		names.push(`_dmarc.${input.userEmailDomain}`)
	}
	return names
}

/**
 * Idempotently ensure `_dmarc` TXT records advertise aggregate reporting to
 * `dmarc@<systemEmailDomain>` while keeping `p=reject`. Updates an existing
 * TXT when content differs; fails closed on non-TXT conflicts at the name.
 */
export async function ensureDmarcReportingTxtRecords(input: {
	apiToken: string
	zoneId: string
	systemEmailDomain: string
	userEmailDomain: string
	dryRun: boolean
	apiBaseUrl?: string
	fetcher?: typeof fetch
	sleep?: (ms: number) => Promise<void>
}) {
	const desired = dmarcReportingTxtContent(input.systemEmailDomain)
	const recordNames = dmarcReportingRecordNames({
		systemEmailDomain: input.systemEmailDomain,
		userEmailDomain: input.userEmailDomain,
	})
	if (input.dryRun) {
		for (const recordName of recordNames) {
			console.error(
				`[dry-run] ensure DMARC TXT: ${recordName} → ${desired} (zone ${input.zoneId})`,
			)
		}
		return { recordNames, content: desired }
	}

	for (const recordName of recordNames) {
		const listed = await cloudflareRootApiRequest<Array<CloudflareDnsRecord>>({
			apiToken: input.apiToken,
			apiBaseUrl: input.apiBaseUrl,
			fetcher: input.fetcher,
			sleep: input.sleep,
			pathname: `/zones/${encodeURIComponent(input.zoneId)}/dns_records?name=${encodeURIComponent(recordName)}`,
		})
		const records = listed.result ?? []
		const conflicting = records.find(
			(record) => record.name === recordName && record.type !== 'TXT',
		)
		if (conflicting) {
			return fail(
				`DMARC DNS name "${recordName}" exists in zone ${input.zoneId} but is not TXT (found ${conflicting.type} ${conflicting.content}). Fix it in the Cloudflare dashboard, then re-run deploy.`,
			)
		}
		const existingTxt = records.filter(
			(record) => record.name === recordName && record.type === 'TXT',
		)
		if (existingTxt.length > 1) {
			return fail(
				`DMARC DNS name "${recordName}" has ${String(existingTxt.length)} TXT records in zone ${input.zoneId}; keep a single _dmarc TXT, then re-run deploy.`,
			)
		}
		const existing = existingTxt[0]
		if (existing) {
			const current = existing.content.replace(/^"|"$/g, '')
			if (current === desired) {
				console.error(`DMARC TXT exists: ${existing.name} (${existing.id})`)
				continue
			}
			const updated = await cloudflareRootApiRequest<CloudflareDnsRecord>({
				apiToken: input.apiToken,
				apiBaseUrl: input.apiBaseUrl,
				fetcher: input.fetcher,
				sleep: input.sleep,
				pathname: `/zones/${encodeURIComponent(input.zoneId)}/dns_records/${encodeURIComponent(existing.id)}`,
				method: 'PUT',
				body: {
					type: 'TXT',
					name: recordName,
					content: desired,
					ttl: 1,
				},
			})
			console.error(
				`Updated DMARC TXT: ${updated.result?.name} (${updated.result?.id})`,
			)
			continue
		}

		const created = await cloudflareRootApiRequest<CloudflareDnsRecord>({
			apiToken: input.apiToken,
			apiBaseUrl: input.apiBaseUrl,
			fetcher: input.fetcher,
			sleep: input.sleep,
			pathname: `/zones/${encodeURIComponent(input.zoneId)}/dns_records`,
			method: 'POST',
			body: {
				type: 'TXT',
				name: recordName,
				content: desired,
				ttl: 1,
			},
		})
		console.error(
			`Created DMARC TXT: ${created.result?.name} (${created.result?.id})`,
		)
	}
	return { recordNames, content: desired }
}

type CloudflareEmailRoutingDestination = {
	id: string
	email: string
	verified?: string | null
}

type CloudflareEmailRoutingRule = {
	id: string
	name?: string
	enabled?: boolean
	matchers?: Array<{
		type?: string
		field?: string
		value?: string
	}>
	actions?: Array<{
		type?: string
		value?: Array<string>
	}>
}

function emailRoutingRuleMatchesDmarcMailbox(input: {
	rule: CloudflareEmailRoutingRule
	mailbox: string
}) {
	return (input.rule.matchers ?? []).some(
		(matcher) =>
			matcher.type === 'literal' &&
			matcher.field === 'to' &&
			matcher.value?.toLowerCase() === input.mailbox.toLowerCase(),
	)
}

function emailRoutingRuleForwardsExactlyTo(input: {
	rule: CloudflareEmailRoutingRule
	forwardTo: string
}) {
	const want = input.forwardTo.toLowerCase()
	const forwardActions = (input.rule.actions ?? []).filter(
		(action) => action.type === 'forward',
	)
	if (forwardActions.length !== 1) return false
	const values = forwardActions[0]?.value ?? []
	return values.length === 1 && values[0]?.toLowerCase() === want
}

/**
 * Ensure Email Routing forwards `dmarc@<systemEmailDomain>` to a verified
 * destination so DMARC aggregate reports are deliverable. Creates the rule
 * when missing; updates when the matcher exists but the forward target or
 * enabled state differs. Fails when the destination is missing or unverified
 * (Kent must complete Cloudflare's destination verification email).
 *
 * Zone rules are listed first. When an existing rule already forwards exactly
 * to `forwardTo`, destination listing is skipped — that account API needs
 * broader Email Routing permissions than zone rule read, and a correct rule
 * already proves the forward path works.
 */
export async function ensureDmarcEmailRoutingRule(input: {
	accountId: string
	apiToken: string
	zoneId: string
	systemEmailDomain: string
	forwardTo: string
	dryRun: boolean
	apiBaseUrl?: string
	fetcher?: typeof fetch
	sleep?: (ms: number) => Promise<void>
}) {
	const mailbox = dmarcReportMailboxAddress(input.systemEmailDomain)
	const ruleName = `DMARC reports → ${input.forwardTo}`
	if (input.dryRun) {
		console.error(
			`[dry-run] ensure Email Routing rule: ${mailbox} → ${input.forwardTo} (zone ${input.zoneId})`,
		)
		return { mailbox, forwardTo: input.forwardTo, created: false as const }
	}

	const rules: Array<CloudflareEmailRoutingRule> = []
	{
		let page = 1
		let totalPages = 1
		do {
			let payload: Awaited<
				ReturnType<
					typeof cloudflareRootApiRequest<Array<CloudflareEmailRoutingRule>>
				>
			>
			try {
				payload = await cloudflareRootApiRequest<
					Array<CloudflareEmailRoutingRule>
				>({
					apiToken: input.apiToken,
					apiBaseUrl: input.apiBaseUrl,
					fetcher: input.fetcher,
					sleep: input.sleep,
					pathname: `/zones/${encodeURIComponent(input.zoneId)}/email/routing/rules?page=${page}&per_page=50`,
				})
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				if (/Cloudflare API request failed \(403\)/.test(message)) {
					console.error(
						`WARNING: skipping DMARC Email Routing ensure — token cannot list zone routing rules (403). Add Zone Email Routing edit to Actions CLOUDFLARE_API_TOKEN, then re-run deploy. Wanted rule: ${mailbox} → ${input.forwardTo}.`,
					)
					return {
						mailbox,
						forwardTo: input.forwardTo,
						created: false as const,
						skipped: true as const,
					}
				}
				throw error
			}
			rules.push(...(payload.result ?? []))
			totalPages = Math.max(1, payload.result_info?.total_pages ?? 1)
			page += 1
		} while (page <= totalPages)
	}
	const existing = rules.find((rule) =>
		emailRoutingRuleMatchesDmarcMailbox({ rule, mailbox }),
	)
	const desiredBody = {
		name: ruleName,
		enabled: true,
		matchers: [{ type: 'literal', field: 'to', value: mailbox }],
		actions: [{ type: 'forward', value: [input.forwardTo] }],
	}
	const alreadyOkRule =
		existing &&
		existing.enabled !== false &&
		emailRoutingRuleForwardsExactlyTo({
			rule: existing,
			forwardTo: input.forwardTo,
		})
			? existing
			: undefined

	const destinations: Array<CloudflareEmailRoutingDestination> = []
	{
		let page = 1
		let totalPages = 1
		do {
			let payload: Awaited<
				ReturnType<
					typeof cloudflareApiRequest<Array<CloudflareEmailRoutingDestination>>
				>
			>
			try {
				payload = await cloudflareApiRequest<
					Array<CloudflareEmailRoutingDestination>
				>({
					accountId: input.accountId,
					apiToken: input.apiToken,
					apiBaseUrl: input.apiBaseUrl,
					fetcher: input.fetcher,
					sleep: input.sleep,
					pathname: `/email/routing/addresses?page=${page}&per_page=50`,
				})
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				if (/Cloudflare API request failed \(403\)/.test(message)) {
					if (alreadyOkRule) {
						// Rule already matches; destination list is unverifiable with
						// this token. Accept the rule but warn — do not treat unverified
						// destinations as verified when the list is readable.
						console.error(
							`WARNING: Email Routing rule exists (${mailbox} → ${input.forwardTo}, ${alreadyOkRule.id}) but token cannot list destinations (403) to re-verify the forward target. Add Account Email Routing destination read to Actions CLOUDFLARE_API_TOKEN.`,
						)
						return {
							mailbox,
							forwardTo: input.forwardTo,
							created: false as const,
							id: alreadyOkRule.id,
							destinationUnverified: true as const,
						}
					}
					// Soft-skip: missing Email Routing destination scope must not block
					// Worker deploys (stamp-scan and other tip fixes). Loud warning so
					// ops can grant Account Email Routing destination read + Zone edit.
					console.error(
						`WARNING: skipping DMARC Email Routing ensure — token cannot list Email Routing destinations (403). Add Account Email Routing destination read (and Zone Email Routing edit) to Actions CLOUDFLARE_API_TOKEN, then re-run deploy. Needed to ${existing ? 'update' : 'create'} the ${mailbox} → ${input.forwardTo} rule.`,
					)
					return {
						mailbox,
						forwardTo: input.forwardTo,
						created: false as const,
						skipped: true as const,
					}
				}
				throw error
			}
			destinations.push(...(payload.result ?? []))
			totalPages = Math.max(1, payload.result_info?.total_pages ?? 1)
			page += 1
		} while (page <= totalPages)
	}
	const destination = destinations.find(
		(entry) => entry.email.toLowerCase() === input.forwardTo.toLowerCase(),
	)
	if (!destination) {
		return fail(
			`Email Routing destination "${input.forwardTo}" is not registered on account ${input.accountId}. Add and verify it under Email → Email Routing → Destination addresses (or set DMARC_REPORT_FORWARD_TO to a verified address), then re-run deploy.`,
		)
	}
	if (!destination.verified) {
		return fail(
			`Email Routing destination "${input.forwardTo}" exists but is not verified yet. Complete the Cloudflare verification email, then re-run deploy.`,
		)
	}

	if (alreadyOkRule) {
		console.error(
			`Email Routing rule exists: ${mailbox} → ${input.forwardTo} (${alreadyOkRule.id})`,
		)
		return {
			mailbox,
			forwardTo: input.forwardTo,
			created: false as const,
			id: alreadyOkRule.id,
		}
	}

	if (existing) {
		const updated = await cloudflareRootApiRequest<CloudflareEmailRoutingRule>({
			apiToken: input.apiToken,
			apiBaseUrl: input.apiBaseUrl,
			fetcher: input.fetcher,
			sleep: input.sleep,
			pathname: `/zones/${encodeURIComponent(input.zoneId)}/email/routing/rules/${encodeURIComponent(existing.id)}`,
			method: 'PUT',
			body: desiredBody,
		})
		console.error(
			`Updated Email Routing rule: ${mailbox} → ${input.forwardTo} (${updated.result?.id ?? existing.id})`,
		)
		return {
			mailbox,
			forwardTo: input.forwardTo,
			created: false as const,
			id: updated.result?.id ?? existing.id,
		}
	}

	const created = await cloudflareRootApiRequest<CloudflareEmailRoutingRule>({
		apiToken: input.apiToken,
		apiBaseUrl: input.apiBaseUrl,
		fetcher: input.fetcher,
		sleep: input.sleep,
		pathname: `/zones/${encodeURIComponent(input.zoneId)}/email/routing/rules`,
		method: 'POST',
		body: desiredBody,
	})
	console.error(
		`Created Email Routing rule: ${mailbox} → ${input.forwardTo} (${created.result?.id})`,
	)
	return {
		mailbox,
		forwardTo: input.forwardTo,
		created: true as const,
		id: created.result?.id,
	}
}

export async function listCloudflareQueues(input: {
	accountId: string
	apiToken: string
	apiBaseUrl?: string
	fetcher?: typeof fetch
	sleep?: (ms: number) => Promise<void>
	deadlineMs?: number
	now?: () => number
	maxAttempts?: number
}) {
	const queues: Array<CloudflareQueue> = []
	let page = 1
	let totalPages = 1
	do {
		const payload = await cloudflareApiRequest<Array<CloudflareQueue>>({
			...input,
			pathname: `/queues?page=${page}&per_page=100`,
		})
		queues.push(...(payload.result ?? []))
		totalPages = Math.max(1, payload.result_info?.total_pages ?? 1)
		page += 1
	} while (page <= totalPages)
	return queues
}

export async function ensureCloudflareQueue(input: {
	accountId: string
	apiToken: string
	name: string
	dryRun: boolean
	apiBaseUrl?: string
	fetcher?: typeof fetch
	sleep?: (ms: number) => Promise<void>
	existingQueues?: Array<CloudflareQueue>
}) {
	if (input.dryRun) {
		console.error(`[dry-run] ensure Queue: ${input.name}`)
		return { id: `dry-run-${input.name}`, name: input.name }
	}
	const queues = input.existingQueues ?? (await listCloudflareQueues(input))
	const existing = queues.find((queue) => queue.queue_name === input.name)
	if (existing) {
		console.error(`Queue exists: ${existing.queue_name} (${existing.queue_id})`)
		return { id: existing.queue_id, name: existing.queue_name }
	}
	try {
		const payload = await cloudflareApiRequest<CloudflareQueue>({
			...input,
			pathname: '/queues',
			method: 'POST',
			body: { queue_name: input.name },
		})
		if (!payload.result?.queue_id || !payload.result.queue_name) {
			throw new Error(`Cloudflare created Queue without an id: ${input.name}`)
		}
		input.existingQueues?.push(payload.result)
		console.error(
			`Created Queue: ${payload.result.queue_name} (${payload.result.queue_id})`,
		)
		return { id: payload.result.queue_id, name: payload.result.queue_name }
	} catch (error) {
		let refreshed: Array<CloudflareQueue>
		try {
			refreshed = await listCloudflareQueues(input)
		} catch {
			throw error
		}
		const created = refreshed.find((queue) => queue.queue_name === input.name)
		if (!created) throw error
		if (
			input.existingQueues &&
			!input.existingQueues.some((queue) => queue.queue_id === created.queue_id)
		) {
			input.existingQueues.push(created)
		}
		console.error(
			`Queue exists after create retry: ${created.queue_name} (${created.queue_id})`,
		)
		return { id: created.queue_id, name: created.queue_name }
	}
}

type CloudflareQueueConsumer = {
	consumer_id: string
	script?: string
}

/**
 * True when a Cloudflare Queues API call failed because the queue (or a
 * consumer on it) is already gone. Preview cleanup lists queues by name,
 * then addresses them by id; a concurrent delete can 404 the id path even
 * though the name was present a moment earlier (#3693).
 *
 * Match only the HTTP 404 envelope: when Cloudflare omits an error message,
 * `cloudflareApiRequest` falls back to the pathname, so requiring
 * "not found" would miss a real already-gone response.
 */
export function isCloudflareQueueAlreadyGoneError(error: unknown) {
	if (!(error instanceof Error)) return false
	return error.message.startsWith('Cloudflare API request failed (404):')
}

/**
 * Deregister every consumer of a queue. Cloudflare refuses to delete a
 * Worker while it is registered as a queue consumer (code 10064), so
 * preview cleanup must remove the consumers before the Worker scripts.
 *
 * A 404 after the name was resolved (queue or consumer already gone) is
 * treated as success — same as a miss on the name listing — so a
 * half-torn-down preview does not fail the sweep (#3693). Non-404 errors
 * still throw.
 */
export async function removeCloudflareQueueConsumers(input: {
	accountId: string
	apiToken: string
	name: string
	dryRun: boolean
	apiBaseUrl?: string
	fetcher?: typeof fetch
	sleep?: (ms: number) => Promise<void>
	deadlineMs?: number
	now?: () => number
	maxAttempts?: number
}) {
	if (input.dryRun) {
		console.error(`[dry-run] remove Queue consumers: ${input.name}`)
		return
	}
	const queue = (await listCloudflareQueues(input)).find(
		(candidate) => candidate.queue_name === input.name,
	)
	if (!queue) {
		console.error(
			`Queue already deleted (no consumers to remove): ${input.name}`,
		)
		return
	}
	let consumers: Array<CloudflareQueueConsumer>
	try {
		const payload = await cloudflareApiRequest<Array<CloudflareQueueConsumer>>({
			...input,
			pathname: `/queues/${queue.queue_id}/consumers`,
		})
		consumers = payload.result ?? []
	} catch (error) {
		if (isCloudflareQueueAlreadyGoneError(error)) {
			console.error(
				`Queue already deleted (no consumers to remove): ${input.name}`,
			)
			return
		}
		throw error
	}
	if (consumers.length === 0) {
		console.error(`Queue has no consumers: ${input.name}`)
		return
	}
	for (const consumer of consumers) {
		try {
			await cloudflareApiRequest({
				...input,
				pathname: `/queues/${queue.queue_id}/consumers/${consumer.consumer_id}`,
				method: 'DELETE',
			})
		} catch (error) {
			if (isCloudflareQueueAlreadyGoneError(error)) {
				console.error(
					`Queue consumer already deleted: ${input.name} <- ${consumer.script ?? consumer.consumer_id}`,
				)
				continue
			}
			throw error
		}
		console.error(
			`Removed Queue consumer: ${input.name} <- ${consumer.script ?? consumer.consumer_id}`,
		)
	}
}

/**
 * Cloudflare returns this 400 while a Worker still binds the queue. Deleting
 * the Worker first is required, but the binding release propagates
 * asynchronously, so a just-deleted Worker can briefly keep the queue
 * undeletable.
 */
function isQueueStillReferencedError(error: unknown) {
	return (
		error instanceof Error &&
		error.message.includes('still referenced by a binding in a Worker')
	)
}

const queueBindingReleaseMaxAttempts = 5
const queueBindingReleaseBaseDelayMs = 2_000

export async function deleteCloudflareQueue(input: {
	accountId: string
	apiToken: string
	name: string
	dryRun: boolean
	apiBaseUrl?: string
	fetcher?: typeof fetch
	sleep?: (ms: number) => Promise<void>
	deadlineMs?: number
	now?: () => number
	maxAttempts?: number
}) {
	if (input.dryRun) {
		console.error(`[dry-run] delete Queue: ${input.name}`)
		return
	}
	const queue = (await listCloudflareQueues(input)).find(
		(candidate) => candidate.queue_name === input.name,
	)
	if (!queue) {
		console.error(`Queue already deleted: ${input.name}`)
		return
	}
	const wait = input.sleep ?? sleep
	const now = input.now ?? Date.now
	for (let attempt = 1; ; attempt += 1) {
		try {
			await cloudflareApiRequest({
				...input,
				pathname: `/queues/${queue.queue_id}`,
				method: 'DELETE',
			})
			break
		} catch (error) {
			// Same race as consumer removal: listed by name, deleted by id
			// elsewhere before this DELETE lands (#3693).
			if (isCloudflareQueueAlreadyGoneError(error)) {
				console.error(`Queue already deleted: ${input.name}`)
				return
			}
			const timeLeft =
				input.deadlineMs === undefined
					? Number.POSITIVE_INFINITY
					: input.deadlineMs - now()
			if (
				!isQueueStillReferencedError(error) ||
				attempt === queueBindingReleaseMaxAttempts ||
				timeLeft < queueBindingReleaseBaseDelayMs
			) {
				throw error
			}
			console.error(
				`Queue ${input.name} is still bound to a Worker; waiting for the binding release (attempt ${attempt + 1}/${queueBindingReleaseMaxAttempts})`,
			)
			await wait(
				Math.min(queueBindingReleaseBaseDelayMs * 2 ** (attempt - 1), timeLeft),
			)
		}
	}
	console.error(`Deleted Queue: ${input.name} (${queue.queue_id})`)
}

async function listCloudflareEventSubscriptions(input: {
	accountId: string
	apiToken: string
	apiBaseUrl?: string
	fetcher?: typeof fetch
}) {
	const subscriptions: Array<CloudflareEventSubscription> = []
	let page = 1
	let totalPages = 1
	do {
		const payload = await cloudflareApiRequest<
			Array<CloudflareEventSubscription>
		>({
			...input,
			pathname: `/event_subscriptions/subscriptions?page=${page}&per_page=100`,
		})
		subscriptions.push(...(payload.result ?? []))
		totalPages = Math.max(1, payload.result_info?.total_pages ?? 1)
		page += 1
	} while (page <= totalPages)
	return subscriptions
}

function sameStringSet(
	left: ReadonlyArray<string>,
	right: ReadonlyArray<string>,
) {
	return (
		left.length === right.length &&
		new Set(left).size === new Set(right).size &&
		left.every((value) => right.includes(value))
	)
}

export async function ensureEmailSendingEventSubscription(input: {
	accountId: string
	apiToken: string
	name: string
	queueId: string
	domain: string
	zoneId: string
	dryRun: boolean
	apiBaseUrl?: string
	fetcher?: typeof fetch
}) {
	if (input.dryRun) {
		console.error(
			`[dry-run] ensure Email Sending event subscription: ${input.name} (${input.domain})`,
		)
		return { id: `dry-run-${input.name}`, name: input.name }
	}
	const subscriptions = await listCloudflareEventSubscriptions(input)
	const existing = subscriptions.find(
		(subscription) => subscription.name === input.name,
	)
	const events = [...emailSendingEventTypes]
	const sourceIsCurrent =
		existing?.source['type'] === 'email.sending' &&
		existing.source['domain'] === input.domain &&
		existing.source['zone_id'] === input.zoneId
	const isCurrent =
		existing?.enabled === true &&
		existing.destination.type === 'queues.queue' &&
		existing.destination.queue_id === input.queueId &&
		sourceIsCurrent &&
		sameStringSet(existing.events, events)
	if (existing && isCurrent) {
		console.error(`Email event subscription exists: ${existing.name}`)
		return { id: existing.id, name: existing.name }
	}
	if (existing) {
		const pathname = `/event_subscriptions/subscriptions/${encodeURIComponent(existing.id)}`
		if (sourceIsCurrent) {
			const payload = await cloudflareApiRequest<CloudflareEventSubscription>({
				...input,
				pathname,
				method: 'PATCH',
				body: {
					name: input.name,
					enabled: true,
					destination: {
						type: 'queues.queue',
						queue_id: input.queueId,
					},
					events,
				},
			})
			console.error(`Updated Email event subscription: ${existing.name}`)
			return {
				id: payload.result?.id ?? existing.id,
				name: payload.result?.name ?? existing.name,
			}
		}
		await cloudflareApiRequest<CloudflareEventSubscription>({
			...input,
			pathname,
			method: 'DELETE',
			allowMissingResult: true,
		})
		console.error(
			`Deleted Email event subscription with stale source: ${existing.name}`,
		)
	}
	const payload = await cloudflareApiRequest<CloudflareEventSubscription>({
		...input,
		pathname: '/event_subscriptions/subscriptions',
		method: 'POST',
		body: {
			name: input.name,
			enabled: true,
			source: {
				type: 'email.sending',
				domain: input.domain,
				zone_id: input.zoneId,
			},
			destination: {
				type: 'queues.queue',
				queue_id: input.queueId,
			},
			events,
		},
	})
	if (!payload.result?.id || !payload.result.name) {
		throw new Error(
			`Cloudflare created Email event subscription without an id: ${input.name}`,
		)
	}
	console.error(`Created Email event subscription: ${payload.result.name}`)
	return { id: payload.result.id, name: payload.result.name }
}

/**
 * Remove a named Email Sending event subscription when it is no longer
 * required (for example the system-domain subscription after user and system
 * domains collapse to one hostname). Idempotent when the name is already gone.
 */
export async function deleteEmailSendingEventSubscriptionIfPresent(input: {
	accountId: string
	apiToken: string
	name: string
	dryRun: boolean
	apiBaseUrl?: string
	fetcher?: typeof fetch
}) {
	if (input.dryRun) {
		console.error(
			`[dry-run] delete Email Sending event subscription if present: ${input.name}`,
		)
		return { deleted: false as const, name: input.name }
	}
	const subscriptions = await listCloudflareEventSubscriptions(input)
	const existing = subscriptions.find(
		(subscription) => subscription.name === input.name,
	)
	if (!existing) {
		console.error(`Email event subscription absent: ${input.name}`)
		return { deleted: false as const, name: input.name }
	}
	await cloudflareApiRequest<CloudflareEventSubscription>({
		...input,
		pathname: `/event_subscriptions/subscriptions/${encodeURIComponent(existing.id)}`,
		method: 'DELETE',
		allowMissingResult: true,
	})
	console.error(`Deleted Email event subscription: ${existing.name}`)
	return { deleted: true as const, id: existing.id, name: existing.name }
}

export async function ensureArtifactsAccountEventSubscription(input: {
	accountId: string
	apiToken: string
	name: string
	queueId: string
	dryRun: boolean
	apiBaseUrl?: string
	fetcher?: typeof fetch
}) {
	if (input.dryRun) {
		console.error(
			`[dry-run] ensure Artifacts account event subscription: ${input.name}`,
		)
		return { id: `dry-run-${input.name}`, name: input.name }
	}
	const subscriptions = await listCloudflareEventSubscriptions(input)
	const existing = subscriptions.find(
		(subscription) => subscription.name === input.name,
	)
	const events = [...artifactsAccountEventTypes]
	const sourceIsCurrent = existing?.source['type'] === 'artifacts'
	const isCurrent =
		existing?.enabled === true &&
		existing.destination.type === 'queues.queue' &&
		existing.destination.queue_id === input.queueId &&
		sourceIsCurrent &&
		sameStringSet(existing.events, events)
	if (existing && isCurrent) {
		console.error(`Artifacts event subscription exists: ${existing.name}`)
		return { id: existing.id, name: existing.name }
	}
	if (existing) {
		const pathname = `/event_subscriptions/subscriptions/${encodeURIComponent(existing.id)}`
		if (sourceIsCurrent) {
			const payload = await cloudflareApiRequest<CloudflareEventSubscription>({
				...input,
				pathname,
				method: 'PATCH',
				body: {
					name: input.name,
					enabled: true,
					destination: {
						type: 'queues.queue',
						queue_id: input.queueId,
					},
					events,
				},
			})
			console.error(`Updated Artifacts event subscription: ${existing.name}`)
			return {
				id: payload.result?.id ?? existing.id,
				name: payload.result?.name ?? existing.name,
			}
		}
		await cloudflareApiRequest<CloudflareEventSubscription>({
			...input,
			pathname,
			method: 'DELETE',
		})
		console.error(
			`Deleted Artifacts event subscription with stale source: ${existing.name}`,
		)
	}
	const payload = await cloudflareApiRequest<CloudflareEventSubscription>({
		...input,
		pathname: '/event_subscriptions/subscriptions',
		method: 'POST',
		body: {
			name: input.name,
			enabled: true,
			source: {
				type: 'artifacts',
			},
			destination: {
				type: 'queues.queue',
				queue_id: input.queueId,
			},
			events,
		},
	})
	if (!payload.result?.id || !payload.result.name) {
		throw new Error(
			`Cloudflare created Artifacts event subscription without an id: ${input.name}`,
		)
	}
	console.error(`Created Artifacts event subscription: ${payload.result.name}`)
	return { id: payload.result.id, name: payload.result.name }
}

function stripJsonc(source: string) {
	let output = ''
	let inString = false
	let stringQuote = ''
	let isEscaped = false
	let inLineComment = false
	let inBlockComment = false

	for (let index = 0; index < source.length; index += 1) {
		const char = source[index] ?? ''
		const next = source[index + 1] ?? ''

		if (inLineComment) {
			if (char === '\n') {
				inLineComment = false
				output += char
			}
			continue
		}

		if (inBlockComment) {
			if (char === '*' && next === '/') {
				inBlockComment = false
				index += 1
			}
			continue
		}

		if (inString) {
			output += char
			if (isEscaped) {
				isEscaped = false
				continue
			}
			if (char === '\\') {
				isEscaped = true
				continue
			}
			if (char === stringQuote) {
				inString = false
				stringQuote = ''
			}
			continue
		}

		if (char === '"' || char === "'") {
			inString = true
			stringQuote = char
			output += char
			continue
		}

		if (char === '/' && next === '/') {
			inLineComment = true
			index += 1
			continue
		}

		if (char === '/' && next === '*') {
			inBlockComment = true
			index += 1
			continue
		}

		output += char
	}

	return output
}

function stripTrailingCommas(source: string) {
	let output = ''
	let inString = false
	let stringQuote = ''
	let isEscaped = false

	for (let index = 0; index < source.length; index += 1) {
		const char = source[index] ?? ''

		if (inString) {
			output += char
			if (isEscaped) {
				isEscaped = false
				continue
			}
			if (char === '\\') {
				isEscaped = true
				continue
			}
			if (char === stringQuote) {
				inString = false
				stringQuote = ''
			}
			continue
		}

		if (char === '"' || char === "'") {
			inString = true
			stringQuote = char
			output += char
			continue
		}

		if (char === ',') {
			let lookahead = index + 1
			while (lookahead < source.length) {
				const next = source[lookahead] ?? ''
				if (next === ' ' || next === '\t' || next === '\n' || next === '\r') {
					lookahead += 1
					continue
				}
				if (next === '}' || next === ']') {
					// Skip comma before a closing token, preserve whitespace.
					break
				}
				break
			}
			const nextNonWhitespace = source[lookahead] ?? ''
			if (nextNonWhitespace === '}' || nextNonWhitespace === ']') {
				continue
			}
		}

		output += char
	}

	return output
}

export function parseJsonc<T>(source: string): T {
	const withoutBom = source.replace(/^\uFEFF/, '')
	const noComments = stripJsonc(withoutBom)
	const json = stripTrailingCommas(noComments)
	return JSON.parse(json) as T
}

function getMigrationTagVersion(tag: unknown) {
	if (typeof tag !== 'string') return undefined
	const match = /^v(\d+)$/.exec(tag)
	if (!match) return undefined
	return Number(match[1])
}

function sortWranglerMigrations(migrations: Array<Record<string, unknown>>) {
	const orderedMigrations = migrations
		.map((migration, index) => ({
			index,
			migration,
			version: getMigrationTagVersion(migration.tag),
		}))
		.sort((left, right) => {
			if (
				left.version === undefined ||
				right.version === undefined ||
				left.version === right.version
			) {
				return left.index - right.index
			}

			return left.version - right.version
		})
		.map(({ migration }) => migration)

	migrations.splice(0, migrations.length, ...orderedMigrations)
}

function readHostnameVar(input: {
	resolvedVars: Record<string, unknown>
	varName: 'APP_BASE_URL' | 'PACKAGE_APP_BASE_URL'
	baseConfigPath: string
	envName: WranglerEnvName
}) {
	const configured = input.resolvedVars[input.varName]
	if (typeof configured !== 'string' || !configured.trim()) return null

	let hostname: string
	try {
		hostname = new URL(configured.trim()).hostname
	} catch {
		return fail(
			`wrangler config "${input.baseConfigPath}" has an invalid "env.${input.envName}.vars.${input.varName}": ${configured}`,
		)
	}
	if (!hostname) {
		return fail(
			`wrangler config "${input.baseConfigPath}" has a "env.${input.envName}.vars.${input.varName}" without a hostname: ${configured}`,
		)
	}
	return hostname
}

const hostnameLabelPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/**
 * A bare hostname: dot-separated non-empty DNS labels, no scheme, no
 * user-info. Rejects values like `heykody..dev` or `user@host` that a
 * looser character-class check would let into the generated route set.
 */
export function isValidBareHostname(hostname: string) {
	if (!hostname) return false
	return hostname.split('.').every((label) => hostnameLabelPattern.test(label))
}

function parseCommaSeparatedHostnames(configured: string | null | undefined) {
	if (!configured) return []
	const hostnames: Array<string> = []
	for (const entry of configured.split(',')) {
		const hostname = entry.trim().toLowerCase().replace(/\.$/, '')
		if (hostname && !hostnames.includes(hostname)) hostnames.push(hostname)
	}
	return hostnames
}

/**
 * Parse a comma-separated hostname var (APP_LEGACY_HOSTS or
 * PACKAGE_APP_LEGACY_HOSTS) into bare hostnames.
 */
function readHostnamesVar(input: {
	resolvedVars: Record<string, unknown>
	varName: 'APP_LEGACY_HOSTS' | 'PACKAGE_APP_LEGACY_HOSTS'
	baseConfigPath: string
	envName: WranglerEnvName
}) {
	const configured = input.resolvedVars[input.varName]
	if (typeof configured !== 'string' || !configured.trim()) return []

	const hostnames: Array<string> = []
	for (const entry of configured.split(',')) {
		const hostname = entry.trim().toLowerCase().replace(/\.$/, '')
		if (!hostname) continue
		if (!isValidBareHostname(hostname)) {
			return fail(
				`wrangler config "${input.baseConfigPath}" has an invalid hostname in "env.${input.envName}.vars.${input.varName}": ${entry.trim()}. Use bare hostnames (no scheme), comma-separated.`,
			)
		}
		if (!hostnames.includes(hostname)) hostnames.push(hostname)
	}
	return hostnames
}

function readLegacyHostsVar(input: {
	resolvedVars: Record<string, unknown>
	baseConfigPath: string
	envName: WranglerEnvName
}) {
	return readHostnamesVar({ ...input, varName: 'APP_LEGACY_HOSTS' })
}

function readPackageAppLegacyHostsVar(input: {
	resolvedVars: Record<string, unknown>
	baseConfigPath: string
	envName: WranglerEnvName
}) {
	return readHostnamesVar({ ...input, varName: 'PACKAGE_APP_LEGACY_HOSTS' })
}

/**
 * Publish the Worker's Cloudflare routes, derived from the environment's
 * `APP_BASE_URL`, `APP_LEGACY_HOSTS`, and `PACKAGE_APP_BASE_URL`.
 *
 * **`routes` is the complete route set for the script, not an addition to it.**
 * A deploy that lists only the package-app domain detaches the app origin and
 * deletes its DNS record, which takes production down. So the app origin is
 * always listed alongside the package-app origin, and a package-app origin
 * without an app origin fails the deploy instead of publishing a partial set.
 * For the same reason a domain migration must list the previous app origin in
 * `APP_LEGACY_HOSTS` when `APP_BASE_URL` moves to the new domain — otherwise
 * the first deploy after the flip detaches the old origin and deletes its DNS.
 *
 * Per-user hosted package apps use `{username}.<package-app-domain>` subdomains.
 * Both the apex (`PACKAGE_APP_BASE_URL`, serving legacy redirects) and
 * `*.<package-app-host>/*` are published as **zone routes** (`zone_name` is the
 * registrable domain) on the runtime Worker — never as custom domains: a custom
 * domain in a zone whose route table the deploy also publishes gets detached
 * (deleting its DNS record) when the routes are replaced, which took the
 * package-app apex down on 2026-08-11. Zone routes do not create DNS records —
 * production CI ensures proxied AAAA `100::` records for both names separately.
 *
 * The routes are generated instead of committed because Wrangler resolves **local
 * dev** request URLs against the first configured route: a committed
 * `custom_domain` route makes every `npm run dev` request arrive as
 * `https://<that host>/...`, so local logins and redirects leave localhost.
 * Deriving them from the vars also keeps routing and provisioning from drifting —
 * the hosts the Worker routes on are the hosts the deploy attaches.
 *
 * Environments with no `PACKAGE_APP_BASE_URL` (preview, test) publish no routes
 * at all and keep whatever domains were attached out-of-band.
 */
function addPackageAppCustomDomainRoute(input: {
	targetEnv: Record<string, unknown>
	resolvedVars: Record<string, unknown>
	baseConfigPath: string
	envName: WranglerEnvName
}) {
	const packageAppHostname = readHostnameVar({
		resolvedVars: input.resolvedVars,
		varName: 'PACKAGE_APP_BASE_URL',
		baseConfigPath: input.baseConfigPath,
		envName: input.envName,
	})
	if (!packageAppHostname) return

	const appHostname = readHostnameVar({
		resolvedVars: input.resolvedVars,
		varName: 'APP_BASE_URL',
		baseConfigPath: input.baseConfigPath,
		envName: input.envName,
	})
	if (!appHostname) {
		return fail(
			`wrangler config "${input.baseConfigPath}" sets "env.${input.envName}.vars.PACKAGE_APP_BASE_URL" without "APP_BASE_URL". Publishing custom domains would detach the app origin and delete its DNS record; set APP_BASE_URL for this deploy.`,
		)
	}
	if (appHostname === packageAppHostname) {
		return fail(
			`wrangler config "${input.baseConfigPath}" points "env.${input.envName}.vars.APP_BASE_URL" and "PACKAGE_APP_BASE_URL" at the same host (${appHostname}). Hosted package apps must be a separate registrable domain.`,
		)
	}

	const legacyHostnames = readLegacyHostsVar(input).filter(
		(hostname) => hostname !== appHostname,
	)
	const packageAppLegacyHostnames = readPackageAppLegacyHostsVar(input).filter(
		(hostname) => hostname !== packageAppHostname,
	)
	const packageAppHostnames = [packageAppHostname, ...packageAppLegacyHostnames]
	const overlappingAppHost = packageAppHostnames.find((hostname) =>
		legacyHostnames.includes(hostname),
	)
	if (overlappingAppHost) {
		return fail(
			`wrangler config "${input.baseConfigPath}" lists the package-app host (${overlappingAppHost}) in "env.${input.envName}.vars.APP_LEGACY_HOSTS". Hosted package apps must stay a separate registrable domain from every app origin.`,
		)
	}

	const packageAppZoneName = readPackageAppZoneName(packageAppHostname)
	if (!packageAppZoneName) {
		return fail(
			`wrangler config "${input.baseConfigPath}" has "env.${input.envName}.vars.PACKAGE_APP_BASE_URL" host "${packageAppHostname}" without a registrable zone name. Use a hostname on a public suffix (for example kody.run).`,
		)
	}
	for (const hostname of packageAppLegacyHostnames) {
		const zoneName = readPackageAppZoneName(hostname)
		if (!zoneName) {
			return fail(
				`wrangler config "${input.baseConfigPath}" has "env.${input.envName}.vars.PACKAGE_APP_LEGACY_HOSTS" host "${hostname}" without a registrable zone name. Use a hostname on a public suffix (for example apps.example.dev).`,
			)
		}
	}

	const existingRoutes = Array.isArray(input.targetEnv.routes)
		? (input.targetEnv.routes as Array<unknown>)
		: []
	const existingRoutePatterns = new Set(
		existingRoutes.flatMap((route) => {
			if (!route || typeof route !== 'object') return []
			const pattern = (route as Record<string, unknown>).pattern
			return typeof pattern === 'string' ? [pattern] : []
		}),
	)

	// The package-app host is attached to the runtime Worker (ADR 0016), not
	// this one — its apex custom-domain route and the per-user wildcard zone
	// route are generated by tools/ci/runtime-worker-config.ts. The main
	// Worker publishes the app origin and any legacy origins.
	const wildcardRoutePattern =
		packageAppWildcardRoutePattern(packageAppHostname)
	const newRoutes: Array<Record<string, unknown>> = [
		appHostname,
		...legacyHostnames,
	]
		.filter((hostname) => !existingRoutePatterns.has(hostname))
		.map((pattern) => ({ pattern, custom_domain: true }))

	input.targetEnv.routes = [...existingRoutes, ...newRoutes]
	// Publishing routes flips `workers_dev` to false by default. Force it back
	// on so the `<name>.<subdomain>.workers.dev` trigger stays available as a
	// backup access path (MCP clients may point at it). Ask for it explicitly
	// so adding a custom domain does not silently take it away.
	input.targetEnv.workers_dev = true
	const legacyNote = legacyHostnames.length
		? `, ${legacyHostnames.join(', ')} (APP_LEGACY_HOSTS)`
		: ''
	const packageAppLegacyNote = packageAppLegacyHostnames.length
		? ` plus ${packageAppLegacyHostnames.join(', ')} (PACKAGE_APP_LEGACY_HOSTS)`
		: ''
	console.error(
		`Worker routes: ${appHostname} (APP_BASE_URL)${legacyNote}; workers.dev trigger kept. Package-app host ${packageAppHostname} (PACKAGE_APP_BASE_URL) and ${wildcardRoutePattern} (zone ${packageAppZoneName})${packageAppLegacyNote} are attached to the runtime worker.`,
	)
}

function setGeneratedR2BucketName(input: {
	r2Buckets: Array<unknown>
	binding: string
	bucketName: string
	baseConfigPath: string
	envName: WranglerEnvName
}) {
	const entryIndex = input.r2Buckets.findIndex((entry) => {
		if (!entry || typeof entry !== 'object') return false
		return (entry as Record<string, unknown>).binding === input.binding
	})
	if (entryIndex < 0) {
		fail(
			`wrangler config "${input.baseConfigPath}" has no ${input.envName} R2 binding for "${input.binding}".`,
		)
	}
	const entry = input.r2Buckets[entryIndex] as Record<string, unknown>
	input.r2Buckets[entryIndex] = {
		...entry,
		bucket_name: input.bucketName,
	}
}

export async function writeGeneratedWranglerConfig({
	baseConfigPath,
	outConfigPath,
	envName,
	workerName,
	d1DatabaseName,
	d1DatabaseId,
	auditD1DatabaseName,
	auditD1DatabaseId,
	oauthKvId,
	bundleArtifactsKvId,
	communityAssetsBucketName,
	emailBlobsBucketName,
	repoSessionBlobsBucketName,
	operatorBackupsBucketName,
	artifactsNamespace,
	workerVars,
	queueBindings,
	serviceBindings,
	extraMigrations,
	mainEntryPath,
}: {
	baseConfigPath: string
	outConfigPath: string
	envName: WranglerEnvName
	workerName?: string
	d1DatabaseName: string
	d1DatabaseId: string
	auditD1DatabaseName: string
	auditD1DatabaseId: string
	oauthKvId: string
	bundleArtifactsKvId: string
	communityAssetsBucketName: string
	emailBlobsBucketName: string
	repoSessionBlobsBucketName: string
	operatorBackupsBucketName: string
	/** When set, rewrites env ARTIFACTS binding + ARTIFACTS_NAMESPACE var. */
	artifactsNamespace?: string
	mainEntryPath?: string
	workerVars?: Record<string, string | undefined>
	queueBindings?: Array<{
		binding: string
		queue: string
		deadLetterQueue: string
	}>
	serviceBindings?: Array<{
		binding: string
		service: string
	}>
	extraMigrations?: Array<WranglerMigration>
}) {
	const baseText = await readFile(baseConfigPath, 'utf8')
	const config = parseJsonc<Record<string, unknown>>(baseText)

	const env = config.env
	if (!env || typeof env !== 'object') {
		fail(`wrangler config "${baseConfigPath}" is missing "env".`)
	}

	const targetEnv = (env as Record<string, unknown>)[envName]
	if (!targetEnv || typeof targetEnv !== 'object') {
		fail(`wrangler config "${baseConfigPath}" is missing "env.${envName}".`)
	}

	if (workerName) {
		config.name = workerName
	}

	if (mainEntryPath) {
		config.main = mainEntryPath
	}

	const targetAssets = (targetEnv as Record<string, unknown>).assets
	if (
		!targetAssets ||
		typeof targetAssets !== 'object' ||
		Array.isArray(targetAssets)
	) {
		fail(
			`wrangler config "${baseConfigPath}" is missing "env.${envName}.assets".`,
		)
	}
	config.assets = { ...(targetAssets as Record<string, unknown>) }

	const d1Databases = (targetEnv as Record<string, unknown>).d1_databases
	if (!Array.isArray(d1Databases)) {
		fail(
			`wrangler config "${baseConfigPath}" is missing "env.${envName}.d1_databases".`,
		)
	}

	for (const binding of [
		{
			name: 'APP_DB',
			databaseName: d1DatabaseName,
			databaseId: d1DatabaseId,
		},
		{
			name: 'AUDIT_DB',
			databaseName: auditD1DatabaseName,
			databaseId: auditD1DatabaseId,
		},
	]) {
		const entryIndex = d1Databases.findIndex((entry) => {
			if (!entry || typeof entry !== 'object') return false
			return (entry as Record<string, unknown>).binding === binding.name
		})
		if (entryIndex < 0) {
			fail(
				`wrangler config "${baseConfigPath}" has no ${envName} D1 binding for "${binding.name}".`,
			)
		}
		const entry = d1Databases[entryIndex] as Record<string, unknown>
		d1Databases[entryIndex] = {
			...entry,
			database_name: binding.databaseName,
			database_id: binding.databaseId,
		}
	}

	const kvNamespaces = (targetEnv as Record<string, unknown>).kv_namespaces
	if (!Array.isArray(kvNamespaces)) {
		fail(
			`wrangler config "${baseConfigPath}" is missing "env.${envName}.kv_namespaces".`,
		)
	}

	const oauthKvEntryIndex = kvNamespaces.findIndex((entry) => {
		if (!entry || typeof entry !== 'object') return false
		return (entry as Record<string, unknown>).binding === 'OAUTH_KV'
	})
	if (oauthKvEntryIndex < 0) {
		fail(
			`wrangler config "${baseConfigPath}" has no ${envName} KV binding for "OAUTH_KV".`,
		)
	}

	const oauthKvEntry = kvNamespaces[oauthKvEntryIndex] as Record<
		string,
		unknown
	>
	kvNamespaces[oauthKvEntryIndex] = {
		...oauthKvEntry,
		id: oauthKvId,
		preview_id: oauthKvId,
	}

	const bundleArtifactsKvEntryIndex = kvNamespaces.findIndex((entry) => {
		if (!entry || typeof entry !== 'object') return false
		return (entry as Record<string, unknown>).binding === 'BUNDLE_ARTIFACTS_KV'
	})
	if (bundleArtifactsKvEntryIndex < 0) {
		fail(
			`wrangler config "${baseConfigPath}" has no ${envName} KV binding for "BUNDLE_ARTIFACTS_KV".`,
		)
	}

	const bundleArtifactsKvEntry = kvNamespaces[
		bundleArtifactsKvEntryIndex
	] as Record<string, unknown>
	kvNamespaces[bundleArtifactsKvEntryIndex] = {
		...bundleArtifactsKvEntry,
		id: bundleArtifactsKvId,
		preview_id: bundleArtifactsKvId,
	}

	const r2Buckets = (targetEnv as Record<string, unknown>).r2_buckets
	if (!Array.isArray(r2Buckets)) {
		fail(
			`wrangler config "${baseConfigPath}" is missing "env.${envName}.r2_buckets".`,
		)
	}

	setGeneratedR2BucketName({
		r2Buckets,
		binding: 'COMMUNITY_ASSETS',
		bucketName: communityAssetsBucketName,
		baseConfigPath,
		envName,
	})
	setGeneratedR2BucketName({
		r2Buckets,
		binding: 'EMAIL_BLOBS',
		bucketName: emailBlobsBucketName,
		baseConfigPath,
		envName,
	})
	setGeneratedR2BucketName({
		r2Buckets,
		binding: 'REPO_SESSION_BLOBS',
		bucketName: repoSessionBlobsBucketName,
		baseConfigPath,
		envName,
	})
	setGeneratedR2BucketName({
		r2Buckets,
		binding: 'OPERATOR_BACKUPS',
		bucketName: operatorBackupsBucketName,
		baseConfigPath,
		envName,
	})

	const existingVars = (targetEnv as Record<string, unknown>).vars
	if (
		existingVars !== undefined &&
		(existingVars === null ||
			typeof existingVars !== 'object' ||
			Array.isArray(existingVars))
	) {
		fail(
			`wrangler config "${baseConfigPath}" has invalid "env.${envName}.vars".`,
		)
	}

	const resolvedVars = {
		...(existingVars as Record<string, unknown> | undefined),
	}
	for (const [key, value] of Object.entries(workerVars ?? {})) {
		if (typeof value === 'string' && value.length > 0) {
			resolvedVars[key] = value
		}
	}
	// Deployed preview/production must never carry the local-dev Turnstile
	// bypass. Local `npm run dev` writes a separate generated config.
	if (resolvedVars.WRANGLER_IS_LOCAL_DEV !== undefined) {
		fail(
			`wrangler config for env.${envName} must not set WRANGLER_IS_LOCAL_DEV (got ${JSON.stringify(resolvedVars.WRANGLER_IS_LOCAL_DEV)}). That flag skips production boot guards; use the local-dev generated config instead.`,
		)
	}
	;(targetEnv as Record<string, unknown>).vars = resolvedVars

	if (artifactsNamespace) {
		setArtifactsNamespaceOnWranglerEnv(
			targetEnv as Record<string, unknown>,
			artifactsNamespace,
		)
	}

	if (queueBindings && queueBindings.length > 0) {
		const queues = (targetEnv as Record<string, unknown>).queues
		if (!queues || typeof queues !== 'object' || Array.isArray(queues)) {
			fail(
				`wrangler config "${baseConfigPath}" is missing "env.${envName}.queues".`,
			)
		}
		const queueConfig = queues as Record<string, unknown>
		const producers = queueConfig.producers
		const consumers = queueConfig.consumers
		if (!Array.isArray(producers) || !Array.isArray(consumers)) {
			fail(
				`wrangler config "${baseConfigPath}" has invalid "env.${envName}.queues".`,
			)
		}
		for (const binding of queueBindings) {
			const producer = producers.find(
				(entry) =>
					entry &&
					typeof entry === 'object' &&
					!Array.isArray(entry) &&
					(entry as Record<string, unknown>).binding === binding.binding,
			) as Record<string, unknown> | undefined
			if (!producer || typeof producer.queue !== 'string') {
				fail(
					`wrangler config "${baseConfigPath}" has no ${envName} Queue producer for "${binding.binding}".`,
				)
			}
			const configuredQueue = producer.queue
			const consumer = consumers.find(
				(entry) =>
					entry &&
					typeof entry === 'object' &&
					!Array.isArray(entry) &&
					(entry as Record<string, unknown>).queue === configuredQueue,
			) as Record<string, unknown> | undefined
			if (!consumer) {
				fail(
					`wrangler config "${baseConfigPath}" has no ${envName} Queue consumer for "${configuredQueue}".`,
				)
			}
			producer.queue = binding.queue
			consumer.queue = binding.queue
			consumer.dead_letter_queue = binding.deadLetterQueue
		}
	}

	if (serviceBindings && serviceBindings.length > 0) {
		const services = (targetEnv as Record<string, unknown>).services
		if (!Array.isArray(services)) {
			fail(
				`wrangler config "${baseConfigPath}" is missing "env.${envName}.services".`,
			)
		}
		for (const override of serviceBindings) {
			const entry = services.find(
				(candidate) =>
					candidate &&
					typeof candidate === 'object' &&
					!Array.isArray(candidate) &&
					(candidate as Record<string, unknown>).binding === override.binding,
			) as Record<string, unknown> | undefined
			if (!entry) {
				fail(
					`wrangler config "${baseConfigPath}" has no ${envName} service binding for "${override.binding}".`,
				)
			}
			entry.service = override.service
		}
	}

	addPackageAppCustomDomainRoute({
		targetEnv: targetEnv as Record<string, unknown>,
		resolvedVars,
		baseConfigPath,
		envName,
	})

	const migrations = config.migrations
	if (extraMigrations && extraMigrations.length > 0) {
		if (!Array.isArray(migrations)) {
			fail(
				`wrangler config "${baseConfigPath}" is missing top-level "migrations".`,
			)
		}

		const migrationList = migrations as Array<Record<string, unknown>>
		for (const extraMigration of extraMigrations) {
			const alreadyExists = migrationList.some((migration) => {
				return migration.tag === extraMigration.tag
			})
			if (!alreadyExists) {
				migrationList.push(extraMigration)
			}
		}
		sortWranglerMigrations(migrationList)
	}

	// Preview publishes no custom-domain routes, so the earlier route helper
	// never sets this. `wrangler secret bulk` still reapplies the generated
	// config after deploy; omitting `workers_dev` drops the
	// `<name>.<subdomain>.workers.dev` trigger and Cloudflare answers that
	// hostname with error 1042.
	;(targetEnv as Record<string, unknown>).workers_dev = true

	const resolvedOut = path.resolve(outConfigPath)
	await writeFile(
		resolvedOut,
		`${JSON.stringify(config, null, '\t')}\n`,
		'utf8',
	)
	console.error(`Wrote generated Wrangler config: ${resolvedOut}`)
	return resolvedOut
}
