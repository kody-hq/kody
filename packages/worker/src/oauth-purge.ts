import { DurableObject } from 'cloudflare:workers'

const oauthPurgeBatchSize = 50
const oauthPurgeKeyConcurrency = 8
/**
 * Each run stops starting new KV work after this long and saves what it
 * finished. Slow KV windows then cost a few runs instead of one run that
 * never saves its progress.
 */
const oauthPurgeRunBudgetMs = 10_000
export const oauthPurgeContinuationStorageKey = 'continuation'

type PurgePhase = 'grants' | 'tokens'

type PendingGrantRevocation = {
	grantKey: string
	tokenPrefix: string
	tokenCursor?: string
}

type PendingGrantPage = {
	complete: boolean
	nextCursor?: string
	revocations: Array<PendingGrantRevocation>
	unscannedKeys?: Array<string>
}

type PendingTokenPage = {
	complete: boolean
	nextCursor?: string
	unscannedKeys: Array<string>
}

export type PurgeContinuation = {
	version: 1
	nextPhase: PurgePhase
	grantCursor?: string
	tokenCursor?: string
	pendingGrantPage?: PendingGrantPage
	pendingTokenPage?: PendingTokenPage
}

type GrantRecord = {
	clientId: string
	expiresAt?: number
}

type TokenRecord = {
	grantId: string
	userId: string
}

export type OAuthPurgeResult = {
	phase: PurgePhase
	checked: number
	grantsPurged: number
	tokensPurged: number
	phaseComplete: boolean
	budgetExhausted: boolean
}

function isPurgePhase(value: unknown): value is PurgePhase {
	return value === 'grants' || value === 'tokens'
}

function isPendingGrantRevocation(
	value: unknown,
): value is PendingGrantRevocation {
	return (
		typeof value === 'object' &&
		value !== null &&
		'grantKey' in value &&
		typeof value.grantKey === 'string' &&
		'tokenPrefix' in value &&
		typeof value.tokenPrefix === 'string' &&
		(!('tokenCursor' in value) ||
			value.tokenCursor === undefined ||
			typeof value.tokenCursor === 'string')
	)
}

function isStringArray(value: unknown): value is Array<string> {
	return (
		Array.isArray(value) && value.every((entry) => typeof entry === 'string')
	)
}

function parsePendingPageCursor(value: object) {
	if (!('complete' in value) || typeof value.complete !== 'boolean') {
		return undefined
	}
	const nextCursor =
		'nextCursor' in value && typeof value.nextCursor === 'string'
			? value.nextCursor
			: undefined
	const unscannedKeys =
		'unscannedKeys' in value && isStringArray(value.unscannedKeys)
			? value.unscannedKeys
			: undefined
	return { complete: value.complete, nextCursor, unscannedKeys }
}

function parsePendingGrantPage(value: unknown): PendingGrantPage | undefined {
	if (
		typeof value !== 'object' ||
		value === null ||
		!('revocations' in value) ||
		!Array.isArray(value.revocations) ||
		!value.revocations.every(isPendingGrantRevocation)
	) {
		return undefined
	}
	const cursor = parsePendingPageCursor(value)
	if (!cursor) return undefined
	return { ...cursor, revocations: value.revocations }
}

function parsePendingTokenPage(value: unknown): PendingTokenPage | undefined {
	if (typeof value !== 'object' || value === null) return undefined
	const cursor = parsePendingPageCursor(value)
	if (!cursor?.unscannedKeys) return undefined
	return { ...cursor, unscannedKeys: cursor.unscannedKeys }
}

function parseContinuation(value: unknown): PurgeContinuation {
	if (
		typeof value !== 'object' ||
		value === null ||
		!('version' in value) ||
		value.version !== 1 ||
		!('nextPhase' in value) ||
		!isPurgePhase(value.nextPhase)
	) {
		return { version: 1, nextPhase: 'grants' }
	}

	const grantCursor =
		'grantCursor' in value && typeof value.grantCursor === 'string'
			? value.grantCursor
			: undefined
	const tokenCursor =
		'tokenCursor' in value && typeof value.tokenCursor === 'string'
			? value.tokenCursor
			: undefined
	const pendingGrantPage =
		'pendingGrantPage' in value
			? parsePendingGrantPage(value.pendingGrantPage)
			: undefined
	const pendingTokenPage =
		'pendingTokenPage' in value
			? parsePendingTokenPage(value.pendingTokenPage)
			: undefined
	return {
		version: 1,
		nextPhase: value.nextPhase,
		grantCursor,
		tokenCursor,
		pendingGrantPage,
		pendingTokenPage,
	}
}

function isGrantRecord(value: unknown): value is GrantRecord {
	return (
		typeof value === 'object' &&
		value !== null &&
		'clientId' in value &&
		typeof value.clientId === 'string'
	)
}

function isTokenRecord(value: unknown): value is TokenRecord {
	return (
		typeof value === 'object' &&
		value !== null &&
		'grantId' in value &&
		typeof value.grantId === 'string' &&
		'userId' in value &&
		typeof value.userId === 'string'
	)
}

