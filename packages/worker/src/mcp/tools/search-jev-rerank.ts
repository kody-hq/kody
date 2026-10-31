/**
 * Stage-2 Jev Score rerank/filter for ranked MCP `search({ query })`.
 *
 * Hybrid lexical+vector recall provides the initial candidates. Product
 * gate: **paid plans only** (standard / pro / max) and only when the
 * post-hybrid pool looks ambiguous ({@link evaluateJevSearchNecessity}).
 * Free and anonymous never call Jev (`skipped-plan`). Plan + necessity keep
 * the pricing page's "improved search" copy truthful.
 *
 * Eligible paid searches widen hybrid recall, then score with Workers AI
 * `typesafe/jev` through AI Gateway when necessity says so. Score questions
 * are sent in small batches that share the same skinny-card state; answers
 * are unwrapped from known Gateway envelopes, then merged before parse.
 * That third-party model requires Gateway authentication and Unified
 * Billing (or BYOK); the Worker does not fall back to direct Workers AI.
 * Failures, low mean confidence, and Score batches that miss
 * {@link jevSearchScoreBudgetMs} fall back to the pre-Jev hybrid order.
 * After Score, keep uses an adaptive cutoff: high bar first, one secondary
 * floor if that keep-set is empty, then a true empty ranked list (never
 * restore hybrid noise when every Jev score is weak). The one exception:
 * hybrid candidates whose package name, kody id, or name leaf equals a query
 * term (or a contiguous run of query terms) stay, in hybrid order
 * (`keepPath: kept-identity`). `dropbox shared link` can still return the
 * `dropbox` package; description-only overlap stays dropped.
 *
 * Offline / deterministic embedding paths never call Jev.
 */

import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { getPackageNameLeaf } from '#worker/package-registry/package-name.ts'

import {
	type JevSearchRerankOutcome,
	type SearchCandidate,
} from './search-types.ts'
import {
	extractMeaningfulSearchTokens,
	type SearchIntent,
} from './understand-search-query.ts'

export type { JevSearchRerankOutcome }

/** Cap skinny cards sent to Jev even when recall is wider. */
export const jevSearchCandidateCap = 40

/**
 * When flag + paid plan are eligible, plugins fetch at least this many
 * hybrid candidates (still Vectorize-capped at 100) before heuristic
 * rerank + optional Jev.
 */
export const jevSearchWideRecallLimit = 50

/**
 * Necessity: pools this size or smaller skip Jev (`skipped-small-pool`).
 * Hybrid `scoreComponents.final` is already decisive enough.
 */
export const jevSearchNecessitySmallPoolMax = 8

/**
 * Necessity: pools from smallMax+1 through this size run Jev only when
 * top scores are tight or the top slice mixes entity kinds / parent
 * package + export clash; otherwise `skipped-clear-winner`. Larger pools
 * always run.
 */
export const jevSearchNecessityMediumPoolMax = 20

/**
 * Necessity (medium pools): run Jev when `top1.final - top2.final` is
 * strictly below this gap on hybrid scores. Tuned for blended
 * lexical/vector finals that often sit in ~0–2 with intent boosts.
 */
export const jevSearchNecessityTightScoreGap = 0.12

/** Mean Jev confidence below this falls back to hybrid order. */
export const jevSearchMinMeanConfidence = 0.45

/**
 * Score rubric: 0 unrelated … 3 best primary match. Drop below "clearly
 * relevant" (2) unless that would empty the result set — then try the
 * secondary floor once ({@link jevSearchSecondaryKeepScore}).
 */
export const jevSearchMinKeepScore = 1.5

/**
 * Secondary keep floor when nothing clears {@link jevSearchMinKeepScore}.
 * Mid-tier Jev scores stay in Jev order; weaker still yields a true empty
 * list except identity-term package hits ({@link keepIdentityTermHybridCandidates}).
 */
export const jevSearchSecondaryKeepScore = 0.75

/**
 * When using the secondary floor, also require scores within this gap of
 * the top Jev score so one mediocre hit does not drag a long weak tail.
 */
export const jevSearchLoweredKeepClusterGap = 0.5

export const jevSearchKeepPaths = [
	'kept-high',
	'kept-lowered',
	'kept-identity',
	'empty',
] as const

