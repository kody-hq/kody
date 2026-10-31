import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { type AutomationRouting } from '#worker/execution-contexts/automation-execution.ts'
import { type AutomationExecutionTarget } from '#worker/execution-contexts/automation-settings.ts'
import {
	createPackageInvocationClientDisconnectedError,
	isCallerDisconnectAbort,
	packageInvocationClientDisconnectedErrorName,
	packageInvocationStartedLog,
} from '#worker/caller-disconnect.ts'
import {
	claimPackageInvocationRecord,
	finishPackageInvocationRecord,
	getPackageInvocationRecord,
	releasePackageInvocationRecord,
	stagePackageInvocationResultRecord,
	touchPackageInvocationRecord,
	type PackageInvocationLedgerRecord,
} from '#worker/run-records/service.ts'
import {
	type RunRecordContext,
	type RunRecordHandle,
} from '#worker/run-records/types.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { isAccountSuspendedError } from '#worker/account/account-suspension.ts'
import { resolveBackgroundMcpUser } from '#worker/identity/background-mcp-user.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import {
	buildPackageInvocationStorageId,
	resolveInvocationRuntimeName,
	resolveInvocationRuntimeSurface,
	type PackageInvocationActor,
	type PackageModuleSelector,
	type PackageRuntimeToolFactories,
} from './common.ts'
import {
	createRequestHash,
	resolveExistingInvocation,
	type ResolvableInvocationRecord,
} from './idempotency.ts'
import { type ensureModuleArtifact } from './module-artifacts.ts'
import { runSavedPackageModuleOnce } from './module-execution.ts'
import { buildJsonErrorResponse } from './responses.ts'
import { buildSubscriptionInvocationRunMetadata } from './subscription-envelope.ts'
import {
	boundedResponseJson,
	executionFenceResponseJson,
	parseStoredResponse,
	terminalResponseJsonFromExecutionFence,
	type PackageInvocationStoredResponse,
} from './repo.ts'
import { summarizeInvocationError } from './invocation-error-summary.ts'

export const packageInvocationStaleAfterMs = 15 * 60 * 1000
/**
 * Same-delivery reclaim grace. Shorter than the ack queue retry budget
 * (~5 minutes) so a hung first attempt can be taken over, but longer than a
 * single 30s queue retry so a failed terminal persist after a successful
 * execute is not immediately reclaimed and re-run on the next delivery.
 * Staged outcomes (`response_json` set while still `in_progress`) never
 * reclaim — see {@link canReclaimInProgressInvocation}.
 */
export const packageInvocationSameOwnerStaleAfterMs = 60_000
const packageInvocationPollIntervalMs = 100
const packageInvocationPollBudgetMs = 1_000

function isStaleInvocation(updatedAt: string, now: Date) {
	return Date.parse(updatedAt) <= now.getTime() - packageInvocationStaleAfterMs
}

function normalizeClaimOwner(value: string | null | undefined): string | null {
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : null
}

function canReclaimInProgressInvocation(input: {
	record: Pick<
		PackageInvocationLedgerRecord,
		'updatedAt' | 'claimOwner' | 'responseJson'
	>
	claimOwner: string | null
	now?: Date
}) {
	// Staged execute outcome: durable fence — retries promote, never re-run.
	if (input.record.responseJson != null) {
		return false
	}
	const now = input.now ?? new Date()
	if (isStaleInvocation(input.record.updatedAt, now)) {
		return true
	}
	if (
		input.claimOwner == null ||
		input.record.claimOwner == null ||
		input.claimOwner !== input.record.claimOwner
	) {
		return false
	}
	return (
		Date.parse(input.record.updatedAt) <=
		now.getTime() - packageInvocationSameOwnerStaleAfterMs
	)
}

function readInvocationErrorCode(body: unknown): string | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const error = (body as Record<string, unknown>)['error']
	if (!error || typeof error !== 'object' || Array.isArray(error)) return null
	const code = (error as Record<string, unknown>)['code']
	return typeof code === 'string' ? code : null
}

function readInvocationErrorMessage(body: unknown): string | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const error = (body as Record<string, unknown>)['error']
	if (!error || typeof error !== 'object' || Array.isArray(error)) return null
	const message = (error as Record<string, unknown>)['message']
	return typeof message === 'string' ? message : null
}

