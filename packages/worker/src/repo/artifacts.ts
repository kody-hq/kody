import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	CloudflareApiError,
	CloudflareRestClient,
	createCloudflareRestClient,
} from '#mcp/cloudflare/cloudflare-rest-client.ts'
import { createArtifactsGitHttp } from './artifacts-git-http.ts'
import {
	runArtifactsGitWithRetry,
	wrapArtifactsGitHttpError,
} from './artifacts-git-retry.ts'
import { type EntityKind } from './types.ts'
import { loadIsomorphicGit } from './isomorphic-git-lazy.ts'

export type ArtifactToken = {
	id: string
	plaintext: string
	scope: string
	expiresAt: string
}

export type ArtifactStoredToken = {
	id: string
	scope: string
	expiresAt: string
	createdAt?: string | null
}

export type ArtifactBootstrapAccess = {
	defaultBranch: string
	remote: string
	token: string
	expiresAt: string
}

export type ArtifactRepoReadyResult =
	| { recreated: false; repo: ArtifactRepoHandle }
	| {
			recreated: true
			bootstrapAccess: ArtifactBootstrapAccess
			repo: ArtifactRepoHandle
	  }

export type ArtifactRepoInfo = {
	id: string
	name: string
	description: string | null
	defaultBranch: string
	createdAt: string
	updatedAt: string
	lastPushAt: string | null
	source: string | null
	readOnly: boolean
	remote: string
}

export type ArtifactRepoHandle = {
	info(): Promise<ArtifactRepoInfo | null>
	createToken(scope?: 'write' | 'read', ttl?: number): Promise<ArtifactToken>
	listTokens?(): Promise<Array<ArtifactStoredToken>>
	revokeToken?(idOrPlaintext: string): Promise<void>
}

export type ArtifactGetRepoResult =
	| { status: 'ready'; repo: ArtifactRepoHandle }
	| { status: 'not_found' }
	| { status: 'importing'; retryAfter: number }

export type ArtifactDeleteRepoResult = {
	id: string | null
	alreadyDeleted: boolean
}

export type ArtifactCreateRepoResult = {
	id: string
	name: string
	description: string | null
	defaultBranch: string
	remote: string
	token: string
	expiresAt: string
}

export type ArtifactForkRepoOpts = {
	description?: string
	readOnly?: boolean
	defaultBranchOnly?: boolean
}

export type ArtifactNamespaceBinding = {
	create(
		name: string,
		opts?: {
			description?: string
			readOnly?: boolean
			setDefaultBranch?: string
		},
	): Promise<ArtifactCreateRepoResult>
	/**
	 * Copy `sourceName` to `targetName` at the Artifacts storage layer.
	 * Blobs stay in the git object store — callers must not materialize the
	 * tree in a Worker or Durable Object isolate.
	 */
	fork(
		sourceName: string,
		targetName: string,
		opts?: ArtifactForkRepoOpts,
	): Promise<ArtifactCreateRepoResult>
	get(name: string): Promise<ArtifactGetRepoResult>
	delete(name: string): Promise<ArtifactDeleteRepoResult>
	list(opts?: { limit?: number; cursor?: string }): Promise<{
		repos: Array<Omit<ArtifactRepoInfo, 'remote'>>
		total: number
		cursor?: string
	}>
	/** Local handle for `name`. Does not fetch; `info` / tokens hit the API later. */
	repo(name: string): ArtifactRepoHandle
}

export function resolveArtifactsNamespace(env: Env, namespace?: string | null) {
	const trimmed = namespace?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : getArtifactsNamespace(env)
}

function readNativeArtifactsBinding(env: Env): Artifacts | null {
	const binding = env.ARTIFACTS
	if (!binding || typeof binding.create !== 'function') return null
	return binding
}

export function getArtifactsBinding(
	env: Env,
	namespace?: string | null,
): ArtifactNamespaceBinding & Record<string, unknown> {
	const requestedNamespace = resolveArtifactsNamespace(env, namespace)
	const native = readNativeArtifactsBinding(env)
	if (native && requestedNamespace === getArtifactsNamespace(env)) {
		return adaptNativeArtifactsBinding(native, env)
	}
	const restBinding = createArtifactsRestBinding(env, requestedNamespace)
	if (!restBinding) {
		throw new Error(
			'Cloudflare Artifacts access requires the ARTIFACTS binding or CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.',
		)
	}
	return restBinding
}