export type JevSearchKeepPath = (typeof jevSearchKeepPaths)[number]

export const jevSearchModel = 'typesafe/jev'

/**
 * Max Score questions per `AI.run`. `typesafe/jev` can omit answers when
 * one call asks for the full candidate cap at once.
 */
export const jevSearchScoreQuestionBatchSize = 8

/**
 * Wall-clock budget for every Score batch together. Gateway latency for the
 * parallel batches swings from ~2s to past the ~30s MCP client timeout, so
 * past this budget the in-flight `AI.run` calls are aborted and search keeps
 * hybrid order (`fallback-timeout`).
 */
export const jevSearchScoreBudgetMs = 4_000

/** Safe length for `errorReason` on fallback-error telemetry. */
const jevSearchErrorReasonMaxChars = 240

const jevSearchGatewayRequiredReason = 'ai-gateway-required-for-typesafe-jev'

const jevSearchIncompleteScoreAnswersReason = 'incomplete-score-answers'

type JevSearchSkinnyCard = {
	index: number
	type: SearchCandidate['type']
	id: string
	title: string
	summary: string
	domain?: string
	/** Package export subpath when the candidate is an export contract hit. */
	exportSubpath?: string
}

export type JevSearchTokenUsage = {
	inputTokens: number | null
	outputTokens: number | null
}

export type JevSearchRerankResult = {
	candidates: Array<SearchCandidate>
	outcome: JevSearchRerankOutcome
	durationMs: number
	candidatesBefore: number
	candidatesAfter: number
	droppedCount: number
	meanConfidence: number | null
	top1Type: SearchCandidate['type'] | null
	/**
	 * Adaptive keep path after Jev Score sort. Present when Score ran and
	 * mean confidence cleared the floor (`applied` or
	 * `fallback-empty-after-drop`).
	 */
	keepPath?: JevSearchKeepPath
	/** Present only when `outcome` is `fallback-error`. */
	errorReason?: string
	/** Present when the Jev stage ran or attempted. */
	model?: typeof jevSearchModel
	/** Score `AI.run` count (one per question batch). */
	aiCallCount?: number
	/** Summed Workers AI / Gateway usage across batches. */
	usage?: JevSearchTokenUsage
}

export type JevScoredCandidate = {
	candidate: SearchCandidate
	score: number
	confidence: number
}

/**
 * Adaptive keep after Jev Score sort: high bar, then one secondary floor
 * (with a relative cluster near the top score), else true empty. Identity-term
 * package hits are applied by the caller when this returns empty.
 */
export function selectJevKeptCandidates(
	ranked: ReadonlyArray<JevScoredCandidate>,
): {
	kept: Array<JevScoredCandidate>
	keepPath: JevSearchKeepPath
} {
	const high = ranked.filter((entry) => entry.score >= jevSearchMinKeepScore)
	if (high.length > 0) {
		return { kept: high, keepPath: 'kept-high' }
	}

	const top = ranked[0]
	if (!top || top.score < jevSearchSecondaryKeepScore) {
		return { kept: [], keepPath: 'empty' }
	}

	const clusterFloor = top.score - jevSearchLoweredKeepClusterGap
	const floor = Math.max(jevSearchSecondaryKeepScore, clusterFloor)
	const lowered = ranked.filter((entry) => entry.score >= floor)
	if (lowered.length === 0) {
		return { kept: [], keepPath: 'empty' }
	}
	return { kept: lowered, keepPath: 'kept-lowered' }
}

function identityTokensMatchQuery(
	identityTokens: ReadonlyArray<string>,
	queryTokens: ReadonlyArray<string>,
): boolean {
	if (
		identityTokens.length === 0 ||
		queryTokens.length < identityTokens.length
	) {
		return false
	}
	for (
		let start = 0;
		start <= queryTokens.length - identityTokens.length;
		start += 1
	) {
		let matches = true
		for (let offset = 0; offset < identityTokens.length; offset += 1) {
			if (queryTokens[start + offset] !== identityTokens[offset]) {
				matches = false
				break
			}
		}
		if (matches) return true
	}
	return false
}

