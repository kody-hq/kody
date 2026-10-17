import {
	personalOrgId,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import * as Sentry from '@sentry/cloudflare'
import { getPackageAppBaseUrl } from '#worker/app-base-url.ts'
import { stampFirstSearch } from '#worker/identity/activation-stamps.ts'
import { resolvePublicUsername } from '#worker/identity/user-lookup.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'
import { isMcpCallerError } from '#mcp/caller-error.ts'
import { entitlementStructuredContent } from '#mcp/entitlement-metadata.ts'
import { rateLimitStructuredContent } from '#mcp/rate-limit-metadata.ts'
import {
	callerContextFields,
	errorFields,
	logMcpEvent,
} from '#mcp/observability.ts'

import {
	escapeMarkdownText,
	formatMarkdownInlineCode,
} from './markdown-safety.ts'
import { formatSurfacedMemoriesMarkdown } from './memory-tool-context.ts'
import {
	defaultMaxResponseSize,
	defaultSearchLimit,
	domainBrowseDefaultLimit,
	maxChars,
	SEARCH_ONBOARDING_NOTICE_BUDGET_MS,
	SEARCH_WAITING_ITEMS_BUDGET_MS,
} from './search-constants.ts'
import { resolveEntityDetail } from './search-detail.ts'
import { buildRecommendedNextStep } from './search-descriptors.ts'
import {
	executeSearchList,
	type SearchListExecutionResult,
} from './search-execution.ts'
import {
	formatEntityDetailMarkdown,
	formatSearchMarkdown,
	type SearchEntityDetailStructured,
	type SearchMatch,
	type SearchResultStructuredContent,
	toSlimStructuredMatches,
} from './search-format.ts'
import { loadSearchRowsAndRegistry } from './search-loaders.ts'
import {
	applyMaxResponseSize,
	truncateSearchText,
} from './search-response-size.ts'
import {
	encodeSearchTop1Type,
	recordSearchObservabilityEvent,
} from './search-observability.ts'
import {
	elapsedMs,
	reconcileSearchPhaseTimings,
	runWithSearchDeadline,
	settleWithBudget,
	toSearchServerTiming,
} from './search-timing.ts'
import { type SearchPhaseTimings } from './search-types.ts'
import { type SearchIntent } from './understand-search-query.ts'
import { type SearchToolArgs } from './search-tool-definition.ts'
import { buildOnboardingSearchNotice } from './search-onboarding-notice.ts'
import { resolveConversationId } from './tool-call-context.ts'
import { prependToolMetadataContent } from './tool-response-content.ts'
import { finishToolTiming, startToolTiming } from './tool-timing.ts'
import { deriveWaitingItemsForStableUser } from '#mcp/waiting/derive-waiting.ts'
import {
	formatSearchWaitingMarkdown,
	toSearchWaitingStructured,
} from './search-waiting.ts'

/** Bound on remembered notice conversations; oldest entries fall off. */
const maxOnboardingNoticeConversationIds = 256
/** Sessions without conversation ids see the notice at most this often. */
const onboardingNoticeCooldownMs = 6 * 60 * 60 * 1000

/**
 * List-mode guidance after size trim. Recomputes from retained matches so
 * call-contract tips never point at a dropped hit, but preserves domain-browse
 * truncation notices that encode the full-domain count.
 */
function resolveListGuidance(input: {
	trimmedMatches: ReadonlyArray<SearchMatch>
	query: string
	intent: SearchIntent
	preTrimGuidance: string | undefined
}): string | undefined {
	const preTrim = input.preTrimGuidance
	if (
		preTrim?.startsWith('Domain listing truncated:') &&
		input.trimmedMatches.length > 0 &&
		input.trimmedMatches.every((match) => match.type === 'capability')
	) {
		const totalMatch = /of (\d+) capabilities/.exec(preTrim)
		const domainMatch = /in ("(?:\\.|[^"\\])*")/.exec(preTrim)
		if (totalMatch && domainMatch) {
			return `Domain listing truncated: showing the first ${String(input.trimmedMatches.length)} of ${totalMatch[1]} capabilities in ${domainMatch[1]}. Raise "limit" or call metaListCapabilities({ domain: ${domainMatch[1]} }) from execute for the complete list.`
		}
		return preTrim
	}
	return buildRecommendedNextStep({
		query: input.query,
		intent: input.intent,
		matches: [...input.trimmedMatches],
	})
}