export function hasArtifactsAccess(env: Env) {
	try {
		void getArtifactsBinding(env)
		return true
	} catch {
		return false
	}
}

export function getArtifactsNamespace(env: Env) {
	const configured = env.ARTIFACTS_NAMESPACE?.trim()
	return configured && configured.length > 0 ? configured : 'default'
}

type ArtifactApiEnvelope<T> = {
	result: T | null
	success: boolean
	errors: Array<{
		code: number
		message: string
	}>
	messages: Array<{
		code: number
		message: string
	}>
	result_info?: {
		cursor?: string
		count?: number
		total_count?: number
	}
}

type ArtifactRestRepoInfo = {
	id: string
	name: string
	description: string | null
	default_branch: string
	created_at: string
	updated_at: string
	last_push_at: string | null
	source: string | null
	read_only: boolean
	remote: string
}

type ArtifactRestCreateRepoResult = {
	id: string
	name: string
	description: string | null
	default_branch: string
	remote: string
	token: string
}

type ArtifactRestCreateTokenResult = {
	id: string
	plaintext: string
	scope: string
	expires_at: string
}

type ArtifactRestStoredToken = {
	id: string
	scope: string
	expires_at: string
	created_at?: string | null
}

function isArtifactsBindingError(error: unknown): error is ArtifactsError {
	// Binding errors may not pass `instanceof Error` across the JSRPC
	// boundary. Match the documented `{ name, code }` shape only.
	if (error === null || typeof error !== 'object') return false
	const candidate = error as { name?: unknown; code?: unknown }
	return (
		candidate.name === 'ArtifactsError' && typeof candidate.code === 'string'
	)
}

function readArtifactsErrorMessage(error: unknown) {
	if (typeof error === 'string') return error
	if (error instanceof Error) return error.message
	if (
		error !== null &&
		typeof error === 'object' &&
		'message' in error &&
		typeof error.message === 'string'
	) {
		return error.message
	}
	return ''
}

export function artifactsBindingErrorCode(error: unknown) {
	if (isArtifactsBindingError(error)) return error.code
	// JSRPC may flatten the class so `name` is Error and the message is
	// `ArtifactsError: Repository not found: <repo>`. Strip that prefix,
	// then require the known create-safe starts.
	const message = readArtifactsErrorMessage(error).replace(
		/^ArtifactsError:\s*/,
		'',
	)
	if (/^Repository not found(?::|\b)/.test(message)) return 'NOT_FOUND'
	if (/^Repository already exists(?::|\b)/.test(message)) {
		return 'ALREADY_EXISTS'
	}
	if (/^Import in progress(?::|\b)/i.test(message)) {
		return 'IMPORT_IN_PROGRESS'
	}
	if (/^Fork in progress(?::|\b)/i.test(message)) {
		return 'FORK_IN_PROGRESS'
	}
	if (/^Memory limit(?::|\b)/i.test(message)) {
		return 'MEMORY_LIMIT'
	}
	return null
}

async function getNativeRepoOrThrow(native: Artifacts, name: string) {
	try {
		return await native.get(name)
	} catch (error) {
		const code = artifactsBindingErrorCode(error)
		if (code === 'NOT_FOUND') {
			throw new Error(`Artifacts repo "${name}" was not found.`, {
				cause: error,
			})
		}
		throw error
	}
}

function adaptNativeRepoHandle(
	repo: ArtifactsRepo,
	restRepo?: ArtifactRepoHandle,
): ArtifactRepoHandle {
	return {
		info: async () => {
			if (restRepo) {
				const info = await restRepo.info()
				if (info?.remote) return info
			}
			// workerd exposes repo metadata from info(), not as properties on
			// the capability stub.
			return await repo.info()
		},
		createToken: async (scope = 'write', ttl = 3600) => {
			// Native createToken still throws `undefined.split` across JSRPC
			// after mapping plaintext/token. Mint via REST when credentials
			// exist — that path worked before #1437 preferred the binding.
			if (restRepo) {
				return restRepo.createToken(scope, ttl)
			}
			try {
				const token = await repo.createToken(scope, ttl)
				const plaintext = readArtifactTokenPlaintext(token)
				return {
					id: token.id,
					plaintext,
					scope: token.scope,
					expiresAt: resolveCreatedTokenExpiry({
						token: plaintext,
						tokenExpiresAt:
							typeof token.expiresAt === 'string' ? token.expiresAt : null,
					}),
				}
			} catch (error) {
				throw new Error(
					`Artifacts native createToken failed: ${getErrorMessage(error)}`,
					{ cause: error },
				)
			}
		},
		listTokens: async () => {
			const listed = await repo.listTokens()
			return listed.tokens.map((token) => ({
				id: token.id,
				scope: token.scope,
				expiresAt: token.expiresAt,
				createdAt: token.createdAt,
			}))
		},
		revokeToken: async (idOrPlaintext) => {
			await repo.revokeToken(idOrPlaintext)
		},
	}
}