/**
 * Package name, kody id, or name leaf equals one query term or a contiguous
 * run of query terms of any length. Description and tag overlap does not count.
 * Export rows inherit the parent identity and stay dropped, so a weak export
 * cannot crowd out the package or receive an inlined call contract.
 */
export function hybridCandidateMatchesIdentityTerm(
	candidate: SearchCandidate,
	intent: SearchIntent,
): boolean {
	if (candidate.match.type !== 'package') return false
	if (candidate.match.exportSubpath) return false
	const { kodyId, name } = candidate.match
	return [kodyId, name, getPackageNameLeaf(name)].some((value) =>
		identityTokensMatchQuery(
			extractMeaningfulSearchTokens(value),
			intent.meaningfulTokens,
		),
	)
}

/** Hybrid order, identity-term package hits only. */
export function keepIdentityTermHybridCandidates(input: {
	candidates: ReadonlyArray<SearchCandidate>
	intent: SearchIntent
	limit: number
}): Array<SearchCandidate> {
	return input.candidates
		.filter((candidate) =>
			hybridCandidateMatchesIdentityTerm(candidate, input.intent),
		)
		.slice(0, Math.max(1, input.limit))
}

type JevScoreAnswer = {
	type?: string
	score?: number
	confidence?: number
}

type JevRunUsage = {
	input_tokens?: number
	output_tokens?: number
	prompt_tokens?: number
	completion_tokens?: number
	inputTokens?: number
	outputTokens?: number
	promptTokens?: number
	completionTokens?: number
	tokens_in?: number
	tokens_out?: number
}

type JevRunResponse = {
	answers?: Record<string, JevScoreAnswer>
	usage?: JevRunUsage
}

export type JevResultAnswersPresence = 'object' | 'missing' | 'other'

/** Binding/Gateway payload after known-envelope unwrap. */
export type JevNormalizedRunResponse = {
	payload: JevRunResponse
	rawTopLevelKeys: Array<string>
	resultAnswers: JevResultAnswersPresence
}

type JevRuntimeEnv = {
	AI?: Ai
	AI_GATEWAY_ID?: string
}

function oneLine(text: string, maxChars: number): string {
	const collapsed = text.replace(/\s+/g, ' ').trim()
	if (collapsed.length <= maxChars) return collapsed
	return `${collapsed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`
}

function buildJevSearchSkinnyCard(
	candidate: SearchCandidate,
	index: number,
): JevSearchSkinnyCard {
	const match = candidate.match
	let summary = ''
	if ('description' in match && typeof match.description === 'string') {
		summary = match.description
	} else if ('summary' in match && typeof match.summary === 'string') {
		summary = match.summary
	} else if (candidate.searchFields[0]) {
		summary = candidate.searchFields[0]
	}
	const domain =
		'domain' in match && typeof match.domain === 'string'
			? match.domain
			: undefined
	const exportSubpath =
		candidate.match.type === 'package' &&
		typeof candidate.match.exportSubpath === 'string'
			? candidate.match.exportSubpath
			: undefined
	const summaryWithExport =
		exportSubpath && summary
			? `${exportSubpath}: ${summary}`
			: (exportSubpath ?? summary)
	return {
		index,
		type: candidate.type,
		id: candidate.id,
		title: oneLine(candidate.title, 80),
		summary: oneLine(summaryWithExport, 160),
		...(domain ? { domain: oneLine(domain, 64) } : {}),
		...(exportSubpath ? { exportSubpath: oneLine(exportSubpath, 64) } : {}),
	}
}

export function resolveJevSearchRecallLimit(input: {
	limit: number
	widerRecall: boolean
}): number {
	if (!input.widerRecall) return Math.max(1, input.limit)
	return Math.max(input.limit, jevSearchWideRecallLimit)
}

function packageKodyId(candidate: SearchCandidate): string | null {
	if (candidate.match.type !== 'package') return null
	return candidate.match.kodyId
}

function isPackageExportHit(candidate: SearchCandidate): boolean {
	return (
		candidate.match.type === 'package' &&
		typeof candidate.match.exportSubpath === 'string' &&
		candidate.match.exportSubpath.length > 0
	)
}

/**
 * True when the top slice mixes a package index hit with an export hit for
 * the same package — hybrid order alone may pick the wrong surface.
 */
