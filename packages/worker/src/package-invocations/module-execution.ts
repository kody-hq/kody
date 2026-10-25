import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { persistableExecutionArtifacts } from '#mcp/downstream-mcp-result.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import {
	type RunRecordContext,
	type RunRecordHandle,
} from '#worker/run-records/types.ts'
import { withRunStartedBy } from '#worker/run-records/service.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { getEntitySourceByIdForUser } from '#worker/repo/entity-sources.ts'
import {
	getEmailAttachmentById,
	getEmailMessageWithAttachmentsById,
} from '#worker/email/service.ts'
import { getInternalEmailMessageById } from '#worker/email/mailbox-internal-read.ts'
import { resolveBackgroundMcpUser } from '#worker/identity/background-mcp-user.ts'
import { isAccountSuspendedError } from '#worker/account/account-suspension.ts'
import {
	CredentialClientError,
	loadRunCredentialNeeds,
	openCredentialClient,
} from '#worker/credentials/credential-client.ts'
import { newRunCredentialClientBinding } from '#worker/credentials/credential-client-handle.ts'
import { isPackageCredentialSuppliersEnabled } from '#worker/credentials/credential-suppliers-flag.ts'
import { consumeDailyEntitlement } from '#worker/entitlements/service.ts'
import {
	budgetLimitErrorCode,
	computeOverageLimitErrorCode,
	entitlementLimitErrorCode,
	isBudgetLimitError,
	isComputeOverageLimitError,
	isEntitlementLimitError,
} from '#worker/entitlements/errors.ts'
import { authorize } from '#worker/authorization/authorize.ts'
import { getOrgById } from '#worker/orgs/repo.ts'
import {
	backgroundRunBilledActor,
	enablementIdOf,
} from '#worker/request-context/request-context.ts'
import {
	automationInvocationsPerDayResource,
	shouldConsumeAutomationInvocationEntitlement,
} from './automation-invocation-entitlement.ts'
import {
	buildPackageInvocationStorageId,
	createRepoContext,
	resolveInvocationMeteringSurface,
	resolveInvocationRuntimeName,
	resolveInvocationRuntimeSurface,
	sourceRevisionChangedErrorCode,
	type PackageInvocationActor,
	type PackageInvocationResponse,
	type PackageModuleSelector,
	type PackageRuntimeToolFactories,
	type PackageSourceRevisionOptions,
} from './common.ts'
import {
	ensureModuleArtifact,
	isMissingPackageModuleError,
	isTransientModuleArtifactError,
} from './module-artifacts.ts'
import { buildSubscriptionInvocationRunMetadata } from './subscription-envelope.ts'
import {
	buildExecutionErrorResponse,
	buildExecutionSuccessResponse,
	buildJsonErrorResponse,
} from './responses.ts'

/**
 * One saved-package module execution, uncoupled from durability:
 *
 * - `completed`: the sandbox ran and the export succeeded.
 * - `failed`: the sandbox ran and errored, the module/export was missing, the
 *   owning account is suspended (403 `account_suspended`; the keyed path
 *   checks this before claiming, so it only lands here mid-invocation), or an
 *   unexpected error interrupted the run. Keyed callers persist this as a
 *   terminal ledger state.
 * - `artifact-unavailable`: artifact preparation failed transiently before
 *   any sandbox work started. Nothing executed, so keyed callers release
 *   their claim and key-less callers can simply retry.
 * - `pre-execution-denied`: a gate before sandbox work rejected the invoke
 *   (daily automation quota, a pinned source revision that moved, or a
 *   missing required executor credential). Same release semantics as
 *   `artifact-unavailable` so a keyed retry can succeed after the UTC day
 *   rolls, the limit rises, or a credential is connected.
 *
 * `logs` / `result` / `error` carry what the registry would otherwise feed
 * its own run-record finish, for keyed callers that own the run record via
 * `externalRunRecordHandle` and finish it together with the ledger write.
 */
export type SavedPackageModuleRunOutcome =
	| {
			kind: 'completed'
			response: PackageInvocationResponse
			logs: Array<string>
			result: unknown
	  }
	| {
			kind: 'failed'
			response: PackageInvocationResponse
			logs: Array<string>
			error: unknown
	  }
	| {
			kind: 'artifact-unavailable'
			response: PackageInvocationResponse
			/** Underlying preparation failure, for the owner's run record. */
			error: unknown
	  }
	| { kind: 'pre-execution-denied'; response: PackageInvocationResponse }