function adaptNativeArtifactsBinding(
	native: Artifacts,
	env: Env,
): ArtifactNamespaceBinding & Record<string, unknown> {
	const rest = createArtifactsRestBinding(env, getArtifactsNamespace(env))
	const repo = (name: string): ArtifactRepoHandle => ({
		info: async () => {
			const handle = await getNativeRepoOrThrow(native, name)
			return adaptNativeRepoHandle(handle, rest?.repo(name)).info()
		},
		createToken: async (scope = 'write', ttl = 3600) => {
			if (rest) {
				return rest.repo(name).createToken(scope, ttl)
			}
			const handle = await getNativeRepoOrThrow(native, name)
			return adaptNativeRepoHandle(handle).createToken(scope, ttl)
		},
		listTokens: async () => {
			const handle = await getNativeRepoOrThrow(native, name)
			return (
				adaptNativeRepoHandle(handle, rest?.repo(name)).listTokens?.() ?? []
			)
		},
		revokeToken: async (idOrPlaintext) => {
			const handle = await getNativeRepoOrThrow(native, name)
			await adaptNativeRepoHandle(handle, rest?.repo(name)).revokeToken?.(
				idOrPlaintext,
			)
		},
	})
	return {
		create: async (name, opts) => {
			const created = await native.create(name, opts)
			return {
				id: created.id,
				name: created.name,
				description: created.description,
				defaultBranch: created.defaultBranch,
				remote: created.remote,
				token: created.token,
				expiresAt: resolveCreatedTokenExpiry({
					token: created.token,
					tokenExpiresAt: readOptionalTokenExpiresAt(created),
				}),
			}
		},
		get: async (name) => {
			try {
				const handle = await native.get(name)
				return {
					status: 'ready' as const,
					repo: adaptNativeRepoHandle(handle, rest?.repo(name)),
				}
			} catch (error) {
				const code = artifactsBindingErrorCode(error)
				if (code === 'NOT_FOUND') {
					return { status: 'not_found' as const }
				}
				if (code === 'IMPORT_IN_PROGRESS' || code === 'FORK_IN_PROGRESS') {
					return { status: 'importing' as const, retryAfter: 5 }
				}
				throw error
			}
		},
		fork: async (sourceName, targetName, opts) => {
			if (rest) {
				return await rest.fork(sourceName, targetName, opts)
			}
			const handle = await getNativeRepoOrThrow(native, sourceName)
			if (typeof handle.fork !== 'function') {
				throw new Error(
					'Artifacts native fork is unavailable and no REST credentials are configured.',
				)
			}
			const created = await handle.fork(targetName, {
				...(opts?.description !== undefined
					? { description: opts.description }
					: {}),
				...(opts?.readOnly !== undefined ? { readOnly: opts.readOnly } : {}),
				...(opts?.defaultBranchOnly !== undefined
					? { defaultBranchOnly: opts.defaultBranchOnly }
					: {}),
			})
			return {
				id: created.id,
				name: created.name,
				description: created.description,
				defaultBranch: created.defaultBranch,
				remote: created.remote,
				token: created.token,
				expiresAt: resolveCreatedTokenExpiry({
					token: created.token,
					tokenExpiresAt: readOptionalTokenExpiresAt(created),
				}),
			}
		},
		delete: async (name) => {
			const deleted = await native.delete(name)
			return {
				id: null,
				alreadyDeleted: !deleted,
			}
		},
		list: async (opts) => await native.list(opts),
		repo,
	}
}

/**
 * True when unset (Worker default) or the hostname is api.cloudflare.com
 * (any scheme/casing). Local mocks use loopback or preview mock hosts.
 */