export function hasParentPackageExportClash(
	candidates: ReadonlyArray<SearchCandidate>,
	topN = 5,
): boolean {
	const packageIndexes = new Set<string>()
	const packageExports = new Set<string>()
	for (const candidate of candidates.slice(0, topN)) {
		const kodyId = packageKodyId(candidate)
		if (!kodyId) continue
		if (isPackageExportHit(candidate)) packageExports.add(kodyId)
		else packageIndexes.add(kodyId)
	}
	for (const kodyId of packageExports) {
		if (packageIndexes.has(kodyId)) return true
	}
	return false
}

/**
 * True when the top slice spans more than one search match type.
 */
export function hasMixedEntityKinds(
	candidates: ReadonlyArray<SearchCandidate>,
	topN = 5,
): boolean {
	const kinds = new Set(
		candidates.slice(0, topN).map((candidate) => candidate.type),
	)
	return kinds.size > 1
}

export type JevSearchNecessityDecision =
	| { run: true }
	| {
			run: false
			outcome: 'skipped-small-pool' | 'skipped-clear-winner'
	  }

/**
 * Decide whether the post-hybrid pool needs Jev. Pure; no AI.
 *
 * - `≤ {@link jevSearchNecessitySmallPoolMax}` → skip (`skipped-small-pool`)
 * - `smallMax+1 … {@link jevSearchNecessityMediumPoolMax}` → run only when
 *   top scores are tight, entity kinds mix, or parent package + export
 *   clash; else `skipped-clear-winner`
 * - `> mediumMax` → run
 */
export function evaluateJevSearchNecessity(
	candidates: ReadonlyArray<SearchCandidate>,
): JevSearchNecessityDecision {
	const count = candidates.length
	if (count <= jevSearchNecessitySmallPoolMax) {
		return { run: false, outcome: 'skipped-small-pool' }
	}
	if (count > jevSearchNecessityMediumPoolMax) {
		return { run: true }
	}
	const top1 = candidates[0]
	const top2 = candidates[1]
	const scoreGap =
		top1 && top2
			? top1.scoreComponents.final - top2.scoreComponents.final
			: Number.POSITIVE_INFINITY
	const tightScores = scoreGap < jevSearchNecessityTightScoreGap
	if (
		tightScores ||
		hasMixedEntityKinds(candidates) ||
		hasParentPackageExportClash(candidates)
	) {
		return { run: true }
	}
	return { run: false, outcome: 'skipped-clear-winner' }
}

function questionKey(index: number): string {
	return `c${String(index)}`
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
	if (value == null || typeof value !== 'object' || Array.isArray(value)) {
		return null
	}
	return value as Record<string, unknown>
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
	try {
		return asPlainRecord(JSON.parse(value) as unknown)
	} catch {
		return null
	}
}

function recordHasAnswers(value: Record<string, unknown>): boolean {
	return asPlainRecord(value.answers) != null
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value === 'string') return parseJsonRecord(value)
	return asPlainRecord(value)
}

function describeResultAnswers(
	raw: Record<string, unknown> | null,
): JevResultAnswersPresence {
	if (!raw || !('result' in raw)) return 'missing'
	const result = nestedRecord(raw.result)
	if (raw.result == null) return 'missing'
	if (!result) return 'other'
	if (!('answers' in result)) return 'missing'
	return asPlainRecord(result.answers) != null ? 'object' : 'other'
}

/**
 * `typesafe/jev` is not in the generated AiModels map. Direct docs show
 * `{ answers, usage }`, but the Workers AI binding through
 * `{ gateway: { id } }` can return the Cloudflare v4 / `/ai/run` envelope
 * (`{ success, result: { answers, usage } }`) or a `{ response }` wrap.
 * Unwrap those so merge and usage read the Score payload.
 */
function unwrapJevPayload(
	raw: Record<string, unknown>,
): Record<string, unknown> {
	if (recordHasAnswers(raw)) return raw

	const result = nestedRecord(raw.result)
	if (result) {
		if (recordHasAnswers(result)) return result
		const resultResponse = nestedRecord(result.response)
		if (resultResponse && recordHasAnswers(resultResponse)) {
			return resultResponse
		}
	}

	const response = nestedRecord(raw.response)
	if (response && recordHasAnswers(response)) return response

	return raw
}