function toResolvableLedgerRecord(
	record: PackageInvocationLedgerRecord,
): ResolvableInvocationRecord {
	return {
		requestHash: record.requestHash,
		status: record.status,
		storedResponse: parseStoredResponse(record.responseJson),
	}
}

type ClaimedInvocation = {
	invocationId: string
	claimUpdatedAt: string
	handle: RunRecordHandle | null
}

/**
 * Keyed (exactly-once) invocation path. The idempotency ledger lives in the
 * per-user RunLog Durable Object: the claim and the eager run-record begin
 * are one awaited DO call, and the terminal response and run-record finish
 * are one awaited DO call. Key-less callers take
 * `runSavedPackageModuleEphemeral` in module-execution.ts instead — the
 * execution itself is shared via `runSavedPackageModuleOnce`.
 *
 * This path performs no D1 ledger reads or writes. Only keys present in the
 * RunLog ledger replay; a redelivery for any absent key executes fresh.
 *
 * This path deliberately takes no `withAccountWriteLease`: the lease guards
 * D1 writes against concurrent account deletion, and no D1 writes remain
 * here. D1 writes made by the executing package go through capability
 * services that hold their own leases — the same guard profile the key-less
 * lean path shipped with. The DO rows this path writes are purged by account
 * deletion's `clearRunRecords`, and a write racing past that purge is the
 * same accepted residual as every other run-record write, bounded by the
 * DO's own retention.
 */
