import {
	type EcpCancelReason,
	type EcpGrant,
	type EcpRunRequestBody,
	sha256Base64Url,
} from '@kody-internal/shared/execution-context-protocol/index.ts'
import { type CredentialCallMap } from '#worker/credentials/credential-call-map.ts'
import { type RunRecordHandle } from '#worker/run-records/types.ts'
import { ExecutionContextError } from './errors.ts'
import {
	type ExecutionContextLease,
	type ExecutionContextRunResult,
} from './session-do.ts'
import { runChainShapeError, type ExecuteRequirement } from './chain-rules.ts'
import {
	type ChainEntry,
	type ExecutionContextRow,
	type UnusableReason,
	getChain,
	getExecutionContext,
	loadContextAccess,
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
}

/**
 * One line telling the caller that a run meant for an execution context
 * ran on Kody cloud instead, and why each context passed on it.
 */
export function describeCloudFallback(metadata: ExecutionContextRunMetadata) {
	const tried = metadata.attempts
		.map((attempt) => {
			const label = attempt.name
				? `${attempt.name} (${attempt.target})`
				: attempt.target
			return `${label}: ${attempt.outcome}${attempt.reason ? ` ${attempt.reason}` : ''}`
		})
		.join('; ')
	return `Ran on Kody cloud: no execution context in your chain took this run${tried ? ` (${tried})` : ''}.`
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

/** Why a grant cannot take this run, or null when it can. */
export function grantRefusal(input: {
	grant: EcpGrant
	requires: ReadonlyArray<ExecuteRequirement>
	credentials: CredentialCallMap | null
}): string | null {
	if (input.requires.includes('fs') && input.grant.fs.length === 0) {
		return 'no_fs'
	}
	if (
		input.requires.includes('lan') &&
		input.grant.egress.mode !== 'public-and-lan'
	) {
		return 'no_lan'
	}
	if (
		input.credentials &&
		input.credentials.size > 0 &&
		input.grant.credentials.mode === 'none'
	) {
		return 'credentials_not_allowed'
	}
	return null
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
	 * Queue on the first offline context until it reconnects, instead of
	 * failing, when nothing else can take the run (automations only).
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
		const access = await loadContextAccess(db, row, {
			userId: input.request.userId,
			orgId: input.request.orgId,
		})
		if (!access.usable) {
			skip(access.unusableReason ?? 'not_granted')
			continue
		}
		const grant = parseGrant(row)
		const refusal = grantRefusal({
			grant,
			requires,
			credentials: input.credentials,
		})
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
			credentialIds:
				grant.credentials.mode === 'list' ? grant.credentials.ids : [],
			runtime: grant.runtime,
			deadline,
			sharedRun: row.operator_user_id !== input.request.userId,
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
				firstOffline = { row, request, lease, requires }
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
				return {
					kind: 'ran',
					result: settled.result as ExecutionContextRunResult,
					metadata: ran,
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
		noContext(
			attempts,
			`${named.name} could not take this run (${describeAttempts(attempts)}). A named context never falls back; pass fallback: "chain" to use your chain instead.`,
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

function describeAttempts(attempts: ReadonlyArray<RoutingAttempt>) {
	return attempts
		.map(
			(a) =>
				`${a.name ?? a.target}: ${a.outcome}${a.reason ? ` (${a.reason})` : ''}`,
		)
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

/** A queued run that expired never ran: mark its queued attempt `expired`. */
export function markQueuedAttemptExpired(
	metadata: Record<string, unknown>,
): Record<string, unknown> {
	return markQueuedAttempt(metadata, {
		outcome: 'expired',
		reason: 'queue_expired',
	})
}

/** A queued run that the context took after reconnecting ran there. */
export function markQueuedAttemptRan(
	metadata: Record<string, unknown>,
): Record<string, unknown> {
	return markQueuedAttempt(metadata, { outcome: 'ran' })
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
