import {
	type EcpCancelReason,
	type EcpCapabilities,
	type EcpGrant,
	type EcpRunRequestBody,
	sha256Base64Url,
} from '@kody-internal/shared/execution-context-protocol/index.ts'
import { type CredentialCallMap } from '#worker/credentials/credential-call-map.ts'
import { type RunRecordHandle } from '#worker/run-records/types.ts'
import {
	checkPermission,
	computeEffectivePermissions,
	type EffectivePermissions,
} from '#worker/authorization/authorize.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import {
	type OwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { ExecutionContextError } from './errors.ts'
import {
	type ExecutionContextLease,
	type ExecutionContextRunResult,
} from './session-do.ts'
import { type ExecutionContextRunTiming } from './run-timing.ts'
import { runChainShapeError, type ExecuteRequirement } from './chain-rules.ts'
import {
	type ChainEntry,
	type ExecutionContextRow,
	type UnusableReason,
	getChain,
	getExecutionContext,
	loadContextAccess,
	parseCapabilities,
	parseGrant,
	resolveExecutionContextRef,
	sessionStub,
} from './store.ts'

export { executeRequirements, type ExecuteRequirement } from './chain-rules.ts'

export type ExecuteRoutingArgs = {
	/** A context id or name, or `cloud`. */
	context?: string
	/** `chain` lets a named context fall back to the caller's chain. */
	fallback?: 'chain'
	requires?: Array<ExecuteRequirement>
	/**
	 * This run's own ordered chain: context ids or names, with `cloud` only
	 * ever last. Replaces the caller's default chain for this run.
	 */
	chain?: Array<string>
}

export type RoutingAttempt = {
	target: string
	name?: string
	outcome:
		| 'ran'
		| 'offline'
		| 'busy'
		| 'rejected'
		| 'aborted'
		| 'timeout'
		| 'skipped'
		| 'queued'
		| 'expired'
	reason?: string
}

export type ExecutionContextRunMetadata = {
	id: string | null
	name: string | null
	attempts: Array<RoutingAttempt>
	fellBackToCloud: boolean
	/** The requester runs this context's daemon (their own machine). */
	yours?: boolean
	/** Where the run's time went, when the context reported it. */
	timing?: ExecutionContextRunTiming
}

/** Where a run happened: Kody cloud or one execution context. */
export type RanOnTarget =
	| { kind: 'cloud'; id: 'cloud'; name: 'Kody cloud' }
	| {
			kind: 'context'
			id: string
			name: string
			yours?: boolean
			/** Where the run's time went, when the context reported it. */
			timing?: ExecutionContextRunTiming
	  }

/** `ranOn` on every execute response: the target plus how it got there. */
export type ExecuteRanOn = RanOnTarget & {
	attempts: Array<RoutingAttempt>
	fellBackToCloud: boolean
}

export const kodyCloudTarget = {
	kind: 'cloud',
	id: 'cloud',
	name: 'Kody cloud',
} as const satisfies RanOnTarget

/** Run-history `ranOn`: null when a queued run expired before anything ran it. */
export function historyRanOn(value: unknown): ExecuteRanOn | null {
	const attempts =
		isRecord(value) && Array.isArray(value.attempts)
			? (value.attempts as Array<RoutingAttempt>)
			: []
	return attempts.at(-1)?.outcome === 'expired'
		? null
		: ranOnFromMetadata(value)
}