export async function invokeSavedPackageModule(input: {
	env: Env
	baseUrl: string
	actor: PackageInvocationActor
	savedPackage: SavedPackageRecord
	invocationName: string
	moduleSelector: PackageModuleSelector
	params?: Record<string, unknown>
	idempotencyKey: string
	idempotencyParamsHash?: 'ignore'
	idempotencyHashParams?: Record<string, unknown>
	/**
	 * Delivery/attempt lineage for reclaim (for example webhook ack
	 * `deliveryId`). Same-owner retries take over a fresh `in_progress`
	 * claim; omit for callers that only reclaim after the stale window.
	 */
	claimOwner?: string | null
	source: string | null
	topic: string | null
	notFoundCode: 'export_not_found' | 'subscription_not_found'
	runtimeInvokeDepth?: number
	toolFactories: PackageRuntimeToolFactories
	waitUntil?: (promise: Promise<unknown>) => void
	/**
	 * Artifact already prepared by a host invoke check phase moments
	 * earlier; skips a second manifest + artifact load. The claim still
	 * happens first, so replay semantics are unchanged.
	 */
	preloadedModuleArtifact?: Awaited<
		ReturnType<typeof ensureModuleArtifact>
	> | null
	executorTimeoutMs?: number | null
	signal?: AbortSignal
	/** Where an automation asked to run (execution contexts). */
	executionRouting?: AutomationRouting | null
	/** Declared automation whose execution setting applies. */
	executionTarget?: AutomationExecutionTarget | null
}) {
	// Before the ledger: a suspended owner must neither replay a stored
	// response nor leave a terminal denial that outlives the suspension.
	// Other identity failures fall through to module execution, which
	// reports them as before. Keep a successful identity for started_by.
	const backgroundIdentity = await resolveBackgroundMcpUser(
		input.env.APP_DB,
		input.actor.orgId,
	).then(
		(user) => ({ ok: true as const, user }),
		(error: unknown) =>
			isAccountSuspendedError(error)
				? { ok: false as const, suspension: error }
				: { ok: false as const, suspension: null },
	)
	if (!backgroundIdentity.ok && backgroundIdentity.suspension) {
		return buildJsonErrorResponse({
			status: 403,
			code: backgroundIdentity.suspension.code,
			message: backgroundIdentity.suspension.message,
			idempotencyKey: input.idempotencyKey,
		})
	}
	const claimRequest = backgroundIdentity.ok
		? deriveRequestContext({
				user: backgroundIdentity.user,
				source: input.actor.request,
			})
		: null
	const requestHash = await createRequestHash({
		packageId: input.savedPackage.id,
		exportName: input.invocationName,
		params:
			input.idempotencyParamsHash === 'ignore'
				? undefined
				: (input.idempotencyHashParams ?? input.params),
		source: input.source,
		topic: input.topic,
	})
	const ledgerKey = {
		tokenId: input.actor.sourceId,
		packageId: input.savedPackage.id,
		exportName: input.invocationName,
		idempotencyKey: input.idempotencyKey,
	}

	const resolveLedgerRecord = (record: PackageInvocationLedgerRecord) =>
		resolveExistingInvocation({
			record: toResolvableLedgerRecord(record),
			requestHash,
			idempotencyKey: input.idempotencyKey,
			paramsHash:
				input.idempotencyParamsHash === 'ignore' ? 'ignore' : 'include',
		})
	const buildLookupFailedResponse = () =>
		buildJsonErrorResponse({
			status: 500,
			code: 'idempotency_lookup_failed',
			message:
				'Unable to look up the package invocation idempotency record. Please retry.',
			idempotencyKey: input.idempotencyKey,
		})
	const buildPersistenceFailedResponse = () =>
		buildJsonErrorResponse({
			status: 500,
			code: 'idempotency_persistence_failed',
			message:
				'Unable to persist the package invocation idempotency record. Please retry.',
			idempotencyKey: input.idempotencyKey,
		})

	const buildRunRecordContext = (): RunRecordContext | null => {
		const runtimeSurface = resolveInvocationRuntimeSurface({
			selector: input.moduleSelector,
			source: input.source,
		})
		// `null` surface: the caller (package-backed workflows) owns the run
		// record, so the claim writes only the ledger row.
		if (runtimeSurface == null) return null
		return {
			packageId: input.savedPackage.id,
			kodyId: input.savedPackage.kodyId,
			sourceId: input.savedPackage.sourceId,
			// Known only after the artifact loads; module-execution enriches the
			// handle context before the terminal write.
			publishedCommit: null,
			storageId: buildPackageInvocationStorageId(input.savedPackage.id),
			surface: runtimeSurface,
			name: resolveInvocationRuntimeName({
				surface: runtimeSurface,
				invocationName: input.invocationName,
				topic: input.topic,
			}),
			invocationId: null,
			idempotencyKey: input.idempotencyKey,
			metadata: buildSubscriptionInvocationRunMetadata({
				exportName: input.invocationName,
				isSubscription: input.moduleSelector.kind === 'subscription',
				source: input.source,
				topic: input.topic,
				params: input.params,
			}),
		}
	}

	const claimOwner = normalizeClaimOwner(input.claimOwner)
	const attemptClaim = async () => {
		const nowMs = Date.now()
		return await claimPackageInvocationRecord({
			env: input.env,
			userId: input.actor.orgId,
			context: buildRunRecordContext(),
			request: claimRequest,
			invocation: {
				id: crypto.randomUUID(),
				...ledgerKey,
				packageKodyId: input.savedPackage.kodyId,
				requestHash,
				source: input.source,
				topic: input.topic,
				claimOwner,
			},
			staleBefore: new Date(
				nowMs - packageInvocationStaleAfterMs,
			).toISOString(),
			sameOwnerStaleBefore: new Date(
				nowMs - packageInvocationSameOwnerStaleAfterMs,
			).toISOString(),
		})
	}
	const lookupLedger = async () =>
		await getPackageInvocationRecord({
			env: input.env,
			userId: input.actor.orgId,
			key: ledgerKey,
		})
	let claim: Awaited<ReturnType<typeof attemptClaim>>
	try {
		claim = await attemptClaim()
	} catch (error) {
		console.error('package invocation idempotency persistence failed', error)
		return buildPersistenceFailedResponse()
	}

	const promoteStagedInvocation = async (
		record: PackageInvocationLedgerRecord,
	): Promise<PackageInvocationStoredResponse> => {
		const terminalResponseJson = terminalResponseJsonFromExecutionFence(
			record.responseJson,
		)
		try {
			const finished = await finishPackageInvocationRecord({
				env: input.env,
				userId: input.actor.orgId,
				handle: null,
				invocationId: record.id,
				claimUpdatedAt: record.updatedAt,
				ledgerStatus: 'completed',
				responseJson: terminalResponseJson,
				status: 'success',
				waitUntil: input.waitUntil,
			})
			if (finished.ledgerUpdated) {
				return (
					parseStoredResponse(terminalResponseJson) ??
					buildJsonErrorResponse({
						status: 500,
						code: 'idempotency_response_unavailable',
						message: 'Package invocation result lost its recovery claim.',
						idempotencyKey: input.idempotencyKey,
					})
				)
			}
			return finished.record
				? resolveLedgerRecord(finished.record)
				: buildPersistenceFailedResponse()
		} catch (error) {
			console.error(
				'package invocation staged-result promotion failed',
				getErrorMessage(error),
			)
			return buildPersistenceFailedResponse()
		}
	}

	// Resolve an existing DO owner: mismatch and terminal rows resolve
	// immediately; fresh in-progress rows are polled within the budget; stale
	// or same-claimOwner in-progress rows are reclaimed atomically by a second
	// claim call (which loops back here when a competitor wins the reclaim).
	// Staged `response_json` on an in-progress row is an execution fence:
	// promote to completed without re-running.
	while (claim.outcome === 'existing') {
		let record: PackageInvocationLedgerRecord | null = claim.record
		if (record.requestHash !== requestHash || record.status !== 'in_progress') {
			return resolveLedgerRecord(record)
		}
		if (record.responseJson != null) {
			return await promoteStagedInvocation(record)
		}
		const pollDeadline = Date.now() + packageInvocationPollBudgetMs
		while (
			record &&
			record.status === 'in_progress' &&
			!canReclaimInProgressInvocation({ record, claimOwner }) &&
			Date.now() < pollDeadline
		) {
			await new Promise((resolve) =>
				setTimeout(resolve, packageInvocationPollIntervalMs),
			)
			try {
				record = await lookupLedger()
			} catch (error) {
				console.error('package invocation idempotency lookup failed', error)
				return buildLookupFailedResponse()
			}
		}
		if (!record) {
			// The owner released its claim (transient artifact failure) and the
			// key is free again; the caller retries rather than us re-claiming
			// mid-poll.
			return buildJsonErrorResponse({
				status: 500,
				code: 'idempotency_conflict_unresolved',
				message: 'Package invocation disappeared while polling.',
				idempotencyKey: input.idempotencyKey,
			})
		}
		if (record.status !== 'in_progress') {
			return resolveLedgerRecord(record)
		}
		if (record.responseJson != null) {
			return await promoteStagedInvocation(record)
		}
		if (!canReclaimInProgressInvocation({ record, claimOwner })) {
			return resolveLedgerRecord(record)
		}
		try {
			claim = await attemptClaim()
		} catch (error) {
			console.error('package invocation idempotency persistence failed', error)
			return buildPersistenceFailedResponse()
		}
	}

	const claimed: ClaimedInvocation = {
		invocationId: claim.invocationId,
		claimUpdatedAt: claim.claimUpdatedAt,
		handle: claim.handle,
	}
	const startedLog = packageInvocationStartedLog(claimed.handle?.context.name)
	let disconnectFinishSucceeded = false
	let disconnectResponse: PackageInvocationStoredResponse | null = null
	let disconnectFinish: Promise<void> | null = null
	const finishForCallerDisconnect = () => {
		const signal = input.signal
		if (!signal || !isCallerDisconnectAbort(signal)) return
		if (disconnectFinish || disconnectFinishSucceeded) return
		const error = createPackageInvocationClientDisconnectedError()
		disconnectResponse = buildJsonErrorResponse({
			status: 408,
			code: packageInvocationClientDisconnectedErrorName,
			message: error.message,
			idempotencyKey: input.idempotencyKey,
		})
		const pending = finishPackageInvocationRecord({
			env: input.env,
			userId: input.actor.orgId,
			handle: claimed.handle,
			invocationId: claimed.invocationId,
			claimUpdatedAt: claimed.claimUpdatedAt,
			ledgerStatus: 'failed',
			responseJson: boundedResponseJson(disconnectResponse),
			status: 'error',
			logs: [startedLog],
			error,
			waitUntil: input.waitUntil,
		}).then(
			(finished) => {
				if (!finished.ledgerUpdated) {
					// Another terminal write won the fence. Replay that durable
					// result instead of treating the local disconnect 408 as
					// the stored response (same as completed/failed finishes).
					disconnectResponse = finished.record
						? resolveLedgerRecord(finished.record)
						: buildJsonErrorResponse({
								status: 500,
								code: 'idempotency_response_unavailable',
								message: 'Package invocation result lost its recovery claim.',
								idempotencyKey: input.idempotencyKey,
							})
				}
				disconnectFinishSucceeded = true
			},
			(finishError: unknown) => {
				console.warn(
					'package invocation disconnect finish failed',
					getErrorMessage(finishError),
				)
				// Allow the settled sandbox outcome to attempt a normal fenced
				// finish so a transient DO write failure does not leave the key
				// in_progress after the caller already disconnected.
				disconnectFinish = null
			},
		)
		disconnectFinish = pending
		input.waitUntil?.(pending)
	}
	const onCallerDisconnect = () => {
		finishForCallerDisconnect()
	}
	if (input.signal) {
		if (input.signal.aborted) onCallerDisconnect()
		else {
			input.signal.addEventListener('abort', onCallerDisconnect, {
				once: true,
			})
		}
	}
	if (disconnectFinishSucceeded) {
		if (disconnectResponse) return disconnectResponse
	} else if (disconnectFinish) {
		await disconnectFinish
		if (disconnectFinishSucceeded && disconnectResponse) {
			return disconnectResponse
		}
	}
	const outcome = await runSavedPackageModuleOnce({
		env: input.env,
		baseUrl: input.baseUrl,
		actor: input.actor,
		savedPackage: input.savedPackage,
		invocationName: input.invocationName,
		moduleSelector: input.moduleSelector,
		params: input.params,
		idempotencyKey: input.idempotencyKey,
		invocationId: claimed.invocationId,
		source: input.source,
		topic: input.topic,
		notFoundCode: input.notFoundCode,
		runtimeInvokeDepth: input.runtimeInvokeDepth,
		toolFactories: input.toolFactories,
		waitUntil: input.waitUntil,
		preloadedModuleArtifact: input.preloadedModuleArtifact,
		executorTimeoutMs: input.executorTimeoutMs,
		signal: input.signal,
		externalRunRecordHandle: claimed.handle,
		executionRouting: input.executionRouting ?? null,
		executionTarget: input.executionTarget ?? null,
	})
	input.signal?.removeEventListener('abort', onCallerDisconnect)
	if (disconnectFinish) {
		await disconnectFinish
	}
	if (disconnectFinishSucceeded && disconnectResponse) {
		return disconnectResponse
	}
	const logsWithStartedLine = (logs: Array<string>) =>
		logs.includes(startedLog) ? logs : [startedLog, ...logs]
	switch (outcome.kind) {
		case 'artifact-unavailable':
		case 'pre-execution-denied': {
			// Nothing ran: free the key so a later retry (quota reset, limit
			// bump, or artifact prepare) is not stuck replaying this response.
			// Finish the claimed run as an error with logs (do not delete it)
			// so Activity keeps pre-execution evidence instead of a vanished
			// zero-log attempt.
			const releaseSummary =
				outcome.kind === 'artifact-unavailable'
					? 'Package artifact preparation failed before execution.'
					: 'Package invocation denied before execution.'
			// Keep the real cause (sanitized) on the run record so Activity
			// and any webhook run that wraps this export show why it failed.
			const releaseDetail =
				outcome.kind === 'artifact-unavailable'
					? summarizeInvocationError(outcome.error)
					: summarizeInvocationError(
							readInvocationErrorMessage(outcome.response.body),
						)
			const releaseReason = releaseDetail
				? `${releaseSummary} ${releaseDetail}`
				: releaseSummary
			const releaseErrorCode = readInvocationErrorCode(outcome.response.body)
			const release = await releasePackageInvocationRecord({
				env: input.env,
				userId: input.actor.orgId,
				invocationId: claimed.invocationId,
				claimUpdatedAt: claimed.claimUpdatedAt,
				handle: claimed.handle,
				error: {
					name: releaseErrorCode ?? outcome.kind,
					message: releaseReason,
				},
				logs: [
					startedLog,
					{
						level: 'error',
						message: releaseReason,
						fields: {
							kind: outcome.kind,
							...(releaseErrorCode ? { code: releaseErrorCode } : {}),
						},
					},
				],
				waitUntil: input.waitUntil,
			})
			if (!release.released) {
				const current = release.record
				if (current?.status !== 'in_progress') {
					return current
						? resolveLedgerRecord(current)
						: buildJsonErrorResponse({
								status: 500,
								code: 'idempotency_conflict_unresolved',
								message:
									outcome.kind === 'artifact-unavailable'
										? 'Transient artifact preparation lost its invocation claim.'
										: 'Pre-execution denial lost its invocation claim.',
								idempotencyKey: input.idempotencyKey,
							})
				}
			}
			return outcome.response
		}
		case 'completed': {
			try {
				const finished = await finishPackageInvocationRecord({
					env: input.env,
					userId: input.actor.orgId,
					handle: claimed.handle,
					invocationId: claimed.invocationId,
					claimUpdatedAt: claimed.claimUpdatedAt,
					ledgerStatus: 'completed',
					responseJson: boundedResponseJson(outcome.response),
					status: 'success',
					logs: outcome.logs,
					result: outcome.result,
					waitUntil: input.waitUntil,
				})
				if (finished.ledgerUpdated) return outcome.response
				return finished.record
					? resolveLedgerRecord(finished.record)
					: buildJsonErrorResponse({
							status: 500,
							code: 'idempotency_response_unavailable',
							message: 'Package invocation result lost its recovery claim.',
							idempotencyKey: input.idempotencyKey,
						})
			} catch (error) {
				// The module succeeded, but the atomic ledger + run terminal write
				// did not. Stage the response (execution fence) so retries promote
				// without re-running side effects; fall back to a lease touch when
				// staging is also unavailable.
				console.error(
					'package invocation completed-result persistence failed',
					getErrorMessage(error),
				)
				const responseJson = executionFenceResponseJson(
					boundedResponseJson(outcome.response),
				)
				try {
					const staged = await stagePackageInvocationResultRecord({
						env: input.env,
						userId: input.actor.orgId,
						handle: claimed.handle,
						invocationId: claimed.invocationId,
						claimUpdatedAt: claimed.claimUpdatedAt,
						responseJson,
						status: 'success',
						logs: outcome.logs,
						result: outcome.result,
						waitUntil: input.waitUntil,
					})
					if (staged.staged && staged.claimUpdatedAt) {
						claimed.claimUpdatedAt = staged.claimUpdatedAt
					} else {
						const touched = await touchPackageInvocationRecord({
							env: input.env,
							userId: input.actor.orgId,
							invocationId: claimed.invocationId,
							claimUpdatedAt: claimed.claimUpdatedAt,
						})
						if (touched.touched && touched.claimUpdatedAt) {
							claimed.claimUpdatedAt = touched.claimUpdatedAt
						}
					}
				} catch (stageError) {
					console.warn(
						'package invocation result staging after persist failure failed',
						getErrorMessage(stageError),
					)
					try {
						const touched = await touchPackageInvocationRecord({
							env: input.env,
							userId: input.actor.orgId,
							invocationId: claimed.invocationId,
							claimUpdatedAt: claimed.claimUpdatedAt,
						})
						if (touched.touched && touched.claimUpdatedAt) {
							claimed.claimUpdatedAt = touched.claimUpdatedAt
						}
					} catch (touchError) {
						console.warn(
							'package invocation claim touch after persist failure failed',
							getErrorMessage(touchError),
						)
					}
				}
				return buildPersistenceFailedResponse()
			}
		}
		case 'failed': {
			try {
				const finished = await finishPackageInvocationRecord({
					env: input.env,
					userId: input.actor.orgId,
					handle: claimed.handle,
					invocationId: claimed.invocationId,
					claimUpdatedAt: claimed.claimUpdatedAt,
					ledgerStatus: 'failed',
					responseJson: boundedResponseJson(outcome.response),
					status: 'error',
					logs: logsWithStartedLine(outcome.logs),
					error: outcome.error,
					waitUntil: input.waitUntil,
				})
				if (finished.ledgerUpdated) return outcome.response
				return finished.record
					? resolveLedgerRecord(finished.record)
					: buildJsonErrorResponse({
							status: 500,
							code: 'idempotency_response_unavailable',
							message: 'Package invocation result lost its recovery claim.',
							idempotencyKey: input.idempotencyKey,
						})
			} catch (error) {
				// Best effort; preserve the original invocation error.
				console.warn(
					'package invocation terminal persistence failed',
					getErrorMessage(error),
				)
				return outcome.response
			}
		}
		default: {
			const exhaustive: never = outcome
			void exhaustive
			throw new Error('Unhandled package module run outcome.')
		}
	}
}
