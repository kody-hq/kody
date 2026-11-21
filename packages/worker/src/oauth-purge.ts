import { DurableObject } from 'cloudflare:workers'
import { Effect, Option, Schema } from 'effect'
import { retryDurableObjectReset } from '#worker/effect/durable-object.ts'
import { observabilityLayer } from '#worker/effect/observability.ts'
import {
	decodeOutbound,
	outbound,
	type OutboundCallError,
} from '#worker/effect/outbound.ts'
import { WorkerEnv } from '#worker/effect/worker-env.ts'

const oauthPurgeBatchSize = 50
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
}

export type PurgeContinuation = {
	version: 1
	nextPhase: PurgePhase
	grantCursor?: string
	tokenCursor?: string
	pendingGrantPage?: PendingGrantPage
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

function parsePendingGrantPage(value: unknown): PendingGrantPage | undefined {
	if (
		typeof value !== 'object' ||
		value === null ||
		!('complete' in value) ||
		typeof value.complete !== 'boolean' ||
		!('revocations' in value) ||
		!Array.isArray(value.revocations) ||
		!value.revocations.every(isPendingGrantRevocation)
	) {
		return undefined
	}
	const nextCursor =
		'nextCursor' in value && typeof value.nextCursor === 'string'
			? value.nextCursor
			: undefined
	return {
		complete: value.complete,
		nextCursor,
		revocations: value.revocations,
	}
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
	return {
		version: 1,
		nextPhase: value.nextPhase,
		grantCursor,
		tokenCursor,
		pendingGrantPage,
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

async function loadGrantPage(
	kv: KVNamespace,
	continuation: PurgeContinuation,
	now: number,
) {
	const page = await listOAuthPurgePage(kv, {
		prefix: 'grant:',
		cursor: continuation.grantCursor,
	})
	const clients = new Map<string, boolean>()
	const revocations = new Array<PendingGrantRevocation>()

	for (const key of page.keys) {
		const grant = await kv.get(key.name, { type: 'json' })
		if (!isGrantRecord(grant)) continue

		let shouldPurge =
			typeof grant.expiresAt === 'number' && now >= grant.expiresAt
		if (!shouldPurge && !isClientMetadataUrl(grant.clientId)) {
			let clientExists = clients.get(grant.clientId)
			if (clientExists === undefined) {
				clientExists =
					(await kv.get(`client:${grant.clientId}`, { type: 'json' })) !== null
				clients.set(grant.clientId, clientExists)
			}
			shouldPurge = !clientExists
		}

		if (shouldPurge) {
			const revocation = grantRevocationForKey(key.name)
			if (revocation) revocations.push(revocation)
		}
	}

	continuation.pendingGrantPage = {
		complete: page.list_complete,
		nextCursor: page.list_complete ? undefined : page.cursor,
		revocations,
	}
	return page.keys.length
}

function finishGrantPage(continuation: PurgeContinuation) {
	const page = continuation.pendingGrantPage
	if (!page || page.revocations.length > 0) return
	continuation.grantCursor = page.complete ? undefined : page.nextCursor
	continuation.pendingGrantPage = undefined
}

async function purgeGrantPhase(
	kv: KVNamespace,
	continuation: PurgeContinuation,
	now: number,
): Promise<OAuthPurgeResult> {
	const checked = continuation.pendingGrantPage
		? 0
		: await loadGrantPage(kv, continuation, now)
	const pending = continuation.pendingGrantPage?.revocations[0]
	let grantsPurged = 0
	let tokensPurged = 0

	if (pending) {
		const tokenPage = await listOAuthPurgePage(kv, {
			prefix: pending.tokenPrefix,
			cursor: pending.tokenCursor,
		})
		await Promise.all(tokenPage.keys.map((key) => kv.delete(key.name)))
		tokensPurged = tokenPage.keys.length
		if (tokenPage.list_complete) {
			await kv.delete(pending.grantKey)
			continuation.pendingGrantPage?.revocations.shift()
			grantsPurged = 1
		} else {
			pending.tokenCursor = tokenPage.cursor
		}
	}

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
	}
}

async function purgeTokenPhase(
	kv: KVNamespace,
	continuation: PurgeContinuation,
): Promise<OAuthPurgeResult> {
	const page = await listOAuthPurgePage(kv, {
		prefix: 'token:',
		cursor: continuation.tokenCursor,
	})
	const grants = new Map<string, boolean>()
	let tokensPurged = 0

	for (const key of page.keys) {
		const token = await kv.get(key.name, { type: 'json' })
		if (!isTokenRecord(token)) continue

		const grantKey = `grant:${token.userId}:${token.grantId}`
		let grantExists = grants.get(grantKey)
		if (grantExists === undefined) {
			grantExists = (await kv.get(grantKey)) !== null
			grants.set(grantKey, grantExists)
		}
		if (!grantExists) {
			await kv.delete(key.name)
			tokensPurged++
		}
	}

	continuation.tokenCursor = page.list_complete ? undefined : page.cursor
	continuation.nextPhase = 'grants'
	return {
		phase: 'tokens',
		checked: page.keys.length,
		grantsPurged: 0,
		tokensPurged,
		phaseComplete: page.list_complete,
	}
}

async function continueOAuthPurge(
	kv: KVNamespace,
	storage: DurableObjectStorage,
	now: number,
): Promise<OAuthPurgeResult> {
	const continuation = parseContinuation(
		await storage.get(oauthPurgeContinuationStorageKey),
	)
	const result =
		continuation.nextPhase === 'grants'
			? await purgeGrantPhase(kv, continuation, now)
			: await purgeTokenPhase(kv, continuation)
	await storage.put(oauthPurgeContinuationStorageKey, continuation)
	return result
}

const PendingGrantRevocationSchema = Schema.Struct({
	grantKey: Schema.String,
	tokenPrefix: Schema.String,
	tokenCursor: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
})
const PendingGrantPageSchema = Schema.Struct({
	complete: Schema.Boolean,
	nextCursor: Schema.optionalKey(Schema.Unknown),
	revocations: Schema.Array(PendingGrantRevocationSchema),
})
const PurgePhaseSchema = Schema.Literals(['grants', 'tokens'])
const StoredContinuation = Schema.Struct({
	version: Schema.Literal(1),
	nextPhase: PurgePhaseSchema,
	grantCursor: Schema.optionalKey(Schema.Unknown),
	tokenCursor: Schema.optionalKey(Schema.Unknown),
	pendingGrantPage: Schema.optionalKey(Schema.Unknown),
})
const GrantRecordSchema = Schema.Struct({
	clientId: Schema.String,
	expiresAt: Schema.optionalKey(Schema.Unknown),
})
const TokenRecordSchema = Schema.Struct({
	grantId: Schema.String,
	userId: Schema.String,
})
const OAuthPurgeResultSchema = Schema.Struct({
	phase: PurgePhaseSchema,
	checked: Schema.Number,
	grantsPurged: Schema.Number,
	tokensPurged: Schema.Number,
	phaseComplete: Schema.Boolean,
})

const optionalString = (value: unknown) =>
	typeof value === 'string' ? value : undefined

/** The stored continuation; anything that does not decode restarts. */
function decodeContinuation(value: unknown): PurgeContinuation {
	return Option.match(Schema.decodeUnknownOption(StoredContinuation)(value), {
		onNone: (): PurgeContinuation => ({ version: 1, nextPhase: 'grants' }),
		onSome: (stored) => ({
			version: 1,
			nextPhase: stored.nextPhase,
			grantCursor: optionalString(stored.grantCursor),
			tokenCursor: optionalString(stored.tokenCursor),
			pendingGrantPage: Option.match(
				Schema.decodeUnknownOption(PendingGrantPageSchema)(
					stored.pendingGrantPage,
				),
				{
					onNone: () => undefined,
					onSome: (page) => ({
						complete: page.complete,
						nextCursor: optionalString(page.nextCursor),
						revocations: page.revocations.map((revocation) => ({
							...revocation,
						})),
					}),
				},
			),
		}),
	})
}

const decodeOption =
	<A>(schema: Schema.Decoder<A>) =>
	(value: unknown) =>
		Schema.decodeUnknownOption(schema)(value)

const kvList = (
	kv: KVNamespace,
	options: { prefix: string; cursor?: string },
) =>
	outbound('oauth_kv.list', () =>
		kv.list({ ...options, limit: oauthPurgeBatchSize }),
	).pipe(
		Effect.catch((error) =>
			options.cursor &&
			error.reason === 'failed' &&
			isInvalidOAuthPurgeCursorError(error.cause)
				? outbound('oauth_kv.list', () =>
						kv.list({ prefix: options.prefix, limit: oauthPurgeBatchSize }),
					)
				: Effect.fail(error),
		),
	)

const kvGetJson = (kv: KVNamespace, key: string) =>
	outbound('oauth_kv.get', () => kv.get(key, { type: 'json' }))

const kvDelete = (kv: KVNamespace, key: string) =>
	outbound('oauth_kv.delete', () => kv.delete(key))

const loadGrantPageEffect = Effect.fn('OAuthPurge.loadGrantPage')(function* (
	kv: KVNamespace,
	continuation: PurgeContinuation,
	now: number,
) {
	const page = yield* kvList(kv, {
		prefix: 'grant:',
		cursor: continuation.grantCursor,
	})
	const clients = new Map<string, boolean>()
	const revocations = new Array<PendingGrantRevocation>()
	for (const key of page.keys) {
		const grant = decodeOption(GrantRecordSchema)(
			yield* kvGetJson(kv, key.name),
		)
		if (Option.isNone(grant)) continue
		const { clientId, expiresAt } = grant.value
		let shouldPurge = typeof expiresAt === 'number' && now >= expiresAt
		if (!shouldPurge && !isClientMetadataUrl(clientId)) {
			let clientExists = clients.get(clientId)
			if (clientExists === undefined) {
				clientExists = (yield* kvGetJson(kv, `client:${clientId}`)) !== null
				clients.set(clientId, clientExists)
			}
			shouldPurge = !clientExists
		}
		if (shouldPurge) {
			const revocation = grantRevocationForKey(key.name)
			if (revocation) revocations.push(revocation)
		}
	}
	continuation.pendingGrantPage = {
		complete: page.list_complete,
		nextCursor: page.list_complete ? undefined : page.cursor,
		revocations,
	}
	return page.keys.length
})

const purgeGrantPhaseEffect = Effect.fn('OAuthPurge.grantPhase')(function* (
	kv: KVNamespace,
	continuation: PurgeContinuation,
	now: number,
) {
	const checked = continuation.pendingGrantPage
		? 0
		: yield* loadGrantPageEffect(kv, continuation, now)
	const pending = continuation.pendingGrantPage?.revocations[0]
	let grantsPurged = 0
	let tokensPurged = 0
	if (pending) {
		const tokenPage = yield* kvList(kv, {
			prefix: pending.tokenPrefix,
			cursor: pending.tokenCursor,
		})
		yield* Effect.forEach(tokenPage.keys, (key) => kvDelete(kv, key.name), {
			concurrency: 'unbounded',
			discard: true,
		})
		tokensPurged = tokenPage.keys.length
		if (tokenPage.list_complete) {
			yield* kvDelete(kv, pending.grantKey)
			continuation.pendingGrantPage?.revocations.shift()
			grantsPurged = 1
		} else {
			pending.tokenCursor = tokenPage.cursor
		}
	}
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
	} satisfies OAuthPurgeResult
})

const purgeTokenPhaseEffect = Effect.fn('OAuthPurge.tokenPhase')(function* (
	kv: KVNamespace,
	continuation: PurgeContinuation,
) {
	const page = yield* kvList(kv, {
		prefix: 'token:',
		cursor: continuation.tokenCursor,
	})
	const grants = new Map<string, boolean>()
	let tokensPurged = 0
	for (const key of page.keys) {
		const token = decodeOption(TokenRecordSchema)(
			yield* kvGetJson(kv, key.name),
		)
		if (Option.isNone(token)) continue
		const grantKey = `grant:${token.value.userId}:${token.value.grantId}`
		let grantExists = grants.get(grantKey)
		if (grantExists === undefined) {
			grantExists =
				(yield* outbound('oauth_kv.get', () => kv.get(grantKey))) !== null
			grants.set(grantKey, grantExists)
		}
		if (!grantExists) {
			yield* kvDelete(kv, key.name)
			tokensPurged++
		}
	}
	continuation.tokenCursor = page.list_complete ? undefined : page.cursor
	continuation.nextPhase = 'grants'
	return {
		phase: 'tokens',
		checked: page.keys.length,
		grantsPurged: 0,
		tokensPurged,
		phaseComplete: page.list_complete,
	} satisfies OAuthPurgeResult
})

/** `continueOAuthPurge` as an Effect: every KV and storage call is bounded. */
export const continueOAuthPurgeEffect = Effect.fn('OAuthPurge.continue')(
	function* (
		kv: KVNamespace,
		storage: DurableObjectStorage,
		now: number,
	): Effect.fn.Return<OAuthPurgeResult, OutboundCallError> {
		const continuation = decodeContinuation(
			yield* outbound('oauth_purge.storage.get', () =>
				storage.get(oauthPurgeContinuationStorageKey),
			),
		)
		const result =
			continuation.nextPhase === 'grants'
				? yield* purgeGrantPhaseEffect(kv, continuation, now)
				: yield* purgeTokenPhaseEffect(kv, continuation)
		yield* outbound('oauth_purge.storage.put', () =>
			storage.put(oauthPurgeContinuationStorageKey, continuation),
		)
		return result
	},
)

/** The `oauth_purge_expired` lane: one coordinator RPC, bounded and decoded. */
export const runOAuthPurgeLaneEffect = Effect.fn('OAuthPurge.lane')(
	function* (input: { scheduledAt: Date }) {
		const env = yield* WorkerEnv
		const stub = env.OAUTH_PURGE_COORDINATOR.get(
			env.OAUTH_PURGE_COORDINATOR.idFromName('global'),
		)
		const result = yield* retryDurableObjectReset(
			outbound('oauth_purge_coordinator.run_effect', () =>
				stub.runEffect({ scheduledAt: input.scheduledAt.getTime() }),
			),
		)
		return yield* decodeOutbound(
			'oauth_purge_coordinator.run_effect',
			OAuthPurgeResultSchema,
		)(result)
	},
)

/**
 * A single global instance serializes purge invocations and stores continuation
 * in strongly consistent Durable Object storage. KV remains only the provider's
 * data plane; it is not used as a lock or continuation-state authority.
 */
export class OAuthPurgeCoordinator extends DurableObject<Env> {
	run(input: { scheduledAt: number }): Promise<OAuthPurgeResult> {
		return this.ctx.blockConcurrencyWhile(() =>
			continueOAuthPurge(
				this.env.OAUTH_KV,
				this.ctx.storage,
				Math.floor(input.scheduledAt / 1000),
			),
		)
	}

	/** The Effect trial path, selected by `EFFECT_TRIAL_WIDE_LANES`. */
	runEffect(input: { scheduledAt: number }): Promise<OAuthPurgeResult> {
		return this.ctx.blockConcurrencyWhile(() =>
			Effect.runPromise(
				continueOAuthPurgeEffect(
					this.env.OAUTH_KV,
					this.ctx.storage,
					Math.floor(input.scheduledAt / 1000),
				).pipe(
					Effect.mapError((error) =>
						error.reason === 'failed' ? error.cause : error,
					),
					Effect.provide(observabilityLayer),
				),
			),
		)
	}
}