function isCloudflareProductionApiBase(baseUrl: string | undefined) {
	const configured = baseUrl?.trim()
	if (!configured) return true
	try {
		return new URL(configured).hostname.toLowerCase() === 'api.cloudflare.com'
	} catch {
		return false
	}
}

/**
 * Local vite serve drops the always-remote ARTIFACTS binding so packageSave
 * can use mock REST. Refuse the production Cloudflare API host in that mode
 * so a `dev:vite` / SKIP_CLOUDFLARE_MOCK run with live tokens cannot write
 * the production Artifacts namespace (including http:// or casing variants).
 */
function assertLocalArtifactsRestUsesMock(env: Env, native: Artifacts | null) {
	if (env.WRANGLER_IS_LOCAL_DEV !== 'true') return
	if (native) return
	if (!isCloudflareProductionApiBase(env.CLOUDFLARE_API_BASE_URL)) return
	throw new Error(
		'Local Artifacts REST refuses api.cloudflare.com (and the production namespace). Run `npm run dev` so the Cloudflare mock sets CLOUDFLARE_API_BASE_URL, or point CLOUDFLARE_API_BASE_URL at a mock. Do not use live Cloudflare credentials for local packageSave.',
	)
}

function createArtifactsRestBinding(env: Env, namespace: string) {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const artifactsApiToken = env.CLOUDFLARE_ARTIFACTS_API_TOKEN?.trim()
	const apiToken = artifactsApiToken || env.CLOUDFLARE_API_TOKEN?.trim()
	if (!accountId || !apiToken) {
		return null
	}
	// When the Worker binds real Artifacts (production/preview), createToken
	// and fork mint via REST. Preview also sets CLOUDFLARE_API_BASE_URL to a
	// per-PR mock for email/analytics — that mock does not hold the binding's
	// repos, so create vs restore disagreed (#2749). Prefer the real Cloudflare
	// API whenever the native binding is present, using CLOUDFLARE_ARTIFACTS_API_TOKEN
	// when the shared CLOUDFLARE_API_TOKEN is the mock credential.
	const native = readNativeArtifactsBinding(env)
	assertLocalArtifactsRestUsesMock(env, native)
	const configuredBaseUrl = env.CLOUDFLARE_API_BASE_URL?.trim()
	const usingNonDefaultApiBase = Boolean(
		configuredBaseUrl && !isCloudflareProductionApiBase(configuredBaseUrl),
	)
	const client =
		native && usingNonDefaultApiBase
			? artifactsApiToken
				? new CloudflareRestClient({
						apiToken: artifactsApiToken,
						baseUrl: 'https://api.cloudflare.com',
					})
				: null
			: createCloudflareRestClient(env)
	if (!client) {
		return null
	}
	const basePath = `/client/v4/accounts/${accountId}/artifacts/namespaces/${namespace}`
	const getRepoInfo = async (
		name: string,
	): Promise<ArtifactRepoInfo | null> => {
		const response = await requestArtifactsEnvelope<ArtifactRestRepoInfo>(
			client,
			{
				method: 'GET',
				path: `${basePath}/repos/${encodeURIComponent(name)}`,
				treat404AsNull: true,
			},
		)
		return response.result ? normalizeArtifactRepoInfo(response.result) : null
	}
	const repoHandle = (name: string): ArtifactRepoHandle => ({
		info: async () => await getRepoInfo(name),
		createToken: async (scope = 'write', ttl = 3600) => {
			const result = await requestArtifactsApi<ArtifactRestCreateTokenResult>(
				client,
				{
					method: 'POST',
					path: `${basePath}/tokens`,
					body: {
						repo: name,
						scope,
						ttl,
					},
				},
			)
			const plaintext = readArtifactTokenPlaintext(result)
			return {
				id: result.id,
				plaintext,
				scope: result.scope,
				expiresAt: result.expires_at,
			}
		},
		listTokens: async () => {
			const envelope = await requestArtifactsEnvelope<
				Array<ArtifactRestStoredToken>
			>(client, {
				method: 'GET',
				path: `${basePath}/tokens`,
				query: {
					repo: name,
				},
			})
			return (envelope.result ?? []).map((token) => ({
				id: token.id,
				scope: token.scope,
				expiresAt: token.expires_at,
				createdAt: token.created_at ?? null,
			}))
		},
		revokeToken: async (idOrPlaintext) => {
			await requestArtifactsEnvelope(client, {
				method: 'DELETE',
				path: `${basePath}/tokens/${encodeURIComponent(idOrPlaintext)}`,
			})
		},
	})
	return {
		create: async (name, opts) => {
			const result = await requestArtifactsApi<ArtifactRestCreateRepoResult>(
				client,
				{
					method: 'POST',
					path: `${basePath}/repos`,
					body: {
						name,
						...(opts?.description ? { description: opts.description } : {}),
						...(opts?.setDefaultBranch
							? { default_branch: opts.setDefaultBranch }
							: {}),
						...(opts?.readOnly !== undefined
							? { read_only: opts.readOnly }
							: {}),
					},
				},
			)
			return {
				id: result.id,
				name: result.name,
				description: result.description,
				defaultBranch: result.default_branch,
				remote: result.remote,
				token: result.token,
				expiresAt: parseArtifactTokenExpiry(result.token),
			}
		},
		get: async (name) => {
			const info = await getRepoInfo(name)
			if (!info) {
				return { status: 'not_found' as const }
			}
			return {
				status: 'ready' as const,
				repo: repoHandle(name),
			}
		},
		fork: async (sourceName, targetName, opts) => {
			const result = await requestArtifactsApi<ArtifactRestCreateRepoResult>(
				client,
				{
					method: 'POST',
					path: `${basePath}/repos/${encodeURIComponent(sourceName)}/fork`,
					body: {
						name: targetName,
						...(opts?.description ? { description: opts.description } : {}),
						...(opts?.readOnly !== undefined
							? { read_only: opts.readOnly }
							: {}),
						...(opts?.defaultBranchOnly !== undefined
							? { default_branch_only: opts.defaultBranchOnly }
							: {}),
					},
				},
			)
			return {
				id: result.id,
				name: result.name,
				description: result.description,
				defaultBranch: result.default_branch,
				remote: result.remote,
				token: result.token,
				expiresAt: parseArtifactTokenExpiry(result.token),
			}
		},
		delete: async (name) => {
			const envelope = await requestArtifactsEnvelope<{ id: string }>(client, {
				method: 'DELETE',
				path: `${basePath}/repos/${encodeURIComponent(name)}`,
				treat404AsNull: true,
			})
			if (!envelope.result) {
				return {
					id: null,
					alreadyDeleted: true,
				}
			}
			return {
				id: envelope.result.id,
				alreadyDeleted: false,
			}
		},
		list: async (opts) => {
			const query: Record<string, string> = {}
			if (opts?.limit !== undefined) {
				query['limit'] = String(opts.limit)
			}
			if (opts?.cursor) {
				query['cursor'] = opts.cursor
			}
			const envelope = await requestArtifactsEnvelope<
				Array<ArtifactRestRepoInfo>
			>(client, {
				method: 'GET',
				path: `${basePath}/repos`,
				query,
			})
			const repos = (envelope.result ?? []).map((repo) => {
				const normalized = normalizeArtifactRepoInfo(repo)
				return {
					id: normalized.id,
					name: normalized.name,
					description: normalized.description,
					defaultBranch: normalized.defaultBranch,
					createdAt: normalized.createdAt,
					updatedAt: normalized.updatedAt,
					lastPushAt: normalized.lastPushAt,
					source: normalized.source,
					readOnly: normalized.readOnly,
				}
			})
			return {
				repos,
				total: envelope.result_info?.total_count ?? repos.length,
				cursor: envelope.result_info?.cursor,
			}
		},
		repo: (name) => repoHandle(name),
	} satisfies ArtifactNamespaceBinding & Record<string, unknown>
}