function isClientMetadataUrl(clientId: string) {
	try {
		const url = new URL(clientId)
		return url.protocol === 'https:' && url.pathname !== '/'
	} catch {
		return false
	}
}

export function isInvalidOAuthPurgeCursorError(error: unknown): boolean {
	if (!(error instanceof Error)) return false
	if (
		/cursor/i.test(error.message) &&
		/(expired|invalid|malformed)/i.test(error.message)
	) {
		return true
	}
	return isInvalidOAuthPurgeCursorError(error.cause)
}

export async function listOAuthPurgePage(
	kv: KVNamespace,
	options: { prefix: string; cursor?: string },
) {
	try {
		return await kv.list({ ...options, limit: oauthPurgeBatchSize })
	} catch (error) {
		if (!options.cursor || !isInvalidOAuthPurgeCursorError(error)) throw error
		return kv.list({ prefix: options.prefix, limit: oauthPurgeBatchSize })
	}
}

function grantRevocationForKey(
	grantKey: string,
): PendingGrantRevocation | undefined {
	if (!grantKey.startsWith('grant:')) return undefined
	const parts = grantKey.slice('grant:'.length).split(':')
	if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
		return undefined
	}
	return {
		grantKey,
		tokenPrefix: `token:${parts[0]}:${parts[1]}:`,
	}
}

type RunBudget = { hasTime: () => boolean }

function startRunBudget(): RunBudget {
	const deadline = Date.now() + oauthPurgeRunBudgetMs
	return { hasTime: () => Date.now() < deadline }
}

/**
 * Runs `work` over the leading keys in small parallel chunks and stops between
 * chunks once the run is out of time. Results line up with the keys they
 * finished; keys past `results.length` were not touched.
 */
async function processKeysWithinBudget<T>(
	keys: Array<string>,
	budget: RunBudget,
	work: (key: string) => Promise<T>,
) {
	const results = new Array<T>()
	while (results.length < keys.length && budget.hasTime()) {
		const chunk = keys.slice(
			results.length,
			results.length + oauthPurgeKeyConcurrency,
		)
		results.push(...(await Promise.all(chunk.map(work))))
	}
	return results
}

async function scanGrantPage(
	kv: KVNamespace,
	continuation: PurgeContinuation,
	now: number,
	budget: RunBudget,
) {
	let page = continuation.pendingGrantPage
	if (!page) {
		const listed = await listOAuthPurgePage(kv, {
			prefix: 'grant:',
			cursor: continuation.grantCursor,
		})
		page = {
			complete: listed.list_complete,
			nextCursor: listed.list_complete ? undefined : listed.cursor,
			revocations: [],
			unscannedKeys: listed.keys.map((key) => key.name),
		}
		continuation.pendingGrantPage = page
	}
	const unscannedKeys = page.unscannedKeys ?? []
	const clients = new Map<string, Promise<boolean>>()
	const clientExists = (clientId: string) => {
		let exists = clients.get(clientId)
		if (!exists) {
			exists = kv
				.get(`client:${clientId}`, { type: 'json' })
				.then((client) => client !== null)
			clients.set(clientId, exists)
		}
		return exists
	}

	const scanned = await processKeysWithinBudget(
		unscannedKeys,
		budget,
		async (grantKey) => {
			const grant = await kv.get(grantKey, { type: 'json' })
			if (!isGrantRecord(grant)) return undefined
			const shouldPurge =
				(typeof grant.expiresAt === 'number' && now >= grant.expiresAt) ||
				(!isClientMetadataUrl(grant.clientId) &&
					!(await clientExists(grant.clientId)))
			return shouldPurge ? grantRevocationForKey(grantKey) : undefined
		},
	)
	for (const revocation of scanned) {
		if (revocation) page.revocations.push(revocation)
	}
	const remaining = unscannedKeys.slice(scanned.length)
	page.unscannedKeys = remaining.length > 0 ? remaining : undefined
	return scanned.length
}

function finishGrantPage(continuation: PurgeContinuation) {
	const page = continuation.pendingGrantPage
	if (!page || page.unscannedKeys || page.revocations.length > 0) return
	continuation.grantCursor = page.complete ? undefined : page.nextCursor
	continuation.pendingGrantPage = undefined
}

async function revokeNextPendingGrant(
	kv: KVNamespace,
	continuation: PurgeContinuation,
	budget: RunBudget,
) {
	const pending = continuation.pendingGrantPage?.revocations[0]
	if (!pending || continuation.pendingGrantPage?.unscannedKeys) {
		return { grantsPurged: 0, tokensPurged: 0 }
	}
	if (!budget.hasTime()) return { grantsPurged: 0, tokensPurged: 0 }

	const tokenPage = await listOAuthPurgePage(kv, {
		prefix: pending.tokenPrefix,
		cursor: pending.tokenCursor,
	})
	const tokenKeys = tokenPage.keys.map((key) => key.name)
	const deleted = await processKeysWithinBudget(tokenKeys, budget, (key) =>
		kv.delete(key),
	)
	// Re-listing the same cursor after a partial page only returns the tokens
	// that are still present, so the cursor advances once the page is done.
	if (deleted.length < tokenKeys.length) {
		return { grantsPurged: 0, tokensPurged: deleted.length }
	}
	if (!tokenPage.list_complete) {
		pending.tokenCursor = tokenPage.cursor
		return { grantsPurged: 0, tokensPurged: deleted.length }
	}
	if (!budget.hasTime()) {
		return { grantsPurged: 0, tokensPurged: deleted.length }
	}
	await kv.delete(pending.grantKey)
	continuation.pendingGrantPage?.revocations.shift()
	return { grantsPurged: 1, tokensPurged: deleted.length }
}