async function stampFirstSearchIfAuthenticated(
	env: Env,
	userId: OwnerId | null,
) {
	if (!userId) return
	const db = env.APP_DB
	if (!db) return
	// Await the write. List-mode search builds the leftover-steps notice in
	// the same request, and waitUntil would leave first_search_at unset so
	// the notice still says Step 2 is left after this search completed it.
	try {
		await stampFirstSearch(db, { stableUserId: userId }, env)
	} catch (error: unknown) {
		console.warn('activation-stamp-search-failed', error)
	}
}

export async function runSearchTool(input: {
	env: Env
	callerContext: McpCallerContext
	args: SearchToolArgs
	/**
	 * MCP Durable Object, when this call is the `search` tool. HTTP omits it;
	 * preamble and onboarding-notice memory stay request-local.
	 */
	mcpAgent?: object
}) {
	const { env, callerContext, args } = input
	const agent = (input.mcpAgent ?? {
		getEnv: () => env,
		getCallerContext: () => callerContext,
	}) as {
		getEnv: () => Env
		getCallerContext: () => McpCallerContext
		state?: {
			searchConversationIdsWithPreamble?: Array<string>
			onboardingNoticeConversationIds?: Array<string>
			onboardingNoticeLastShownAtMs?: number
		}
		setState?: (state: {
			searchConversationIdsWithPreamble?: Array<string>
			onboardingNoticeConversationIds?: Array<string>
			onboardingNoticeLastShownAtMs?: number
		}) => void
	}
	const timingStart = startToolTiming()
	const conversationId = resolveConversationId(args.conversationId)
	const {
		baseUrl,
		hasUser,
		userId: callerUserId,
		storageId,
	} = callerContextFields(callerContext)
	// Package/secret/integration discovery and Waiting are keyed by the bound
	// org. Stamps and onboarding still use the acting person's users row
	// (team orgs have no users row for activation columns). Team detection
	// compares the bound org to the stamped personal org id (#3053).
	const personOwnerId = callerUserId ? personalOrgId(callerUserId) : null
	const personalOrgOwnerId = callerContext.user
		? personalOrgIdForPerson(callerContext.user)
		: personOwnerId
	const userId = callerContext.request?.org.id ?? personalOrgOwnerId
	const mcpCallerFields = {
		baseUrl,
		hasUser,
		userId: userId ?? undefined,
		conversationId,
		...(storageId ? { storageId } : {}),
	}
	const includeHiddenPackages = !!args.includeHiddenPackages
	const domainFilter = args.domain?.trim() || undefined
	// Whitespace-only queries stay valid (memory enrichment may still run) but
	// count as "no query" for the domain-browse limit default.
	const trimmedQuery = args.query?.trim() ?? ''
	// Domain browsing (domain without query) deliberately lists the whole
	// domain by default instead of cutting at the ranked default.
	const limit =
		args.limit ??
		(domainFilter && !trimmedQuery
			? domainBrowseDefaultLimit
			: defaultSearchLimit)
	const maxResponseSize = args.maxResponseSize ?? defaultMaxResponseSize
	let warnings: Array<string> = []
	let username: string | null = null
	const endToEndPhaseTimings: Partial<SearchPhaseTimings> = {}
	const statefulAgent = agent
	const searchConversationIdsWithPreamble = Array.isArray(
		statefulAgent.state?.searchConversationIdsWithPreamble,
	)
		? (statefulAgent.state?.searchConversationIdsWithPreamble ?? [])
		: []
	const includePreamble =
		!args.conversationId ||
		!searchConversationIdsWithPreamble.includes(conversationId)
	function rememberConversationPreamble() {
		if (!includePreamble || typeof statefulAgent.setState !== 'function') return
		statefulAgent.setState({
			...statefulAgent.state,
			searchConversationIdsWithPreamble: [
				...searchConversationIdsWithPreamble,
				conversationId,
			].slice(-maxOnboardingNoticeConversationIds),
		})
	}

	const searchSpan = async (signal: AbortSignal) => {
		const query = trimmedQuery
		if (!args.entity) {
			const execution = await executeSearchList({
				env: env,
				callerContext,
				conversationId,
				query,
				memoryQuery: args.query,
				limit,
				userId,
				includeHiddenPackages,
				memoryContext: args.memoryContext,
				...(domainFilter ? { domain: domainFilter } : {}),
				phaseTimings: endToEndPhaseTimings,
				signal,
			})
			username = execution.username
			warnings = execution.warnings
			Object.assign(endToEndPhaseTimings, execution.phaseTimings)
			signal.throwIfAborted()
			const stampStart = performance.now()
			await stampFirstSearchIfAuthenticated(env, personOwnerId)
			endToEndPhaseTimings.firstSearchStampMs = elapsedMs(stampStart)
			const structuredWarnings = [...warnings]
			const onboardingStart = performance.now()
			const onboardingNoticeConversationIds = Array.isArray(
				statefulAgent.state?.onboardingNoticeConversationIds,
			)
				? (statefulAgent.state?.onboardingNoticeConversationIds ?? [])
				: []
			const onboardingNoticeLastShownAtMs =
				typeof statefulAgent.state?.onboardingNoticeLastShownAtMs === 'number'
					? statefulAgent.state.onboardingNoticeLastShownAtMs
					: null
			const withinNoticeCooldown =
				onboardingNoticeLastShownAtMs !== null &&
				Date.now() - onboardingNoticeLastShownAtMs < onboardingNoticeCooldownMs
			const considerOnboardingNotice =
				personOwnerId !== null &&
				!withinNoticeCooldown &&
				!onboardingNoticeConversationIds.includes(conversationId)
			if (considerOnboardingNotice) {
				const settlement = await settleWithBudget(
					buildOnboardingSearchNotice({
						env,
						userId: personalOrgOwnerId ?? personOwnerId,
						personId: personOwnerId,
						baseUrl,
					}),
					SEARCH_ONBOARDING_NOTICE_BUDGET_MS,
				)
				if (settlement.timedOut) {
					endToEndPhaseTimings.onboardingNoticeTimedOut = true
				}
				signal.throwIfAborted()
				if (settlement.ok && settlement.value) {
					structuredWarnings.push(settlement.value)
					if (typeof statefulAgent.setState === 'function') {
						statefulAgent.setState({
							...statefulAgent.state,
							onboardingNoticeConversationIds: [
								...onboardingNoticeConversationIds,
								conversationId,
							].slice(-maxOnboardingNoticeConversationIds),
							onboardingNoticeLastShownAtMs: Date.now(),
						})
					}
				}
			}
			endToEndPhaseTimings.onboardingNoticeMs = elapsedMs(onboardingStart)
			const returnsDomainIndex =
				execution.result.matches.length > 0 &&
				execution.result.matches.every((match) => match.type === 'domain')
			const shouldInjectWaiting =
				personOwnerId !== null &&
				trimmedQuery.length > 0 &&
				!domainFilter &&
				!returnsDomainIndex
			const waitingStart = performance.now()
			let waitingMarkdown: string | null = null
			let waitingStructured: ReturnType<typeof toSearchWaitingStructured> = null
			if (shouldInjectWaiting && callerUserId) {
				try {
					const waiting = await settleWithBudget(
						deriveWaitingItemsForStableUser({
							env: env,
							personId: callerUserId,
							orgId: callerContext.request?.org.id ?? null,
							email: callerContext.user?.email ?? '',
						}),
						SEARCH_WAITING_ITEMS_BUDGET_MS,
					)
					if (waiting.timedOut) endToEndPhaseTimings.waitingItemsTimedOut = true
					if (waiting.ok) {
						const origin = baseUrl.replace(/\/+$/, '')
						waitingMarkdown = formatSearchWaitingMarkdown({
							items: waiting.value,
							origin,
						})
						waitingStructured = toSearchWaitingStructured({
							items: waiting.value,
							origin,
						})
					}
				} catch {
					waitingMarkdown = null
					waitingStructured = null
				}
			}
			endToEndPhaseTimings.waitingItemsMs = elapsedMs(waitingStart)
			return {
				mode: 'list' as const,
				execution,
				structuredWarnings,
				waitingMarkdown,
				waitingStructured,
			}
		}
		const usernameStart = performance.now()
		const boundOrgSlug = callerContext.request?.org.slug?.trim() || null
		const boundToTeamOrg =
			Boolean(boundOrgSlug) &&
			Boolean(personalOrgOwnerId) &&
			callerContext.request?.org.id !== personalOrgOwnerId
		username = boundToTeamOrg
			? boundOrgSlug
			: await resolvePublicUsername({
					db: env.APP_DB,
					username: callerContext.user?.username ?? null,
					email: callerContext.user?.email ?? null,
				})
		endToEndPhaseTimings.usernameLookupMs = elapsedMs(usernameStart)
		const rowAndRegistryLoadStart = performance.now()
		const rowsPromise = loadSearchRowsAndRegistry({
			env: env,
			callerContext,
			userId,
			includeHiddenPackages,
		}).then((rows) => {
			endToEndPhaseTimings.rowAndRegistryLoadMs = elapsedMs(
				rowAndRegistryLoadStart,
			)
			return rows
		})
		const searchRows = await rowsPromise
		warnings = searchRows.warnings
		signal.throwIfAborted()

		if (Array.isArray(args.entity)) {
			const entityResolveStart = performance.now()
			const batchResults = await Promise.all(
				args.entity.map(async (entityRef) => {
					try {
						const detail = await resolveEntityDetail({
							agent: agent as McpRegistrationAgent,
							callerContext,
							userId,
							username,
							entity: entityRef,
							searchRows,
						})
						return {
							ok: true as const,
							entityRef,
							detail,
						}
					} catch (cause) {
						const error =
							cause instanceof Error ? cause : new Error(String(cause))
						return {
							ok: false as const,
							entityRef,
							error: error.message,
							callerError: isMcpCallerError(cause),
						}
					}
				}),
			)
			endToEndPhaseTimings.entityResolveMs = elapsedMs(entityResolveStart)
			signal.throwIfAborted()
			if (batchResults.some((entry) => entry.ok)) {
				const stampStart = performance.now()
				await stampFirstSearchIfAuthenticated(env, personOwnerId)
				endToEndPhaseTimings.firstSearchStampMs = elapsedMs(stampStart)
			}
			return {
				mode: 'entity-batch' as const,
				results: batchResults,
			}
		}
		const entityResolveStart = performance.now()
		const detail = await resolveEntityDetail({
			agent: agent as McpRegistrationAgent,
			callerContext,
			userId,
			username,
			entity: args.entity,
			searchRows,
		})
		endToEndPhaseTimings.entityResolveMs = elapsedMs(entityResolveStart)
		signal.throwIfAborted()
		const stampStart = performance.now()
		await stampFirstSearchIfAuthenticated(env, personOwnerId)
		endToEndPhaseTimings.firstSearchStampMs = elapsedMs(stampStart)
		return {
			mode: 'entity' as const,
			detail,
		}
	}

	try {
		const outcome:
			| {
					mode: 'list'
					execution: SearchListExecutionResult
					structuredWarnings: Array<string>
					waitingMarkdown: string | null
					waitingStructured: ReturnType<typeof toSearchWaitingStructured>
			  }
			| {
					mode: 'entity'
					detail: Awaited<ReturnType<typeof resolveEntityDetail>>
			  }
			| {
					mode: 'entity-batch'
					results: Array<
						| {
								ok: true
								entityRef: string
								detail: Awaited<ReturnType<typeof resolveEntityDetail>>
						  }
						| {
								ok: false
								entityRef: string
								error: string
								callerError: boolean
						  }
					>
			  } = await Sentry.startSpan(
			{
				name: 'mcp.tool.search',
				op: 'mcp.tool',
				attributes: {
					'mcp.tool': 'search',
				},
			},
			() => runWithSearchDeadline(searchSpan),
		)

		if (outcome.mode === 'entity') {
			const entityResult = formatEntityDetailMarkdown(outcome.detail, {
				includeBoilerplate: includePreamble,
			})
			rememberConversationPreamble()
			const timing = finishToolTiming(timingStart)
			const phaseTimings = reconcileSearchPhaseTimings({
				durationMs: timing.durationMs,
				phaseTimings: endToEndPhaseTimings,
			})
			logMcpEvent({
				category: 'mcp',
				tool: 'search',
				toolName: 'search',
				outcome: 'success',
				durationMs: timing.durationMs,
				...mcpCallerFields,
				context: { phaseTimings },
			})
			recordSearchObservabilityEvent(env, {
				outcome: 'success',
				mode: 'entity',
				durationMs: timing.durationMs,
				phaseTimings,
			})
			return {
				content: prependToolMetadataContent(conversationId, [
					{
						type: 'text',
						text: truncateSearchText(entityResult.markdown),
					},
				]),
				structuredContent: {
					conversationId,
					timing,
					result: entityResult.structured,
				},
			}
		}

		if (outcome.mode === 'entity-batch') {
			const structuredResults: Array<
				SearchEntityDetailStructured | { entityRef: string; error: string }
			> = []
			const markdownParts: Array<string> = []
			let successCount = 0
			for (const entry of outcome.results) {
				if (!entry.ok) {
					structuredResults.push({
						entityRef: entry.entityRef,
						error: entry.error,
					})
					markdownParts.push(
						`Error resolving ${formatMarkdownInlineCode(entry.entityRef)}: ${escapeMarkdownText(entry.error)}`,
					)
					continue
				}
				const entityResult = formatEntityDetailMarkdown(entry.detail, {
					includeBoilerplate: includePreamble,
				})
				const candidateStructured = [
					...structuredResults,
					entityResult.structured,
				]
				const hasFullDetail = structuredResults.some(
					(result) => 'kind' in result && result.kind === 'entity',
				)
				if (
					hasFullDetail &&
					JSON.stringify(candidateStructured).length > maxChars
				) {
					const overflowError =
						'Omitted from batch response (exceeds size budget). Look up individually with search({ entity }).'
					structuredResults.push({
						entityRef: entry.entityRef,
						error: overflowError,
					})
					markdownParts.push(
						`Error resolving ${formatMarkdownInlineCode(entry.entityRef)}: ${escapeMarkdownText(overflowError)}`,
					)
					continue
				}
				successCount += 1
				structuredResults.push(entityResult.structured)
				markdownParts.push(entityResult.markdown)
			}
			const allFailed = successCount === 0
			if (!allFailed) rememberConversationPreamble()
			const failedEntries = outcome.results.filter((entry) => !entry.ok)
			const allFailuresAreCallerErrors =
				allFailed && failedEntries.every((entry) => entry.callerError)
			const entityFailures = failedEntries.map((entry) => ({
				entityRef: entry.entityRef,
				error: entry.error,
				callerError: entry.callerError,
			}))
			const timing = finishToolTiming(timingStart)
			const phaseTimings = reconcileSearchPhaseTimings({
				durationMs: timing.durationMs,
				phaseTimings: endToEndPhaseTimings,
			})
			logMcpEvent({
				category: 'mcp',
				tool: 'search',
				toolName: 'search',
				outcome: allFailed ? 'failure' : 'success',
				durationMs: timing.durationMs,
				...mcpCallerFields,
				...(allFailed
					? {
							sandboxError: false,
							// Only treat the batch as a caller mistake when every
							// entry failed with McpCallerError. Mixed/platform
							// failures must still reach Sentry.
							...(allFailuresAreCallerErrors
								? { callerError: true }
								: {
										cause: new Error('All entity lookups failed.', {
											cause: new AggregateError(
												failedEntries.map(
													(entry) =>
														new Error(`${entry.entityRef}: ${entry.error}`),
												),
												'Entity lookup failures',
											),
										}),
									}),
							errorName: 'EntityBatchError',
							errorMessage: 'All entity lookups failed.',
							context: {
								failurePhase: 'handler',
								entityFailures,
								phaseTimings,
							},
						}
					: { context: { phaseTimings } }),
			})
			recordSearchObservabilityEvent(env, {
				outcome: allFailed ? 'failure' : 'success',
				mode: 'entity-batch',
				durationMs: timing.durationMs,
				phaseTimings,
			})
			return {
				content: prependToolMetadataContent(conversationId, [
					{
						type: 'text',
						text: truncateSearchText(markdownParts.join('\n\n---\n\n')),
					},
				]),
				structuredContent: {
					conversationId,
					timing,
					result: structuredResults,
					...(allFailed ? { error: 'All entity lookups failed.' } : {}),
				},
				...(allFailed ? { isError: true } : {}),
			}
		}

		const execution = outcome.execution
		const searchMemories = execution.memorySettlement.memories
		const structuredWarnings = outcome.structuredWarnings
		const waitingMarkdown = outcome.waitingMarkdown
		const waitingStructured = outcome.waitingStructured

		const payload: {
			matches: Array<SearchMatch>
			offline: boolean
		} = {
			matches: execution.result.matches,
			offline: execution.result.offline,
		}
		rememberConversationPreamble()
		const memorySummary = searchMemories
			? {
					memories: searchMemories.surfaced,
					retrieverResults: searchMemories.retrieverResults,
					retrieverWarnings: searchMemories.retrieverWarnings ?? [],
					suppressedCount: searchMemories.suppressedCount,
					retrievalQuery: searchMemories.retrievalQuery,
				}
			: null
		const memoryContent = formatSurfacedMemoriesMarkdown(memorySummary)
		const reservedMemoryChars = memoryContent.reduce((total, block) => {
			if (block.type !== 'text' || !('text' in block)) return total
			return total + (total > 0 ? 1 : 0) + block.text.length
		}, 0)
		const reservedWaitingChars = waitingMarkdown?.length ?? 0
		const formattingStartMs = performance.now()
		const { payload: trimmedPayload, serialized } = applyMaxResponseSize(
			payload,
			maxResponseSize,
			(value) => {
				const guidanceForSize = resolveListGuidance({
					trimmedMatches: value.matches,
					query: trimmedQuery,
					intent: execution.result.intent,
					preTrimGuidance: execution.result.guidance,
				})
				return formatSearchMarkdown({
					matches: value.matches,
					warnings: structuredWarnings,
					guidance: guidanceForSize,
					includePreamble,
				})
			},
			(value, count) => ({
				...value,
				matches: value.matches.slice(0, count),
			}),
			(value) => value.matches.length,
			{
				reservedChars:
					(reservedMemoryChars > 0 ? reservedMemoryChars + 1 : 0) +
					(reservedWaitingChars > 0 ? reservedWaitingChars + 1 : 0),
			},
		)
		const listGuidance = resolveListGuidance({
			trimmedMatches: trimmedPayload.matches,
			query: trimmedQuery,
			intent: execution.result.intent,
			preTrimGuidance: execution.result.guidance,
		})
		const trimmedMatchCount = Math.max(
			0,
			execution.result.matches.length - trimmedPayload.matches.length,
		)
		const slimMatches = toSlimStructuredMatches({
			matches: trimmedPayload.matches,
			baseUrl,
			packageAppBaseUrl: getPackageAppBaseUrl({ env: env }),
			username,
		})
		const formattingMs = elapsedMs(formattingStartMs)
		endToEndPhaseTimings.formattingMs = formattingMs
		const timingBase = finishToolTiming(timingStart)
		const mergedPhaseTimings: SearchPhaseTimings = {
			...execution.result.phaseTimings,
			...endToEndPhaseTimings,
		}
		const phaseTimings = reconcileSearchPhaseTimings({
			durationMs: timingBase.durationMs,
			phaseTimings: mergedPhaseTimings,
		})
		const jevTelemetry = execution.result.telemetry.jevRerank
		const serverTiming = toSearchServerTiming({
			phaseTimings,
			jevRerank: jevTelemetry,
		})
		const timing = {
			...timingBase,
			...(serverTiming.length > 0 ? { serverTiming } : {}),
		}
		const result: SearchResultStructuredContent = {
			offline: trimmedPayload.offline,
			warnings: structuredWarnings,
			...(listGuidance
				? {
						guidance: listGuidance,
					}
				: {}),
			telemetry: {
				...execution.result.telemetry,
				topResultTypes: trimmedPayload.matches
					.slice(0, 5)
					.map((match) => match.type),
				trimmedMatchCount,
				responseTrimmed: trimmedMatchCount > 0,
			},
			phaseTimings,
			...(searchMemories
				? {
						memories: searchMemories,
					}
				: {}),
			...(waitingStructured
				? {
						waiting: waitingStructured,
					}
				: {}),
			matches: slimMatches,
		}
		logMcpEvent({
			category: 'mcp',
			tool: 'search',
			toolName: 'search',
			outcome: 'success',
			durationMs: timing.durationMs,
			...mcpCallerFields,
			message: 'Search completed successfully.',
			context: {
				task: execution.result.intent.task.name,
				intentConfidence: execution.result.intent.confidence,
				entityCount: execution.result.intent.entities.length,
				actionCount: execution.result.intent.actions.length,
				constraintCount: execution.result.intent.constraints.length,
				candidateCounts: execution.result.telemetry.candidateCounts,
				topResultTypes: result.telemetry?.topResultTypes ?? [],
				responseTrimmed: result.telemetry?.responseTrimmed ?? false,
				trimmedMatchCount,
				offline: execution.result.offline,
				warningsCount: warnings.length,
				phaseTimings,
			},
		})
		recordSearchObservabilityEvent(env, {
			outcome: 'success',
			mode: 'list',
			durationMs: timing.durationMs,
			phaseTimings,
			task: execution.result.intent.task.name,
			intentConfidence: execution.result.intent.confidence,
			responseTrimmed: result.telemetry?.responseTrimmed ?? false,
			trimmedMatchCount,
			offline: execution.result.offline,
			jevFlagCohort:
				jevTelemetry == null ? 'n/a' : jevTelemetry.enabled ? 'on' : 'off',
			jevOutcome: jevTelemetry?.outcome ?? '',
			jevErrorReason: jevTelemetry?.errorReason,
			candidatesBeforeJev: jevTelemetry?.candidatesBefore,
			candidatesAfterJev: jevTelemetry?.candidatesAfter,
			jevDroppedCount: jevTelemetry?.droppedCount,
			jevMeanConfidence: jevTelemetry?.meanConfidence ?? undefined,
			jevDurationMs: execution.result.phaseTimings.jevRerankMs,
			// Prefer the match actually returned (after provider collapse),
			// not the pre-collapse Jev top-1 type.
			top1TypeCode: encodeSearchTop1Type(result.matches[0]?.type),
			jevAiCallCount: jevTelemetry?.aiCallCount,
			jevInputTokens: jevTelemetry?.usage?.inputTokens ?? undefined,
			jevOutputTokens: jevTelemetry?.usage?.outputTokens ?? undefined,
		})
		return {
			content: prependToolMetadataContent(conversationId, [
				...(waitingMarkdown
					? [
							{
								type: 'text' as const,
								text: waitingMarkdown,
							},
						]
					: []),
				{
					type: 'text',
					text: truncateSearchText(serialized),
				},
				...memoryContent,
			]),
			structuredContent: {
				conversationId,
				timing,
				result,
			},
		}
	} catch (cause) {
		const timing = finishToolTiming(timingStart)
		const error = cause instanceof Error ? cause : new Error(String(cause))
		const { errorName, errorMessage } = errorFields(error)
		const phaseTimings = reconcileSearchPhaseTimings({
			durationMs: timing.durationMs,
			phaseTimings: endToEndPhaseTimings,
		})
		logMcpEvent({
			category: 'mcp',
			tool: 'search',
			toolName: 'search',
			outcome: 'failure',
			durationMs: timing.durationMs,
			...mcpCallerFields,
			sandboxError: false,
			errorName,
			errorMessage,
			cause: error,
			context: { phaseTimings },
		})
		recordSearchObservabilityEvent(env, {
			outcome: 'failure',
			mode: args.entity
				? Array.isArray(args.entity)
					? 'entity-batch'
					: 'entity'
				: 'list',
			durationMs: timing.durationMs,
			phaseTimings,
		})
		return {
			content: prependToolMetadataContent(conversationId, [
				{ type: 'text', text: `Error: ${error.message}` },
			]),
			structuredContent: {
				conversationId,
				timing,
				error: error.message,
				...entitlementStructuredContent(error),
				...rateLimitStructuredContent(error),
			},
			isError: true,
		}
	}
}