function redactArtifactsRestPath(path: string) {
	return path.replace(/\/tokens\/[^/?#]+/g, '/tokens/:token')
}

export async function requestArtifactsApi<T>(
	client: ReturnType<typeof createCloudflareRestClient>,
	input: {
		method: 'GET' | 'POST' | 'DELETE'
		path: string
		query?: Record<string, string>
		body?: unknown
		treat404AsNull?: boolean
	},
) {
	const envelope = await requestArtifactsEnvelope<T>(client, input)
	if (envelope.result == null) {
		throw new Error(`Artifacts API returned no result for ${input.path}.`)
	}
	return envelope.result
}

export async function requestArtifactsEnvelope<T>(
	client: ReturnType<typeof createCloudflareRestClient>,
	input: {
		method: 'GET' | 'POST' | 'DELETE'
		path: string
		query?: Record<string, string>
		body?: unknown
		treat404AsNull?: boolean
	},
) {
	try {
		const response = await client.rawRequest({
			method: input.method,
			path: input.path,
			query: input.query,
			body: input.body,
		})
		if (response.cfRay) {
			console.info('artifacts-rest', {
				method: input.method,
				path: redactArtifactsRestPath(input.path),
				status: response.status,
				cfRay: response.cfRay,
			})
		}
		const envelope = response.body as ArtifactApiEnvelope<T> | null
		if (!envelope?.success) {
			const primaryError = envelope?.errors?.[0]
			const message =
				primaryError?.message ??
				`Artifacts API request failed (${response.status}).`
			if (input.treat404AsNull && response.status === 404) {
				return {
					result: null,
					success: true,
					errors: [],
					messages: [],
				} satisfies ArtifactApiEnvelope<T>
			}
			throw new Error(
				message,
				primaryError ? { cause: primaryError } : undefined,
			)
		}
		return envelope
	} catch (error) {
		if (
			input.treat404AsNull &&
			error instanceof CloudflareApiError &&
			error.status === 404
		) {
			return {
				result: null,
				success: true,
				errors: [],
				messages: [],
			} satisfies ArtifactApiEnvelope<T>
		}
		throw error
	}
}

function normalizeArtifactRepoInfo(
	repo: ArtifactRestRepoInfo,
): ArtifactRepoInfo {
	return {
		id: repo.id,
		name: repo.name,
		description: repo.description,
		defaultBranch: repo.default_branch,
		createdAt: repo.created_at,
		updatedAt: repo.updated_at,
		lastPushAt: repo.last_push_at,
		source: repo.source,
		readOnly: repo.read_only,
		remote: repo.remote,
	}
}

function parseArtifactTokenExpiry(token: string) {
	const expiresAt = tryParseArtifactTokenExpiry(token)
	if (expiresAt) return expiresAt
	throw new Error('Artifacts token is missing a parseable expires timestamp.')
}

function tryParseArtifactTokenExpiry(token: string) {
	const expiresAtSeconds = Number.parseInt(
		token.split('?expires=')[1] ?? '',
		10,
	)
	if (Number.isFinite(expiresAtSeconds)) {
		return new Date(expiresAtSeconds * 1000).toISOString()
	}
	return null
}

function readArtifactTokenPlaintext(token: {
	plaintext?: unknown
	token?: unknown
}) {
	if (typeof token.plaintext === 'string' && token.plaintext.length > 0) {
		return token.plaintext
	}
	// Native create() uses `token`; createToken is typed as `plaintext`.
	// JSRPC can drop one or the other the same way it dropped
	// `tokenExpiresAt`. Accept either so git remotes do not call
	// `undefined.split`.
	if (typeof token.token === 'string' && token.token.length > 0) {
		return token.token
	}
	throw new Error('Artifacts createToken result is missing plaintext.')
}

function readOptionalTokenExpiresAt(created: object) {
	if (!('tokenExpiresAt' in created)) return null
	return typeof created.tokenExpiresAt === 'string'
		? created.tokenExpiresAt
		: null
}

function resolveCreatedTokenExpiry(input: {
	token: string
	tokenExpiresAt?: string | null
}) {
	const fromBinding = input.tokenExpiresAt?.trim()
	if (fromBinding) return fromBinding
	return tryParseArtifactTokenExpiry(input.token) ?? ''
}

function normalizeRepoNamePart(value: string) {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
}

function trimRepoName(value: string) {
	return value.slice(0, 63).replace(/-+$/g, '')
}

export function buildEntityRepoId(input: {
	entityKind: EntityKind
	entityId: string
}) {
	return trimRepoName(
		normalizeRepoNamePart(`${input.entityKind}-${input.entityId}`),
	)
}

export function buildSessionRepoId(input: {
	entityKind: EntityKind
	entityId: string
	sessionId: string
}) {
	return trimRepoName(
		normalizeRepoNamePart(
			`${input.entityKind}-${input.entityId}-session-${input.sessionId}`,
		),
	)
}

export function parseArtifactTokenSecret(token: string) {
	if (typeof token !== 'string' || token.length === 0) {
		throw new Error('Artifacts token plaintext is missing.')
	}
	return token.split('?expires=')[0] ?? token
}

export function buildArtifactsGitAuth(input: { token: string }) {
	return {
		username: 'x',
		password: parseArtifactTokenSecret(input.token),
	}
}

export function buildAuthenticatedArtifactsRemote(input: {
	remote: string
	token: string
}) {
	const remoteUrl = new URL(input.remote)
	const isLoopbackHost = isLoopbackHostname(remoteUrl.hostname)
	const isAllowedProtocol =
		remoteUrl.protocol === 'https:' ||
		(remoteUrl.protocol === 'http:' && isLoopbackHost)
	if (!isAllowedProtocol) {
		throw new Error(`Artifact remote must use https://, got: ${input.remote}`)
	}
	const auth = buildArtifactsGitAuth({ token: input.token })
	remoteUrl.username = auth.username
	remoteUrl.password = auth.password
	return remoteUrl.toString()
}

export async function listArtifactServerRefs(input: {
	remote: string
	token: string
	prefix?: string
}) {
	// Embed credentials in the URL so the first info/refs request is
	// authenticated. onAuth only runs after 401; Artifacts can fail earlier.
	const url = buildAuthenticatedArtifactsRemote({
		remote: input.remote,
		token: input.token,
	})
	const { git } = await loadIsomorphicGit()
	// Protocol v2 follows info/refs with an ls-refs POST. Clone and push
	// already use protocol v1, which returns the ref list in that single
	// advertisement. The extra POST can stall with no HTTP status, and
	// package repos are small enough that client-side prefix filtering is
	// enough. The bounded HTTP client aborts a stalled advertisement so
	// retries can finish inside a normal MCP tool timeout.
	return runArtifactsGitWithRetry(() =>
		git.listServerRefs({
			http: createArtifactsGitHttp(),
			url,
			prefix: input.prefix,
			symrefs: true,
			protocolVersion: 1,
		}),
	)
}

export async function resolveArtifactDefaultBranchHead(input: {
	repo: ArtifactRepoHandle
	token?: string
	info?: ArtifactRepoInfo | null
}) {
	const [info, tokenPlaintext] = await Promise.all([
		input.info === undefined ? input.repo.info() : Promise.resolve(input.info),
		input.token !== undefined
			? Promise.resolve(input.token)
			: input.repo.createToken('read', 300).then((token) => token.plaintext),
	])
	if (!info?.remote) {
		throw new Error('Artifact repo remote URL is unavailable.')
	}
	if (typeof tokenPlaintext !== 'string' || tokenPlaintext.length === 0) {
		throw new Error('Artifacts createToken result is missing plaintext.')
	}
	const refName = `refs/heads/${info.defaultBranch || 'main'}`
	let refs: Awaited<ReturnType<typeof listArtifactServerRefs>>
	try {
		refs = await listArtifactServerRefs({
			remote: info.remote,
			token: tokenPlaintext,
			prefix: refName,
		})
	} catch (error) {
		throw wrapArtifactsGitHttpError({
			operation: 'listServerRefs',
			remote: info.remote,
			error,
		})
	}
	const branchRef = refs.find((ref) => ref.ref === refName)
	if (!branchRef?.oid) {
		return null
	}
	return {
		remote: info.remote,
		defaultBranch: info.defaultBranch || 'main',
		commit: branchRef.oid,
	}
}

export function isLoopbackHostname(hostname: string) {
	return (
		hostname === 'localhost' ||
		hostname === '127.0.0.1' ||
		hostname === '[::1]' ||
		hostname === '::1'
	)
}

export function isLoopbackArtifactsRemote(remote: string) {
	try {
		const url = new URL(remote)
		return url.protocol === 'http:' && isLoopbackHostname(url.hostname)
	} catch {
		return false
	}
}

export function isArtifactRepoNotFoundError(error: unknown) {
	if (artifactsBindingErrorCode(error) === 'NOT_FOUND') {
		return true
	}
	if (!(error instanceof Error)) {
		return false
	}
	return /^(?:Artifacts repo "[^"]+" was not found\.?|Repo(?:sitory)? not found\b)/i.test(
		error.message,
	)
}

function isArtifactRepoAlreadyExistsError(error: unknown) {
	if (artifactsBindingErrorCode(error) === 'ALREADY_EXISTS') {
		return true
	}
	if (!(error instanceof Error)) {
		return false
	}
	const text = error.message
	const cause = error.cause
	const causeMessage =
		cause && typeof cause === 'object' && 'message' in cause
			? String(cause.message)
			: ''
	const causeCode =
		cause && typeof cause === 'object' && 'code' in cause
			? Number(cause.code)
			: null
	return (
		causeCode === 10201 ||
		/already[\s_-]*exists|already_exists/i.test(`${text} ${causeMessage}`)
	)
}

function waitForArtifactRepoCheck(delayMs: number) {
	return new Promise((resolve) => setTimeout(resolve, delayMs))
}

async function waitForArtifactRepoReadyAfterCreateConflict(input: {
	binding: ArtifactNamespaceBinding
	repoId: string
	maxAttempts?: number
	delayMs?: number
}): Promise<ArtifactRepoReadyResult> {
	// Cloudflare can return ALREADY_EXISTS from create while get still reports
	// not_found (post-delete ghost reservation, or fork provision lag). Retry
	// create when get stays absent so callers that need bootstrapAccess (community
	// fork fallback) are not stuck with a permanent not_found conflict.
	const maxAttempts = input.maxAttempts ?? 10
	const delayMs = input.delayMs ?? 100
	let lastStatus = 'not_found'
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const result = await input.binding.get(input.repoId)
		if (result.status === 'ready') {
			return { recreated: false, repo: result.repo }
		}
		lastStatus = result.status
		if (result.status === 'importing') {
			throw new Error(
				`Artifacts repo "${input.repoId}" is importing. Retry after ${result.retryAfter}s.`,
			)
		}
		if (result.status === 'not_found') {
			try {
				const created = await input.binding.create(input.repoId, {
					readOnly: false,
				})
				return {
					recreated: true,
					bootstrapAccess: {
						defaultBranch: created.defaultBranch,
						remote: created.remote,
						token: created.token,
						expiresAt: created.expiresAt,
					},
					repo: input.binding.repo(created.name),
				}
			} catch (error) {
				if (!isArtifactRepoAlreadyExistsError(error)) {
					throw error
				}
			}
		}
		if (attempt < maxAttempts) {
			await waitForArtifactRepoCheck(delayMs)
		}
	}
	throw new Error(
		`Artifacts repo "${input.repoId}" is ${lastStatus} after create conflict.`,
	)
}