async function purgeGrantPhase(
	kv: KVNamespace,
	continuation: PurgeContinuation,
	now: number,
	budget: RunBudget,
): Promise<OAuthPurgeResult> {
	const pendingPage = continuation.pendingGrantPage
	const checked =
		!pendingPage || pendingPage.unscannedKeys
			? await scanGrantPage(kv, continuation, now, budget)
			: 0
	const { grantsPurged, tokensPurged } = await revokeNextPendingGrant(
		kv,
		continuation,
		budget,
	)

	finishGrantPage(continuation)
	const phaseComplete =
		continuation.pendingGrantPage === undefined &&
		continuation.grantCursor === undefined
	continuation.nextPhase = 'tokens'
	return {
		phase: 'grants',
		checked,
		grantsPurged,
		tokensPurged,
		phaseComplete,
		budgetExhausted: !budget.hasTime(),
	}
}

async function purgeTokenPhase(
	kv: KVNamespace,
	continuation: PurgeContinuation,
	budget: RunBudget,
): Promise<OAuthPurgeResult> {
	let page = continuation.pendingTokenPage
	if (!page) {
		const listed = await listOAuthPurgePage(kv, {
			prefix: 'token:',
			cursor: continuation.tokenCursor,
		})
		page = {
			complete: listed.list_complete,
			nextCursor: listed.list_complete ? undefined : listed.cursor,
			unscannedKeys: listed.keys.map((key) => key.name),
		}
		continuation.pendingTokenPage = page
	}
	const grants = new Map<string, Promise<boolean>>()
	const grantExists = (grantKey: string) => {
		let exists = grants.get(grantKey)
		if (!exists) {
			exists = kv.get(grantKey).then((grant) => grant !== null)
			grants.set(grantKey, exists)
		}
		return exists
	}

	const scanned = await processKeysWithinBudget(
		page.unscannedKeys,
		budget,
		async (tokenKey) => {
			const token = await kv.get(tokenKey, { type: 'json' })
			if (!isTokenRecord(token)) return false
			if (await grantExists(`grant:${token.userId}:${token.grantId}`)) {
				return false
			}
			await kv.delete(tokenKey)
			return true
		},
	)
	page.unscannedKeys = page.unscannedKeys.slice(scanned.length)
	if (page.unscannedKeys.length === 0) {
		continuation.tokenCursor = page.complete ? undefined : page.nextCursor
		continuation.pendingTokenPage = undefined
	}
	continuation.nextPhase = 'grants'
	return {
		phase: 'tokens',
		checked: scanned.length,
		grantsPurged: 0,
		tokensPurged: scanned.filter(Boolean).length,
		phaseComplete:
			continuation.pendingTokenPage === undefined &&
			continuation.tokenCursor === undefined,
		budgetExhausted: !budget.hasTime(),
	}
}

async function continueOAuthPurge(
	kv: KVNamespace,
	storage: DurableObjectStorage,
	now: number,
): Promise<OAuthPurgeResult> {
	const budget = startRunBudget()
	const continuation = parseContinuation(
		await storage.get(oauthPurgeContinuationStorageKey),
	)
	const result =
		continuation.nextPhase === 'grants'
			? await purgeGrantPhase(kv, continuation, now, budget)
			: await purgeTokenPhase(kv, continuation, budget)
	await storage.put(oauthPurgeContinuationStorageKey, continuation)
	return result
}

/**
 * A single global instance serializes purge invocations and stores continuation
 * in strongly consistent Durable Object storage. KV remains only the provider's
 * data plane; it is not used as a lock or continuation-state authority.
 *
 * Runs queue on an in-object promise chain instead of `blockConcurrencyWhile`:
 * KV awaits let other RPCs in, and `blockConcurrencyWhile` resets the whole
 * object (dropping the unsaved continuation) when a slow KV window outlasts
 * its ~30s limit.
 */
export class OAuthPurgeCoordinator extends DurableObject<Env> {
	#previousRun: Promise<unknown> = Promise.resolve()

	run(input: { scheduledAt: number }): Promise<OAuthPurgeResult> {
		const result = this.#previousRun.then(() =>
			continueOAuthPurge(
				this.env.OAUTH_KV,
				this.ctx.storage,
				Math.floor(input.scheduledAt / 1000),
			),
		)
		this.#previousRun = result.catch(() => {})
		return result
	}
}