export function normalizeJevRunResponse(
	raw: unknown,
): JevNormalizedRunResponse {
	const parsedRaw =
		typeof raw === 'string' ? parseJsonRecord(raw) : asPlainRecord(raw)
	const rawTopLevelKeys = parsedRaw ? Object.keys(parsedRaw) : []
	const resultAnswers = describeResultAnswers(parsedRaw)
	if (!parsedRaw) {
		return { payload: {}, rawTopLevelKeys, resultAnswers }
	}
	const unwrapped = unwrapJevPayload(parsedRaw)
	const answers = asPlainRecord(unwrapped.answers)
	const usage =
		asPlainRecord(unwrapped.usage) ??
		asPlainRecord(nestedRecord(parsedRaw.result)?.usage) ??
		asPlainRecord(parsedRaw.usage)
	return {
		payload: {
			...(answers
				? { answers: answers as Record<string, JevScoreAnswer> }
				: {}),
			...(usage ? { usage: usage as JevRunUsage } : {}),
		},
		rawTopLevelKeys,
		resultAnswers,
	}
}

function buildQuestionBatches(
	cardCount: number,
	batchSize: number,
): Array<Array<number>> {
	const batches: Array<Array<number>> = []
	for (let start = 0; start < cardCount; start += batchSize) {
		const batch: Array<number> = []
		const end = Math.min(cardCount, start + batchSize)
		for (let index = start; index < end; index += 1) {
			batch.push(index)
		}
		batches.push(batch)
	}
	return batches
}

function buildJevQuestions(indexes: ReadonlyArray<number>) {
	const questions: Record<
		string,
		{
			type: 'score'
			instructions: string
			criteria: Array<string>
		}
	> = {}
	for (const index of indexes) {
		questions[questionKey(index)] = {
			type: 'score',
			instructions: `How relevant is state.candidates[${String(index)}] to state.query for the agent's next hop (open detail or execute)? Use state.intent only as context.`,
			criteria: [
				'Unrelated or misleading for this query',
				'Tangentially related',
				'Clearly relevant next hop',
				'Best primary match for this query',
			],
		}
	}
	return questions
}

async function runJevScoreRequest(
	runtime: JevRuntimeEnv & { AI: Ai },
	body: {
		state: Record<string, unknown>
		questions: ReturnType<typeof buildJevQuestions>
	},
	options?: { gateway: { id: string }; signal?: AbortSignal },
	tally?: { aiCallCount: number },
): Promise<JevNormalizedRunResponse> {
	if (tally) tally.aiCallCount += 1
	// Model is not yet in the generated AiModels map; cast at the boundary.
	const raw: unknown = await runtime.AI.run(
		jevSearchModel as Parameters<Ai['run']>[0],
		body,
		options,
	)
	return normalizeJevRunResponse(raw)
}

function toJevErrorReason(error: unknown): string {
	return (
		oneLine(getErrorMessage(error), jevSearchErrorReasonMaxChars) ||
		'unknown-jev-error'
	)
}

async function runJevViaGateway(
	runtime: JevRuntimeEnv & { AI: Ai },
	body: {
		state: Record<string, unknown>
		questions: ReturnType<typeof buildJevQuestions>
	},
	signal: AbortSignal,
	tally?: { aiCallCount: number },
): Promise<JevNormalizedRunResponse> {
	const gatewayId = runtime.AI_GATEWAY_ID?.trim()
	if (!gatewayId) {
		throw new Error(jevSearchGatewayRequiredReason)
	}
	try {
		return await runJevScoreRequest(
			runtime,
			body,
			{
				gateway: { id: gatewayId },
				signal,
			},
			tally,
		)
	} catch (error) {
		if (signal.aborted) throw error
		console.warn(
			JSON.stringify({
				message: 'Workers AI Gateway Jev request failed',
				gatewayId,
				error: getErrorMessage(error),
			}),
		)
		throw error
	}
}

function isCompleteScoreAnswer(
	answer: JevScoreAnswer | undefined,
): answer is JevScoreAnswer & { score: number; confidence: number } {
	return (
		answer != null &&
		typeof answer.score === 'number' &&
		Number.isFinite(answer.score) &&
		typeof answer.confidence === 'number' &&
		Number.isFinite(answer.confidence)
	)
}