/** Reads run metadata (`executionContext`) as `ranOn`; anything else is cloud. */
export function ranOnFromMetadata(value: unknown): ExecuteRanOn {
	const metadata = isRecord(value) ? value : null
	const attempts = Array.isArray(metadata?.attempts)
		? (metadata.attempts as Array<RoutingAttempt>)
		: []
	const fellBackToCloud = metadata?.fellBackToCloud === true
	if (
		!fellBackToCloud &&
		typeof metadata?.id === 'string' &&
		metadata.id !== 'cloud'
	) {
		return {
			kind: 'context',
			id: metadata.id,
			name: typeof metadata.name === 'string' ? metadata.name : metadata.id,
			...(typeof metadata.yours === 'boolean' ? { yours: metadata.yours } : {}),
			...(isRecord(metadata.timing)
				? { timing: metadata.timing as ExecutionContextRunTiming }
				: {}),
			attempts,
			fellBackToCloud: false,
		}
	}
	return {
		...kodyCloudTarget,
		attempts: attempts.filter((attempt) => attempt.outcome !== 'ran'),
		fellBackToCloud,
	}
}

/**
 * One line saying where a run happened, with friendly names only, e.g.
 * "Ran on Kody cloud after build-box was offline."
 */
export function describeRanOn(
	ranOn: ExecuteRanOn,
	options: { running?: boolean } = {},
) {
	const passed = ranOn.attempts.filter(
		(attempt) =>
			attempt.outcome !== 'ran' &&
			!(ranOn.kind === 'context' && attempt.target === ranOn.id),
	)
	const after =
		passed.length > 0 ? ` after ${joinList(passed.map(describePass))}` : ''
	const where =
		ranOn.kind === 'cloud'
			? ranOn.name
			: `${ranOn.name} (${ranOn.yours ? 'your machine' : 'an execution context'})`
	const last = ranOn.attempts.at(-1)
	if (ranOn.kind === 'context' && last?.outcome === 'queued') {
		return `Waiting for ${where} to take this run${after}.`
	}
	return `${options.running ? 'Running' : 'Ran'} on ${where}${after}.`
}

/** The cloud-fallback line (kept for callers that only have metadata). */
export function describeCloudFallback(metadata: ExecutionContextRunMetadata) {
	return describeRanOn(ranOnFromMetadata(metadata))
}

const passPhrases: Record<RoutingAttempt['outcome'], string> = {
	ran: 'ran it',
	offline: 'was offline',
	busy: 'was busy',
	rejected: 'declined it',
	aborted: 'stopped it before it started',
	timeout: 'did not answer in time',
	skipped: 'was skipped',
	queued: 'was queued',
	expired: 'did not take it before the queue expired',
}

function describePass(attempt: RoutingAttempt) {
	const who =
		(attempt.name && !looksLikeContextId(attempt.name, attempt.target)
			? attempt.name
			: null) ??
		(attempt.reason === 'gone'
			? 'a context that no longer exists'
			: 'an execution context')
	const reason =
		attempt.reason && attempt.reason !== 'gone'
			? ` (${attempt.reason.replaceAll('_', ' ')})`
			: ''
	return `${who} ${passPhrases[attempt.outcome] ?? attempt.outcome}${reason}`
}

/** A missing chain ref keeps the raw ref as its name; never print an id. */
function looksLikeContextId(name: string, target: string) {
	return name === target || /^ec_[a-z0-9]+$/i.test(name)
}