export type SavedPackageModuleRunInput = {
	env: Env
	baseUrl: string
	actor: PackageInvocationActor
	savedPackage: SavedPackageRecord
	invocationName: string
	moduleSelector: PackageModuleSelector
	params?: Record<string, unknown>
	/**
	 * `null` for key-less (ephemeral) invocations: no ledger row exists, the
	 * response carries no `idempotency` section, and the run record downgrades
	 * to on-failure-only persistence (see `runPersistenceForContext`).
	 */
	idempotencyKey: string | null
	/** Ledger row id for keyed invocations; `null` for key-less ones. */
	invocationId: string | null
	source: string | null
	topic: string | null
	notFoundCode: 'export_not_found' | 'subscription_not_found'
	runtimeInvokeDepth?: number
	toolFactories: PackageRuntimeToolFactories
	waitUntil?: (promise: Promise<unknown>) => void
	/**
	 * Artifact already prepared by a host invoke check phase moments
	 * earlier; skips a second manifest + artifact load.
	 */
	preloadedModuleArtifact?: Awaited<
		ReturnType<typeof ensureModuleArtifact>
	> | null
	/**
	 * Sandbox wall-clock budget. Defaults to the execute/export 90s cap when
	 * omitted. Workflow invocations pass a longer budget so they can use the
	 * full Cloudflare Workflow step window.
	 */
	executorTimeoutMs?: number | null
	/** Parent execute deadline for cooperative cancellation of nested invokes. */
	signal?: AbortSignal
	/**
	 * Keyed path: the caller already claimed the run record together with the
	 * idempotency-ledger row (one DO call) and finishes both together from
	 * the outcome, so the registry must not begin or finish a run record of
	 * its own. The handle's context still feeds `parentRunRecord` for nested
	 * invoke/event tools, and is enriched here with the `publishedCommit`
	 * that is only known after the artifact loads.
	 */
	externalRunRecordHandle?: RunRecordHandle | null
	/** Report, and optionally pin, the commit this run resolves. */
	sourceRevision?: PackageSourceRevisionOptions | null
}

async function requiredExecutorCredentialError(input: {
	env: Env
	callerContext: ReturnType<typeof createMcpCallerContext>
	packageId: string
	idempotencyKey: string | null
}): Promise<PackageInvocationResponse | null> {
	const request = input.callerContext.request
	if (!request?.actor) return null
	if (
		enablementIdOf(request) ||
		request.credential.kind === 'package-app' ||
		!(await isPackageCredentialSuppliersEnabled({
			db: input.env.APP_DB,
			orgId: request.org.id,
			request,
		}))
	) {
		return null
	}
	const runNeeds = await loadRunCredentialNeeds({
		env: input.env,
		orgId: request.org.id,
		packageIds: [input.packageId],
		request,
	})
	const requiredNeeds = [...runNeeds.values()].filter(
		(need) => need.supplier === 'executor' && need.required !== false,
	)
	if (requiredNeeds.length === 0) return null

	const credentialContext = {
		env: input.env,
		callerContext: input.callerContext,
		binding: newRunCredentialClientBinding(),
		packageId: input.packageId,
		runNeeds: async () => runNeeds,
	}
	for (const need of requiredNeeds) {
		try {
			await openCredentialClient(credentialContext, { key: need.key })
		} catch (error) {
			if (!(error instanceof CredentialClientError)) throw error
			return buildJsonErrorResponse({
				status: 409,
				code: 'credential_required',
				message: `Required credential need "${need.key}" is not connected. Connect need:${need.key} before running this package.`,
				idempotencyKey: input.idempotencyKey ?? undefined,
			})
		}
	}
	return null
}