function mergeScoreAnswers(
	responses: ReadonlyArray<JevRunResponse>,
): Record<string, JevScoreAnswer> {
	const answers: Record<string, JevScoreAnswer> = {}
	for (const response of responses) {
		if (!response.answers || typeof response.answers !== 'object') continue
		for (const [key, value] of Object.entries(response.answers)) {
			if (value) answers[key] = value
		}
	}
	return answers
}

function parseScoreAnswers(
	answers: Record<string, JevScoreAnswer>,
	cardCount: number,
):
	| {
			ok: true
			scores: Array<number>
			confidences: Array<number>
	  }
	| {
			ok: false
			expected: number
			received: number
	  } {
	const scores: Array<number> = []
	const confidences: Array<number> = []
	let received = 0
	for (let index = 0; index < cardCount; index += 1) {
		const answer = answers[questionKey(index)]
		if (!isCompleteScoreAnswer(answer)) continue
		received += 1
		scores.push(answer.score)
		confidences.push(answer.confidence)
	}
	if (received !== cardCount) {
		return { ok: false, expected: cardCount, received }
	}
	return { ok: true, scores, confidences }
}

function formatSampledKeys(keys: ReadonlyArray<string>): string {
	if (keys.length === 0) return 'none'
	const shown = keys.slice(0, 8)
	if (shown.length === keys.length) return shown.join(',')
	return `${shown.join(',')}+${String(keys.length - shown.length)}`
}

function incompleteScoreAnswersReason(input: {
	expected: number
	received: number
	rawTopLevelKeys: ReadonlyArray<string>
	resultAnswers: JevResultAnswersPresence
	answerKeys: ReadonlyArray<string>
}): string {
	return oneLine(
		[
			jevSearchIncompleteScoreAnswersReason,
			`expected=${String(input.expected)}`,
			`received=${String(input.received)}`,
			`keys=${formatSampledKeys(input.rawTopLevelKeys)}`,
			`result.answers=${input.resultAnswers}`,
			`answerKeys=${formatSampledKeys(input.answerKeys)}`,
		].join(' '),
		jevSearchErrorReasonMaxChars,
	)
}

function readFiniteTokenCount(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0
		? value
		: null
}

function readResponseUsage(response: JevRunResponse): JevSearchTokenUsage {
	const usage = response.usage
	if (!usage || typeof usage !== 'object') {
		return { inputTokens: null, outputTokens: null }
	}
	return {
		inputTokens:
			readFiniteTokenCount(usage.input_tokens) ??
			readFiniteTokenCount(usage.prompt_tokens) ??
			readFiniteTokenCount(usage.inputTokens) ??
			readFiniteTokenCount(usage.promptTokens) ??
			readFiniteTokenCount(usage.tokens_in),
		outputTokens:
			readFiniteTokenCount(usage.output_tokens) ??
			readFiniteTokenCount(usage.completion_tokens) ??
			readFiniteTokenCount(usage.outputTokens) ??
			readFiniteTokenCount(usage.completionTokens) ??
			readFiniteTokenCount(usage.tokens_out),
	}
}

function sumTokenUsage(
	usages: ReadonlyArray<JevSearchTokenUsage>,
): JevSearchTokenUsage {
	let inputTokens: number | null = null
	let outputTokens: number | null = null
	for (const usage of usages) {
		if (usage.inputTokens != null) {
			inputTokens = (inputTokens ?? 0) + usage.inputTokens
		}
		if (usage.outputTokens != null) {
			outputTokens = (outputTokens ?? 0) + usage.outputTokens
		}
	}
	return { inputTokens, outputTokens }
}

function mean(values: ReadonlyArray<number>): number {
	if (values.length === 0) return 0
	let total = 0
	for (const value of values) total += value
	return total / values.length
}

/**
 * Reorder and drop hybrid candidates with Jev Score. When every score misses
 * the adaptive keep floors, returns a true empty ranked list (not hybrid
 * order) unless a hybrid candidate matches an identity term — those package
 * hits stay in hybrid order. Failures and low mean confidence still fall
 * back to hybrid.
 *
 * Gate order: paid plan → empty/offline/AI → necessity → Score.
 */