function joinList(items: Array<string>) {
	if (items.length <= 1) return items.join('')
	return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type RoutingOutcome =
	| { kind: 'cloud'; metadata: ExecutionContextRunMetadata | null }
	| {
			kind: 'queued'
			runId: string
			contextId: string
			contextName: string
			expiresAt: number
			metadata: ExecutionContextRunMetadata
	  }
	| {
			kind: 'ran'
			result: ExecutionContextRunResult
			metadata: ExecutionContextRunMetadata
	  }
	| { kind: 'pending'; runId: string; metadata: ExecutionContextRunMetadata }

/** Pure: the ordered targets a run may try, before availability probes. */
export function planTargets(input: {
	named: ExecutionContextRow | 'cloud' | null
	fallback: 'chain' | undefined
	chain: Array<{ kind: 'context'; id: string } | { kind: 'cloud' }>
	strict: boolean
	requires: ReadonlyArray<ExecuteRequirement>
}): Array<{ kind: 'context'; id: string } | { kind: 'cloud' }> {
	const cloudAllowed = input.requires.length === 0
	const targets: Array<{ kind: 'context'; id: string } | { kind: 'cloud' }> = []
	if (input.named === 'cloud') {
		return cloudAllowed ? [{ kind: 'cloud' }] : []
	}
	if (input.named) {
		targets.push({ kind: 'context', id: input.named.id })
		if (input.fallback !== 'chain') return targets
	}
	for (const entry of input.chain) {
		if (entry.kind === 'cloud') continue
		if (targets.some((t) => t.kind === 'context' && t.id === entry.id)) {
			continue
		}
		targets.push(entry)
	}
	const chainHasCloud = input.chain.some((entry) => entry.kind === 'cloud')
	if (cloudAllowed && (chainHasCloud || (!input.strict && !input.named))) {
		targets.push({ kind: 'cloud' })
	}
	return targets
}

/** Why a grant cannot meet the run's `requires`, or null when it can. */
export function requirementRefusal(
	grant: EcpGrant,
	requires: ReadonlyArray<ExecuteRequirement>,
	capabilities: EcpCapabilities,
): string | null {
	if (requires.includes('fs')) {
		if (grant.fs.length === 0) return 'no_fs'
		if (!(capabilities.features ?? []).includes('fs')) return 'no_local_fs'
	}
	if (requires.includes('lan') && grant.egress.mode !== 'public-and-lan') {
		return 'no_lan'
	}
	return null
}

/** Why a context cannot take this run, or null when it can. */
export function grantRefusal(input: {
	grant: EcpGrant
	requires: ReadonlyArray<ExecuteRequirement>
	/** What the daemon advertised; `fs` means its effective mount set is non-empty. */
	capabilities: EcpCapabilities
}): string | null {
	return requirementRefusal(input.grant, input.requires, input.capabilities)
}

function noContext(attempts: Array<RoutingAttempt>, message: string): never {
	throw new ExecutionContextError({
		status: 409,
		code: 'no_execution_context_available',
		message,
		details: { attempts },
	})
}

const acceptWindowMs = 10_000

/**
 * Picks where an execute runs. Returns `cloud` to let the hosted sandbox
 * run it, or the context run's result. Only called when the flag is on.
 */
export async function routeExecute(input: {
	env: Env
	request: {
		userId: string
		handle: string | null
		orgId: string
		orgSlug: string | null
		scopes: Array<string> | null
		credentialKind: string
		/**
		 * The caller's access when it acts as a profile (ADR 0092): every
		 * layer of its chain must hold execution_context:execute on a context,
		 * even one the person operates.
		 */
		profileAccess?: EffectivePermissions | null
		/** That profile's id, carried on the lease so callbacks stay narrowed. */
		profileId?: string | null
	}
	args: ExecuteRoutingArgs
	runId: string
	runRecord: RunRecordHandle | null
	code: string | null
	params: unknown
	conversationId?: string
	credentials: CredentialCallMap | null
	apiUrl: string
	waitMs: number
	signal?: AbortSignal
	/**
	 * Queue on the first offline or busy context until it can take the run,
	 * instead of failing, when no later target can (automations only). A
	 * cloud entry in the targets always wins over queueing.
	 */
	queue?: { expiresAt: number } | null
	/** `skip` records an unknown chain entry as skipped instead of a 404. */
	unknownChainRef?: 'error' | 'skip'
}): Promise<RoutingOutcome> {
	const requires = [...new Set(input.args.requires ?? [])]
	const db = input.env.APP_DB
	const namedRef = input.args.context?.trim() || null
	let named: ExecutionContextRow | 'cloud' | null = null
	let namedMissing: RoutingAttempt | null = null
	if (namedRef === 'cloud') {
		named = 'cloud'
	} else if (namedRef) {
		named = await resolveExecutionContextRef(db, input.request.orgId, namedRef)
		if (
			!named &&
			input.unknownChainRef === 'skip' &&
			input.args.fallback === 'chain'
		) {
			namedMissing = {
				target: namedRef,
				name: namedRef,
				outcome: 'skipped',
				reason: 'not_found',
			}
		} else if (!named) {
			throw new ExecutionContextError({
				status: 404,
				code: 'not_found',
				message: `No execution context named ${namedRef} in this org. Run executionContextList to see the ones you can use.`,
			})
		}
	}
	const chain = input.args.chain
		? await resolveRunChain(db, {
				orgId: input.request.orgId,
				refs: input.args.chain,
				unknownRef: input.unknownChainRef ?? 'error',
			})
		: {
				...(await getChain(db, {
					orgId: input.request.orgId,
					userId: input.request.userId,
				})),
				skipped: [] as Array<RoutingAttempt>,
			}
	const targets = planTargets({
		named,
		fallback: input.args.fallback,
		chain: chain.entries,
		strict: chain.strict,
		requires,
	})
	const attempts: Array<RoutingAttempt> = [
		...(namedMissing ? [namedMissing] : []),
		...chain.skipped,
	]
	const metadata = (
		row: ExecutionContextRow | null,
		fellBackToCloud: boolean,
	): ExecutionContextRunMetadata => ({
		id: row?.id ?? null,
		name: row?.name ?? null,
		...(row ? { yours: row.operator_user_id === input.request.userId } : {}),
		attempts,
		fellBackToCloud,
	})
	const onlyCloud = targets.every((t) => t.kind === 'cloud')
	if (onlyCloud && targets.length > 0) {
		return {
			kind: 'cloud',
			metadata: attempts.length > 0 ? metadata(null, true) : null,
		}
	}
	let lastTried: ExecutionContextRow | null = null
	let firstOffline: {
		row: ExecutionContextRow
		request: EcpRunRequestBody
		lease: ExecutionContextLease
		requires: Array<ExecuteRequirement>
	} | null = null
	for (const target of targets) {
		if (target.kind === 'cloud') {
			return { kind: 'cloud', metadata: metadata(lastTried, true) }
		}
		const row =
			named && named !== 'cloud' && named.id === target.id
				? named
				: await getExecutionContext(db, target.id)
		if (!row) {
			attempts.push({ target: target.id, outcome: 'skipped', reason: 'gone' })
			continue
		}
		lastTried = row
		const skip = (reason: UnusableReason | string) =>
			attempts.push({
				target: row.id,
				name: row.name,
				outcome: 'skipped',
				reason,
			})
		if (input.request.credentialKind === 'cli' && !hasContextScope(input)) {
			skip('credential_scope')
			continue
		}
		const profileAccess = input.request.profileAccess
		if (
			profileAccess &&
			!checkPermission(profileAccess, 'execution_context:execute', {
				type: 'execution_context',
				id: row.id,
				orgId: input.request.orgId as OwnerId,
			}).allowed
		) {
			skip('profile_grant')
			continue
		}
		const access = await loadContextAccess(db, row, {
			userId: input.request.userId,
			orgId: input.request.orgId,
		})
		if (!access.usable) {
			skip(access.unusableReason ?? 'not_granted')
			continue
		}
		const grant = parseGrant(row)
		const sharedRun = row.operator_user_id !== input.request.userId
		const refusal = requirementRefusal(grant, requires, parseCapabilities(row))
		if (refusal) {
			skip(refusal)
			continue
		}
		if (!input.code) {
			skip('invoke_not_supported')
			continue
		}
		const now = Date.now()
		const deadline = now + grant.limits.timeoutMs
		const lease: ExecutionContextLease = {
			runId: input.runId,
			ecid: row.id,
			requester: {
				userId: input.request.userId,
				handle: input.request.handle,
			},
			orgId: input.request.orgId,
			callerScopes: input.request.scopes,
			...(input.request.profileId
				? { profileId: input.request.profileId }
				: {}),
			runtime: grant.runtime,
			deadline,
			sharedRun,
		}
		const request: EcpRunRequestBody = {
			runId: input.runId,
			deadline,
			acceptBy: now + acceptWindowMs,
			requestedBy: {
				userId: input.request.userId,
				handle: input.request.handle,
				orgId: input.request.orgId,
				orgSlug: input.request.orgSlug,
			},
			source: {
				kind: 'code',
				code: input.code,
				sha256: await sha256Base64Url(new TextEncoder().encode(input.code)),
			},
			params: input.params ?? {},
			...(input.conversationId ? { conversationId: input.conversationId } : {}),
			credentialPicks: credentialPicks(input.credentials),
			limits: {
				timeoutMs: grant.limits.timeoutMs,
				maxResultBytes: grant.payload.maxResultBytes,
				memoryMb: grant.limits.memoryMb,
			},
			grantVersion: row.grant_version,
			apiUrl: input.apiUrl,
			...(lease.sharedRun ? { sharedRun: true } : {}),
		}
		const stub = sessionStub(input.env, row.id)
		if (input.runRecord) {
			input.runRecord.context.metadata = {
				...input.runRecord.context.metadata,
				executionContext: {
					...metadata(row, false),
					attempts: [
						...attempts,
						{ target: row.id, name: row.name, outcome: 'ran' },
					],
				},
			}
		}
		const dispatched = await stub.dispatch({
			request,
			lease,
			runRecord: input.runRecord,
			position: attempts.length + 1,
		})
		if (dispatched.outcome !== 'committed') {
			if (
				((dispatched.outcome === 'offline' && dispatched.code !== 'revoked') ||
					dispatched.outcome === 'busy') &&
				!firstOffline
			) {
				firstOffline = {
					row,
					request,
					// The drain re-checks the grant, which may change while queued.
					lease,
					requires,
				}
			}
			attempts.push({
				target: row.id,
				name: row.name,
				outcome: dispatched.outcome,
				...(dispatched.code ? { reason: dispatched.code } : {}),
			})
			continue
		}
		attempts.push({ target: row.id, name: row.name, outcome: 'ran' })
		const ran = metadata(row, false)
		const cancel = (reason: EcpCancelReason) =>
			stub.cancel({ runId: input.runId, reason }).catch(() => {})
		const onAbort = () => void cancel('caller_cancelled')
		input.signal?.addEventListener('abort', onAbort, { once: true })
		try {
			const settled = await stub.awaitResult({
				runId: input.runId,
				waitMs: Math.min(input.waitMs, deadline - Date.now()),
			})
			if ('result' in settled) {
				const { timing, ...result } =
					settled.result as ExecutionContextRunResult
				return {
					kind: 'ran',
					result,
					metadata: timing ? { ...ran, timing } : ran,
				}
			}
			switch (settled.state) {
				case 'cancelled':
					return {
						kind: 'ran',
						result: failure(
							`The run on ${row.name} was cancelled (${settled.reason ?? 'cancelled'}).`,
							'execution_context_cancelled',
						),
						metadata: ran,
					}
				case 'lost':
				case 'unknown':
					return {
						kind: 'ran',
						result: failure(
							`${row.name} stopped answering while running this run, so its outcome is unknown. Kody did not retry it.`,
							'execution_context_lost',
						),
						metadata: ran,
					}
				case 'pending':
					return { kind: 'pending', runId: input.runId, metadata: ran }
			}
		} finally {
			input.signal?.removeEventListener('abort', onAbort)
		}
	}
	if (input.queue && firstOffline) {
		const { row, request, lease } = firstOffline
		const stub = sessionStub(input.env, row.id)
		const queuedMetadata: ExecutionContextRunMetadata = {
			id: row.id,
			name: row.name,
			yours: row.operator_user_id === input.request.userId,
			attempts: [
				...attempts,
				{ target: row.id, name: row.name, outcome: 'queued' },
			],
			fellBackToCloud: false,
		}
		if (input.runRecord) {
			input.runRecord.context.metadata = {
				...input.runRecord.context.metadata,
				executionContext: queuedMetadata,
			}
		}
		await stub.enqueue({
			request,
			lease,
			runRecord: input.runRecord,
			requires: firstOffline.requires,
			position: attempts.length + 1,
			expiresAt: input.queue.expiresAt,
		})
		return {
			kind: 'queued',
			runId: input.runId,
			contextId: row.id,
			contextName: row.name,
			expiresAt: input.queue.expiresAt,
			metadata: queuedMetadata,
		}
	}
	if (
		requires.length > 0 &&
		(named === 'cloud' ||
			(chain.entries.some((entry) => entry.kind === 'cloud') &&
				(!named || input.args.fallback === 'chain')))
	) {
		attempts.push({
			target: 'cloud',
			name: 'Kody cloud',
			outcome: 'skipped',
			reason: requires.includes('fs') ? 'no_fs' : 'no_lan',
		})
	}
	if (named && named !== 'cloud' && input.args.fallback !== 'chain') {
		const namedAttempt = attempts.find((a) => a.target === named.id)
		noContext(
			attempts,
			namedAttempt?.outcome === 'busy'
				? `${named.name} is busy: it is already running as many runs as it allows at once, so it could not take this run. A named context never falls back; try again when one of its runs finishes, or pass fallback: "chain" to use your chain instead.`
				: `${named.name} could not take this run (${describeAttempts(attempts)}). A named context never falls back; pass fallback: "chain" to use your chain instead.`,
		)
	}
	noContext(
		attempts,
		attempts.length === 0
			? requires.length > 0
				? `This run requires ${requires.join(' and ')}, which Kody cloud cannot provide, and no context in your chain can take it. Add one with executionChainSet.`
				: 'Your chain is strict and has no contexts, so this run had nowhere to go. Add a context or Kody cloud with executionChainSet.'
			: `No execution context could take this run (${describeAttempts(attempts)}).`,
	)
}

function hasContextScope(input: { request: { scopes: Array<string> | null } }) {
	const scopes = input.request.scopes
	return scopes === null || scopes.includes('execution_context:execute')
}

const contextReasonText: Record<string, string> = {
	profile_grant:
		'profile_grant: the profile this credential acts as, or a parent profile, was not granted execution_context:execute on it',
	no_fs: 'no_fs: its server grant lists no host folders (grant.fs)',
	no_local_fs:
		"no_local_fs: its server grant lists host folders, but the machine's local policy allows none of them (`kody context policy allow <folder>`)",
}

function describeAttempts(attempts: ReadonlyArray<RoutingAttempt>) {
	return attempts
		.map((a) => {
			const reason =
				a.reason && a.target !== 'cloud'
					? (contextReasonText[a.reason] ?? a.reason)
					: a.reason
			return `${a.name ?? a.target}: ${a.outcome}${reason ? ` (${reason})` : ''}`
		})
		.join('; ')
}

function credentialPicks(map: CredentialCallMap | null) {
	const picks: Record<string, Array<string>> = {}
	for (const [key, values] of map ?? []) {
		picks[key] = values.map((pick) => pick.name)
	}
	return picks
}

function failure(message: string, code: string): ExecutionContextRunResult {
	return {
		isError: true,
		content: [{ type: 'text', text: `Error: ${message}` }],
		structuredContent: { error: message, errorCode: code },
	}
}

/**
 * Resolves a run's own chain. Shape rules (cloud last, at most
 * {@link ecpMaxChainContexts} contexts, no repeats) match the default chain.
 */
export async function resolveRunChain(
	db: D1Database,
	input: {
		orgId: string
		refs: ReadonlyArray<string>
		unknownRef: 'error' | 'skip'
	},
): Promise<{
	entries: Array<ChainEntry>
	strict: boolean
	skipped: Array<RoutingAttempt>
}> {
	const shapeError = runChainShapeError(input.refs)
	if (shapeError) {
		throw new ExecutionContextError({
			status: 400,
			code: shapeError.code,
			message: shapeError.message,
		})
	}
	const entries: Array<ChainEntry> = []
	const skipped: Array<RoutingAttempt> = []
	for (const raw of input.refs) {
		const ref = raw.trim()
		if (ref === 'cloud') {
			entries.push({ kind: 'cloud' })
			continue
		}
		const row = await resolveExecutionContextRef(db, input.orgId, ref)
		if (!row) {
			if (input.unknownRef === 'error') {
				throw new ExecutionContextError({
					status: 404,
					code: 'not_found',
					message: `No execution context named ${ref} in this org. Run executionContextList to see the ones you can use.`,
				})
			}
			skipped.push({ target: ref, outcome: 'skipped', reason: 'not_found' })
			continue
		}
		if (entries.some((e) => e.kind === 'context' && e.id === row.id)) continue
		entries.push({ kind: 'context', id: row.id })
	}
	return {
		entries,
		strict: !entries.some((entry) => entry.kind === 'cloud'),
		skipped,
	}
}

/** A queued run that ended unrun (expiry, revocation): mark it `expired`. */
export function markQueuedAttemptExpired(
	metadata: Record<string, unknown>,
	reason = 'queue_expired',
): Record<string, unknown> {
	return markQueuedAttempt(metadata, { outcome: 'expired', reason })
}

/** A queued run that the context took after reconnecting ran there. */
export function markQueuedAttemptRan(
	metadata: Record<string, unknown>,
): Record<string, unknown> {
	return markQueuedAttempt(metadata, { outcome: 'ran' })
}

/** Records a finished context run's timing on its run-record metadata. */
export function withRunTiming(
	metadata: Record<string, unknown>,
	timing: ExecutionContextRunTiming,
): Record<string, unknown> {
	const context = metadata.executionContext as
		| ExecutionContextRunMetadata
		| undefined
	if (!context) return metadata
	return { ...metadata, executionContext: { ...context, timing } }
}

function markQueuedAttempt(
	metadata: Record<string, unknown>,
	update: Pick<RoutingAttempt, 'outcome' | 'reason'>,
): Record<string, unknown> {
	const context = metadata.executionContext as
		| ExecutionContextRunMetadata
		| undefined
	if (!context?.attempts?.length) return metadata
	return {
		...metadata,
		executionContext: {
			...context,
			attempts: context.attempts.map((attempt, index) =>
				index === context.attempts.length - 1 && attempt.outcome === 'queued'
					? { ...attempt, ...update }
					: attempt,
			),
		},
	}
}

/**
 * A queued run acting as a profile waits for a reconnect; recheck its chain
 * and `execution_context:execute` before it dispatches. Null means it may run.
 */
export async function queuedProfileRefusal(input: {
	env: Env
	lease: Pick<
		ExecutionContextLease,
		'profileId' | 'orgId' | 'requester' | 'ecid' | 'runId'
	>
	context: { id: string; org_id: string }
}): Promise<string | null> {
	const { lease } = input
	if (!lease.profileId) return null
	const binding = await loadOrgBindingForOrg(
		input.env.APP_DB,
		lease.requester.userId,
		lease.orgId,
	)
	if (!binding) return 'the person this run acts as is no longer in the org'
	const request = deriveRequestContext({
		user: {
			userId: lease.requester.userId as PersonId,
			username: lease.requester.handle ?? lease.requester.userId,
		},
		source: {
			kind: 'execution-context-run',
			ecid: lease.ecid,
			runId: lease.runId,
		},
		orgBinding: binding,
		profileId: lease.profileId,
	})
	const access = await computeEffectivePermissions({ env: input.env, request })
	const decision = checkPermission(access, 'execution_context:execute', {
		type: 'execution_context',
		id: input.context.id,
		orgId: input.context.org_id as OwnerId,
	})
	return decision.allowed
		? null
		: 'the profile this run acts as, or a parent profile, is revoked, expired, or no longer granted execution_context:execute on it'
}