export async function ensureArtifactRepoReady(
	env: Env,
	repoId: string,
	binding: ArtifactNamespaceBinding = getArtifactsBinding(env),
): Promise<ArtifactRepoReadyResult> {
	const existing = await binding.get(repoId)
	if (existing.status === 'ready') {
		return { recreated: false, repo: existing.repo }
	}
	if (existing.status === 'importing') {
		throw new Error(
			`Artifacts repo "${repoId}" is importing. Retry after ${existing.retryAfter}s.`,
		)
	}
	let created: Awaited<ReturnType<ArtifactNamespaceBinding['create']>>
	try {
		created = await binding.create(repoId, { readOnly: false })
	} catch (error) {
		if (isArtifactRepoAlreadyExistsError(error)) {
			return await waitForArtifactRepoReadyAfterCreateConflict({
				binding,
				repoId,
			})
		}
		throw error
	}
	const bootstrapAccess = {
		defaultBranch: created.defaultBranch,
		remote: created.remote,
		token: created.token,
		expiresAt: created.expiresAt,
	}
	return {
		recreated: true,
		bootstrapAccess,
		repo: binding.repo(created.name),
	}
}

export async function resolveArtifactSourceRepo(env: Env, repoId: string) {
	const binding = getArtifactsBinding(env)
	const result = await ensureArtifactRepoReady(env, repoId, binding)
	return result.repo
}

export async function resolveExistingArtifactSourceRepo(
	env: Env,
	repoId: string,
	binding: ArtifactNamespaceBinding = getArtifactsBinding(env),
) {
	const result = await binding.get(repoId)
	if (result.status === 'ready') {
		return result.repo
	}
	if (result.status === 'not_found') {
		return null
	}
	throw new Error(
		`Artifacts repo "${repoId}" is ${result.status}. Retry after ${result.retryAfter}s.`,
	)
}

export async function resolveArtifactSourceHead(env: Env, repoId: string) {
	const repo = await resolveExistingArtifactSourceRepo(env, repoId)
	if (!repo) {
		return {
			branch: 'main',
			commit: null,
		}
	}
	const ref = await resolveArtifactDefaultBranchHead({ repo })
	return {
		branch: ref?.defaultBranch ?? 'main',
		commit: ref?.commit ?? null,
	}
}