export async function rerankSearchCandidatesWithJev(input: {
	env: Env
	query: string
	intent: SearchIntent
	candidates: Array<SearchCandidate>
	limit: number
	offline: boolean
	/**
	 * Paid plan (standard/pro/max). Free and anonymous pass false and
	 * record `skipped-plan`.
	 */
	planEligible: boolean
	/** Defaults to {@link jevSearchScoreBudgetMs}. */
	scoreBudgetMs?: number
	/** Caller search deadline; aborting it also aborts in-flight Score calls. */
	signal?: AbortSignal
}): Promise<JevSearchRerankResult> {
	const startedAt = performance.now()
	const hybridCandidates = input.candidates
	const candidatesBefore = hybridCandidates.length

	const emptyResult = (
		outcome: JevSearchRerankOutcome,
		extras?: {
			meanConfidence?: number | null
			errorReason?: string
			model?: typeof jevSearchModel
			aiCallCount?: number
			usage?: JevSearchTokenUsage
		},
	): JevSearchRerankResult => ({
		candidates: hybridCandidates.slice(0, Math.max(1, input.limit)),
		outcome,
		durationMs: performance.now() - startedAt,
		candidatesBefore,
		candidatesAfter: Math.min(candidatesBefore, Math.max(0, input.limit)),
		droppedCount: 0,
		meanConfidence: extras?.meanConfidence ?? null,
		top1Type: hybridCandidates[0]?.type ?? null,
		...(extras?.errorReason ? { errorReason: extras.errorReason } : {}),
		...(extras?.model
			? {
					model: extras.model,
					aiCallCount: extras.aiCallCount ?? 0,
					usage: extras.usage ?? {
						inputTokens: null,
						outputTokens: null,
					},
				}
			: {}),
	})

	if (!input.planEligible) return emptyResult('skipped-plan')
	const attempted = {
		model: jevSearchModel,
		aiCallCount: 0,
		usage: { inputTokens: null, outputTokens: null },
	} as const
	if (candidatesBefore === 0) return emptyResult('skipped-empty', attempted)
	if (input.offline) return emptyResult('skipped-offline', attempted)

	const necessity = evaluateJevSearchNecessity(hybridCandidates)
	if (!necessity.run) return emptyResult(necessity.outcome)

	const runtime = input.env as unknown as JevRuntimeEnv
	if (!runtime.AI) return emptyResult('skipped-no-ai', attempted)

	const pool = hybridCandidates.slice(0, jevSearchCandidateCap)
	const cards = pool.map((candidate, index) =>
		buildJevSearchSkinnyCard(candidate, index),
	)

	const tally = { aiCallCount: 0 }
	const budget = new AbortController()
	const timedOutResult = () =>
		emptyResult('fallback-timeout', {
			model: jevSearchModel,
			aiCallCount: tally.aiCallCount,
			usage: { inputTokens: null, outputTokens: null },
		})
	let budgetTimer: ReturnType<typeof setTimeout> | undefined
	let onCallerAbort: (() => void) | undefined
	try {
		const state = {
			query: input.query,
			intent: {
				task: input.intent.task.name,
				confidence: input.intent.confidence,
				normalizedQuery: input.intent.normalizedQuery,
			},
			candidates: cards,
		}
		const batches = buildQuestionBatches(
			cards.length,
			jevSearchScoreQuestionBatchSize,
		)
		const budgetExceeded = new Promise<'timeout'>((resolve) => {
			const expire = (reason: unknown) => {
				resolve('timeout')
				budget.abort(reason)
			}
			budgetTimer = setTimeout(() => {
				expire(new Error('jev-score-budget-exceeded'))
			}, input.scoreBudgetMs ?? jevSearchScoreBudgetMs)
			onCallerAbort = () => expire(input.signal?.reason)
			if (input.signal?.aborted) onCallerAbort()
			input.signal?.addEventListener('abort', onCallerAbort, { once: true })
		})
		const settled = await Promise.race([
			Promise.all(
				batches.map((indexes) =>
					runJevViaGateway(
						runtime as JevRuntimeEnv & { AI: Ai },
						{
							state,
							questions: buildJevQuestions(indexes),
						},
						budget.signal,
						tally,
					),
				),
			),
			budgetExceeded,
		])
		if (settled === 'timeout') return timedOutResult()
		const responses = settled
		const usage = sumTokenUsage(
			responses.map((response) => readResponseUsage(response.payload)),
		)
		const mergedAnswers = mergeScoreAnswers(
			responses.map((response) => response.payload),
		)
		const parsed = parseScoreAnswers(mergedAnswers, cards.length)
		if (!parsed.ok) {
			const sample =
				responses.find((response) => {
					const answers = asPlainRecord(response.payload.answers)
					return answers == null || Object.keys(answers).length === 0
				}) ?? responses[0]
			return emptyResult('fallback-error', {
				errorReason: incompleteScoreAnswersReason({
					...parsed,
					rawTopLevelKeys: sample?.rawTopLevelKeys ?? [],
					resultAnswers: sample?.resultAnswers ?? 'missing',
					answerKeys: Object.keys(mergedAnswers),
				}),
				model: jevSearchModel,
				aiCallCount: tally.aiCallCount,
				usage,
			})
		}
		const meanConfidence = mean(parsed.confidences)
		if (meanConfidence < jevSearchMinMeanConfidence) {
			return emptyResult('fallback-low-confidence', {
				meanConfidence,
				model: jevSearchModel,
				aiCallCount: tally.aiCallCount,
				usage,
			})
		}

		const ranked = pool
			.map((candidate, index) => ({
				candidate,
				score: parsed.scores[index]!,
				confidence: parsed.confidences[index]!,
			}))
			.sort((left, right) => {
				const scoreDiff = right.score - left.score
				if (scoreDiff !== 0) return scoreDiff
				return right.confidence - left.confidence
			})

		const { kept, keepPath } = selectJevKeptCandidates(ranked)
		if (kept.length === 0) {
			const identityKept = keepIdentityTermHybridCandidates({
				candidates: hybridCandidates,
				intent: input.intent,
				limit: input.limit,
			})
			if (identityKept.length > 0) {
				const keptIds = new Set(identityKept.map((candidate) => candidate.id))
				return {
					candidates: identityKept,
					outcome: 'applied',
					durationMs: performance.now() - startedAt,
					candidatesBefore,
					candidatesAfter: identityKept.length,
					droppedCount: pool.filter((candidate) => !keptIds.has(candidate.id))
						.length,
					meanConfidence,
					top1Type: identityKept[0]?.type ?? null,
					keepPath: 'kept-identity',
					model: jevSearchModel,
					aiCallCount: tally.aiCallCount,
					usage,
				}
			}
			return {
				candidates: [],
				outcome: 'fallback-empty-after-drop',
				durationMs: performance.now() - startedAt,
				candidatesBefore,
				candidatesAfter: 0,
				droppedCount: pool.length,
				meanConfidence,
				top1Type: null,
				keepPath,
				model: jevSearchModel,
				aiCallCount: tally.aiCallCount,
				usage,
			}
		}
		const candidates = kept
			.slice(0, Math.max(1, input.limit))
			.map((entry) => entry.candidate)
		return {
			candidates,
			outcome: 'applied',
			durationMs: performance.now() - startedAt,
			candidatesBefore,
			candidatesAfter: candidates.length,
			droppedCount: Math.max(0, pool.length - kept.length),
			meanConfidence,
			top1Type: candidates[0]?.type ?? null,
			keepPath,
			model: jevSearchModel,
			aiCallCount: tally.aiCallCount,
			usage,
		}
	} catch (error) {
		if (budget.signal.aborted) return timedOutResult()
		console.warn(
			JSON.stringify({
				message: 'Jev search rerank failed; using hybrid order',
				error: getErrorMessage(error),
			}),
		)
		return emptyResult('fallback-error', {
			errorReason: toJevErrorReason(error),
			model: jevSearchModel,
			aiCallCount: tally.aiCallCount,
			usage: { inputTokens: null, outputTokens: null },
		})
	} finally {
		clearTimeout(budgetTimer)
		if (onCallerAbort) input.signal?.removeEventListener('abort', onCallerAbort)
	}
}