export async function runSavedPackageModuleOnce(
	input: SavedPackageModuleRunInput,
): Promise<SavedPackageModuleRunOutcome> {
	let executionStarted = false
	try {
		const user = await resolveBackgroundMcpUser(
			input.env.APP_DB,
			input.actor.orgId,
		)
		const { artifact, source: sourceRow } =
			input.preloadedModuleArtifact ??
			(await ensureModuleArtifact({
				env: input.env,
				baseUrl: input.baseUrl,
				savedPackage: input.savedPackage,
				selector: input.moduleSelector,
				userId: input.actor.orgId,
			}))
		const repoSource =
			artifact.packageContext?.sourceId == null ||
			artifact.packageContext.sourceId === sourceRow.id
				? sourceRow
				: await getEntitySourceByIdForUser(input.env.APP_DB, {
						id: artifact.packageContext.sourceId,
						userId: input.actor.orgId,
					})
		const resolvedPublishedCommit =
			artifact.publishedCommit ?? repoSource?.published_commit ?? null
		input.sourceRevision?.onResolved?.(resolvedPublishedCommit)
		const pinnedCommit = input.sourceRevision?.pinnedCommit ?? null
		if (pinnedCommit && pinnedCommit !== resolvedPublishedCommit) {
			return {
				kind: 'pre-execution-denied',
				response: buildJsonErrorResponse({
					status: 409,
					code: sourceRevisionChangedErrorCode,
					message: `Package "${input.savedPackage.kodyId}" was republished after this run was queued: it was pinned to commit ${pinnedCommit} but the published commit is now ${resolvedPublishedCommit ?? 'unknown'}. Nothing ran. Create a new workflow to run the current revision.`,
					idempotencyKey: input.idempotencyKey ?? undefined,
				}),
			}
		}
		if (
			shouldConsumeAutomationInvocationEntitlement({
				actorTokenId: input.actor.sourceId,
				runtimeInvokeDepth: input.runtimeInvokeDepth ?? 0,
			})
		) {
			// Sibling daily automation quota before sandbox work so over-limit
			// webhooks / package-export / subscription / workflow invokes cost
			// nothing. Failed attempts still count. Distinct from MCP
			// execute_unique_workers_per_day and scheduled job_runs_per_day.
			try {
				const orgRecord = await getOrgById(input.env.APP_DB, input.actor.orgId)
				const orgSlug = orgRecord?.slug?.trim() || user.username?.trim() || null
				const automationSource =
					input.actor.request.kind === 'schedule'
						? 'schedule'
						: input.actor.request.kind === 'webhook'
							? 'webhook'
							: input.actor.request.kind === 'inbound-email'
								? 'email'
								: 'event'
				const billedActor = backgroundRunBilledActor(input.actor.request)
				await consumeDailyEntitlement({
					db: input.env.APP_DB,
					env: input.env,
					userId: input.actor.orgId,
					email: user.email,
					resource: automationInvocationsPerDayResource,
					orgBudget: billedActor
						? {
								orgId: input.actor.orgId,
								orgSlug,
								actorUserId: billedActor.userId,
								actorUsername: billedActor.username,
							}
						: {
								orgId: input.actor.orgId,
								orgSlug,
								automationSource,
								actorUserId: null,
							},
				})
			} catch (error) {
				if (
					isEntitlementLimitError(error) ||
					isComputeOverageLimitError(error) ||
					isBudgetLimitError(error)
				) {
					return {
						kind: 'pre-execution-denied',
						response: buildJsonErrorResponse({
							status: 429,
							code: isEntitlementLimitError(error)
								? entitlementLimitErrorCode
								: isBudgetLimitError(error)
									? budgetLimitErrorCode
									: computeOverageLimitErrorCode,
							message: error.message,
							idempotencyKey: input.idempotencyKey ?? undefined,
							details: error.details,
						}),
					}
				}
				throw error
			}
		}
		const callerContext = createMcpCallerContext({
			baseUrl: input.baseUrl,
			executionOrigin: 'background',
			user,
			storageContext: {
				sessionId: null,
				appId: input.savedPackage.id,
				packageId: input.savedPackage.id,
				storageId: buildPackageInvocationStorageId(input.savedPackage.id),
			},
			repoContext: repoSource ? createRepoContext(repoSource) : null,
			source: input.actor.request,
			resourceEventDepth: input.actor.resourceEventDepth ?? null,
		})
		// A run reads org mail only with its person's email:read.
		const requireRunEmailRead = () =>
			authorize(
				{ env: input.env, request: callerContext.request },
				'email:read',
			)
		const runtimeSurface = resolveInvocationRuntimeSurface({
			selector: input.moduleSelector,
			source: input.source,
		})
		const packageContext = artifact.packageContext ?? {
			packageId: input.savedPackage.id,
			kodyId: input.savedPackage.kodyId,
			sourceId: input.savedPackage.sourceId,
		}
		const missingCredential = await requiredExecutorCredentialError({
			env: input.env,
			callerContext,
			packageId: packageContext.packageId,
			idempotencyKey: input.idempotencyKey,
		})
		if (missingCredential) {
			return { kind: 'pre-execution-denied', response: missingCredential }
		}
		const externalHandle = input.externalRunRecordHandle ?? null
		if (externalHandle) {
			// The caller claimed before the artifact loaded, so its context could
			// not know the published commit yet; enrich it for the terminal write.
			externalHandle.context = {
				...externalHandle.context,
				publishedCommit: resolvedPublishedCommit,
			}
		}
		const runRecord: RunRecordContext | null = externalHandle
			? externalHandle.context
			: runtimeSurface == null
				? null
				: withRunStartedBy(
						{
							packageId: input.savedPackage.id,
							kodyId: input.savedPackage.kodyId,
							sourceId: input.savedPackage.sourceId,
							publishedCommit: resolvedPublishedCommit,
							surface: runtimeSurface,
							name: resolveInvocationRuntimeName({
								surface: runtimeSurface,
								invocationName: input.invocationName,
								topic: input.topic,
							}),
							invocationId: input.invocationId,
							idempotencyKey: input.idempotencyKey,
							metadata: buildSubscriptionInvocationRunMetadata({
								exportName: input.invocationName,
								isSubscription: input.moduleSelector.kind === 'subscription',
								source: input.source,
								topic: input.topic,
								params: input.params,
							}),
						},
						callerContext.request,
					)
		executionStarted = true
		const executionResult = await runBundledModuleWithRegistry(
			input.env,
			callerContext,
			{
				mainModule: artifact.mainModule,
				modules: artifact.modules,
				dependencies: artifact.dependencies,
				...(artifact.packageBindingRewrite === undefined
					? {}
					: { packageBindingRewrite: artifact.packageBindingRewrite }),
			},
			input.params,
			{
				executorTimeoutMs: input.executorTimeoutMs,
				signal: input.signal,
				// No ambient `storage` binding: package code reaches its bucket via
				// `packageStorage()` (granted through packageContext below). Legacy
				// ambient use gets the structured runtime_helper_unbound hint.
				// Keyed callers own their run record (claimed with the ledger row);
				// the registry must not begin/finish a second one for this run.
				// Still pass the observed surface so UWD is not inferred as
				// package_export for subscription / webhook keyed runs.
				runRecord: externalHandle ? null : runRecord,
				runSurface:
					runRecord?.surface ??
					resolveInvocationMeteringSurface({
						selector: input.moduleSelector,
						source: input.source,
					}),
				emailTools: {
					getMessage: async (messageId) => {
						await requireRunEmailRead()
						const loaded = await getEmailMessageWithAttachmentsById({
							env: input.env,
							db: input.env.APP_DB,
							userId: input.actor.orgId,
							messageId,
						})
						if (!loaded) {
							throw new Error(`Email message not found: ${messageId}`)
						}
						return {
							id: loaded.message.id,
							direction: loaded.message.direction,
							inbox_id: loaded.message.inboxId,
							thread_id: loaded.message.threadId,
							from_address: loaded.message.fromAddress,
							envelope_from: loaded.message.envelopeFrom,
							to_addresses: loaded.message.toAddresses,
							cc_addresses: loaded.message.ccAddresses,
							bcc_addresses: loaded.message.bccAddresses,
							reply_to_addresses: loaded.message.replyToAddresses,
							subject: loaded.message.subject,
							message_id_header: loaded.message.messageIdHeader,
							in_reply_to_header: loaded.message.inReplyToHeader,
							references: loaded.message.references,
							headers: loaded.message.headers,
							auth_results: loaded.message.authResults,
							text_body: loaded.message.textBody,
							html_body: loaded.message.htmlBody,
							raw_size: loaded.message.rawSize,
							processing_status: loaded.message.processingStatus,
							provider_message_id: loaded.message.providerMessageId,
							delivery_status: loaded.message.deliveryStatus,
							delivery_status_at: loaded.message.deliveryStatusAt,
							error: loaded.message.error,
							received_at: loaded.message.receivedAt,
							sent_at: loaded.message.sentAt,
							created_at: loaded.message.createdAt,
							updated_at: loaded.message.updatedAt,
							attachments: loaded.attachments.map((attachment) => ({
								id: attachment.id,
								filename: attachment.filename,
								content_type: attachment.contentType,
								content_id: attachment.contentId,
								disposition: attachment.disposition,
								size: attachment.size,
								storage_kind: attachment.storageKind,
								storage_key: attachment.storageKey,
								created_at: attachment.createdAt,
							})),
						}
					},
					getAttachment: async (attachmentId) => {
						await requireRunEmailRead()
						const attachment = await getEmailAttachmentById({
							env: input.env,
							db: input.env.APP_DB,
							blobs: input.env.EMAIL_BLOBS,
							userId: input.actor.orgId,
							attachmentId,
						})
						if (!attachment) {
							throw new Error(`Email attachment not found: ${attachmentId}`)
						}
						const message = await getInternalEmailMessageById({
							env: input.env,
							ownerId: input.actor.orgId,
							messageId: attachment.messageId,
						})
						if (!message) {
							throw new Error(
								`Email message not found for attachment: ${attachment.messageId}`,
							)
						}
						return {
							id: attachment.id,
							message_id: attachment.messageId,
							filename: attachment.filename,
							content_type: attachment.contentType,
							content_id: attachment.contentId,
							disposition: attachment.disposition,
							size: attachment.size,
							storage_kind: attachment.storageKind,
							storage_key: attachment.storageKey,
							created_at: attachment.createdAt,
							message: {
								id: message.id,
								message_id_header: message.messageIdHeader,
								subject: message.subject,
							},
							content: attachment.content,
							content_base64: attachment.contentBase64,
						}
					},
				},
				packageContext,
				packageEventTools: input.toolFactories.createPackageEventTools({
					env: input.env,
					baseUrl: input.baseUrl,
					callerContext,
					packageContext,
					parentRunRecord: runRecord,
					packageInvokeDepth: input.runtimeInvokeDepth ?? 0,
					waitUntil: input.waitUntil,
				}),
				waitUntil: input.waitUntil,
			},
		)
		if (executionResult.error) {
			return {
				kind: 'failed',
				response: buildExecutionErrorResponse({
					savedPackage: input.savedPackage,
					invocationName: input.invocationName,
					idempotencyKey: input.idempotencyKey,
					source: input.source,
					topic: input.topic,
					error: executionResult.error,
					logs: executionResult.logs ?? [],
				}),
				logs: executionResult.logs ?? [],
				error: executionResult.error,
			}
		}
		const persistedArtifacts = persistableExecutionArtifacts(
			executionResult.result,
		)
		return {
			kind: 'completed',
			response: buildExecutionSuccessResponse({
				savedPackage: input.savedPackage,
				invocationName: input.invocationName,
				idempotencyKey: input.idempotencyKey,
				source: input.source,
				topic: input.topic,
				result: persistedArtifacts.result,
				rawContent: persistedArtifacts.rawContent,
				rawContentOmitted: persistedArtifacts.rawContentOmitted,
				logs: executionResult.logs ?? [],
			}),
			logs: executionResult.logs ?? [],
			result: persistedArtifacts.result,
		}
	} catch (error) {
		if (isAccountSuspendedError(error)) {
			return {
				kind: 'failed',
				response: buildJsonErrorResponse({
					status: 403,
					code: error.code,
					message: error.message,
					idempotencyKey: input.idempotencyKey ?? undefined,
				}),
				logs: [],
				error,
			}
		}
		if (
			!executionStarted &&
			!isMissingPackageModuleError(error) &&
			isTransientModuleArtifactError(error)
		) {
			return {
				kind: 'artifact-unavailable',
				response: buildJsonErrorResponse({
					status: 503,
					code: 'artifact_preparation_failed',
					message:
						'Package artifact preparation failed before execution. Please retry.',
					idempotencyKey: input.idempotencyKey ?? undefined,
				}),
				error,
			}
		}
		if (isMissingPackageModuleError(error)) {
			return {
				kind: 'failed',
				response: buildJsonErrorResponse({
					status: 404,
					code: input.notFoundCode,
					message: getErrorMessage(error),
					idempotencyKey: input.idempotencyKey ?? undefined,
				}),
				logs: [],
				error,
			}
		}
		return {
			kind: 'failed',
			response: buildJsonErrorResponse({
				status: 500,
				code: 'invocation_failed',
				message: getErrorMessage(error),
				idempotencyKey: input.idempotencyKey ?? undefined,
			}),
			logs: [],
			error,
		}
	}
}

/**
 * Key-less (lean) invocation path: contract-checked upstream, executed in the
 * target package's own runtime, with no idempotency ledger row, no account
 * write lease, and run records persisted on failure only. This is the
 * ephemeral counterpart to `invokeSavedPackageModule` (the keyed,
 * exactly-once path).
 */
export async function runSavedPackageModuleEphemeral(
	input: Omit<
		SavedPackageModuleRunInput,
		'idempotencyKey' | 'invocationId' | 'externalRunRecordHandle'
	>,
): Promise<PackageInvocationResponse> {
	const outcome = await runSavedPackageModuleOnce({
		...input,
		idempotencyKey: null,
		invocationId: null,
		externalRunRecordHandle: null,
	})
	return outcome.response
}
