import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

import {
	evaluateJevSearchNecessity,
	jevSearchMinKeepScore,
	jevSearchModel,
	jevSearchNecessityMediumPoolMax,
	jevSearchNecessitySmallPoolMax,
	jevSearchNecessityTightScoreGap,
	jevSearchScoreBudgetMs,
	jevSearchScoreQuestionBatchSize,
	rerankSearchCandidatesWithJev,
	hybridCandidateMatchesIdentityTerm,
	selectJevKeptCandidates,
} from './search-jev-rerank.ts'
import {
	understandSearchQuery,
	type SearchIntent,
} from './understand-search-query.ts'
import { type SearchCandidate } from './search-types.ts'

function makeCandidate(
	overrides: Partial<SearchCandidate> & {
		id: string
		title: string
	},
): SearchCandidate {
	return {
		match: {
			type: 'capability',
			name: overrides.id,
			title: overrides.title,
			description: `${overrides.title} description`,
			domain: 'meta',
		},
		type: 'capability',
		searchFields: [overrides.title],
		scoreComponents: {
			base: 1,
			lexical: 1,
			vector: 0,
			entityMatch: 0,
			providerEntityAffinity: 0,
			actionMatch: 0,
			taskAffinity: 0,
			appAvailability: 0,
			wrapperWorkflow: 0,
			constraint: 0,
			final: 1,
		},
		...overrides,
	}
}

function makeCandidates(count: number): Array<SearchCandidate> {
	return Array.from({ length: count }, (_, index) =>
		makeCandidate({
			id: `card-${String(index)}`,
			title: `Card ${String(index)}`,
		}),
	)
}

/** Pool large enough that necessity always runs Jev (> medium max). */
function makeNecessityRunPool(
	seed: ReadonlyArray<SearchCandidate> = [],
): Array<SearchCandidate> {
	const needed = 21
	const extras = makeCandidates(Math.max(0, needed - seed.length)).map(
		(candidate, index) => ({
			...candidate,
			id: `pad-${String(index)}`,
			title: `Pad ${String(index)}`,
		}),
	)
	return [...seed, ...extras].slice(0, needed)
}

function scoreAnswersForQuestions(
	questions: Record<string, unknown>,
	scoreForKey: (key: string) => { score: number; confidence: number },
): Record<string, { type: 'score'; score: number; confidence: number }> {
	return Object.fromEntries(
		Object.keys(questions).map((key) => [
			key,
			{ type: 'score', ...scoreForKey(key) },
		]),
	)
}

type ScoreBody = { questions: Record<string, unknown> }

function scoreRun(
	scoreForKey: (key: string) => { score: number; confidence: number },
) {
	return vi.fn(async (_model: string, body: ScoreBody, _options?: unknown) => ({
		answers: scoreAnswersForQuestions(body.questions, scoreForKey),
	}))
}

function jevRunBody(run: ReturnType<typeof vi.fn>, callIndex: number) {
	return run.mock.calls[callIndex]?.[1] as {
		questions: Record<string, unknown>
		state: { candidates: Array<unknown> }
	}
}

function makeIntent(query: string, confidence: number): SearchIntent {
	return {
		normalizedQuery: query,
		tokens: query.split(' '),
		meaningfulTokens: query.split(' '),
		phrases: [query],
		task: { name: 'inspect', confidence },
		actions: [],
		entities: [],
		constraints: [],
		confidence,
	}
}

const pair = [
	makeCandidate({ id: 'a', title: 'A' }),
	makeCandidate({ id: 'b', title: 'B' }),
]
const gatewayOptions = {
	gateway: { id: 'kody' },
	signal: expect.any(AbortSignal),
}
const packagesQuery = {
	query: 'packages',
	intent: makeIntent('packages', 0.7),
}
const idsOf = (result: { candidates: Array<SearchCandidate> }) =>
	result.candidates.map((candidate) => candidate.id)

function rerank(
	run: unknown,
	overrides: Partial<Parameters<typeof rerankSearchCandidatesWithJev>[0]> = {},
) {
	return rerankSearchCandidatesWithJev({
		env: { AI: { run }, AI_GATEWAY_ID: 'kody' } as unknown as Env,
		query: 'send email',
		intent: makeIntent('send email', 0.9),
		candidates: makeNecessityRunPool(pair),
		limit: 2,
		offline: false,
		planEligible: true,
		...overrides,
	})
}

test('selectJevKeptCandidates uses high bar, secondary floor with cluster, or empty', () => {
	const select = (scores: Array<[string, number]>) => {
		const { kept, keepPath } = selectJevKeptCandidates(
			scores.map(([id, score]) => ({
				candidate: makeCandidate({ id, title: id }),
				score,
				confidence: 0.9,
			})),
		)
		return { keepPath, kept: kept.map((entry) => entry.candidate.id) }
	}

	expect(
		select([
			['strong', 1.5],
			['also-high', 1.7],
			['weak', 0.5],
		]),
	).toEqual({ keepPath: 'kept-high', kept: ['strong', 'also-high'] })
	expect(
		select([
			['mid-top', 1.2],
			['mid-near', 1.0],
			['mid-tail', 0.75],
			['noise', 0.2],
		]),
	).toEqual({
		keepPath: 'kept-lowered',
		kept: ['mid-top', 'mid-near', 'mid-tail'],
	})
	expect(
		select([
			['weak', 0.65],
			['weaker', 0.1],
		]),
	).toEqual({ keepPath: 'empty', kept: [] })
	expect(
		select([
			['mid-top', 1.4],
			['near', 0.91],
			['outside-cluster', 0.85],
		]),
	).toEqual({ keepPath: 'kept-lowered', kept: ['mid-top', 'near'] })
})

test('rerankSearchCandidatesWithJev skips offline or free plan and applies Score order', async () => {
	const unusedRun = vi.fn()
	const offline = await rerank(unusedRun, {
		env: {} as Env,
		candidates: pair,
		limit: 1,
		offline: true,
	})
	expect(offline.outcome).toBe('skipped-offline')
	expect(offline.candidates).toEqual([pair[0]])
	expect(offline.aiCallCount).toBe(0)
	expect(offline.usage).toEqual({ inputTokens: null, outputTokens: null })

	const freePlan = await rerank(unusedRun, {
		env: { AI: { run: unusedRun } } as unknown as Env,
		candidates: pair,
		limit: 1,
		planEligible: false,
	})
	expect(freePlan.outcome).toBe('skipped-plan')
	expect(freePlan.candidates).toEqual([pair[0]])
	expect(freePlan.model).toBeUndefined()
	expect(freePlan.aiCallCount).toBeUndefined()
	expect(freePlan.usage).toBeUndefined()
	expect(unusedRun).not.toHaveBeenCalled()

	const applyRun = scoreRun((key) => {
		if (key === 'c1') return { score: 2.7, confidence: 0.95 }
		if (key === 'c0') return { score: 0.2, confidence: 0.9 }
		return { score: jevSearchMinKeepScore - 0.2, confidence: 0.8 }
	})
	const exportHit = makeCandidate({
		id: 'home-controls#./bond-area-shades',
		title: '@kody/home-controls setBondAreaShades',
		type: 'package',
		match: {
			type: 'package',
			packageId: 'pkg-1',
			kodyId: 'home-controls',
			name: '@kody/home-controls',
			title: '@kody/home-controls setBondAreaShades',
			description: 'Dim bond area shades for evening.',
			tags: ['home'],
			hasApp: false,
			hidden: false,
			exportSubpath: './bond-area-shades',
			actionMatches: [],
		},
	})
	const appliedPool = makeNecessityRunPool([
		...['noise', 'email', 'weak'].map((id) =>
			makeCandidate({ id, title: id[0]!.toUpperCase() + id.slice(1) }),
		),
		exportHit,
	])
	const applied = await rerank(applyRun, { candidates: appliedPool })
	expect(applied).toMatchObject({
		outcome: 'applied',
		keepPath: 'kept-high',
		usage: { inputTokens: null, outputTokens: null },
		droppedCount: appliedPool.length - 1,
		top1Type: 'capability',
	})
	expect(applied.errorReason).toBeUndefined()
	expect(applied.aiCallCount).toBeGreaterThan(0)
	expect(idsOf(applied)).toEqual(['email'])
	expect(applyRun.mock.calls[0]?.[0]).toBe('typesafe/jev')
	expect(applyRun.mock.calls[0]?.[2]).toEqual(gatewayOptions)
	const capabilityState = (index: number, id: string, title: string) => ({
		index,
		type: 'capability',
		id,
		title,
		summary: `${title} description`,
		domain: 'meta',
	})
	expect(applyRun.mock.calls[0]?.[1]).toEqual(
		expect.objectContaining({
			state: expect.objectContaining({
				query: 'send email',
				candidates: expect.arrayContaining([
					capabilityState(0, 'noise', 'Noise'),
					capabilityState(1, 'email', 'Email'),
					capabilityState(2, 'weak', 'Weak'),
					{
						index: 3,
						type: 'package',
						id: 'home-controls#./bond-area-shades',
						title: '@kody/home-controls setBondAreaShades',
						summary: './bond-area-shades: Dim bond area shades for evening.',
						exportSubpath: './bond-area-shades',
					},
				]),
			}),
		}),
	)

	const emptyAfterDrop = await rerank(
		scoreRun(() => ({ score: jevSearchMinKeepScore - 1, confidence: 0.9 })),
	)
	expect(emptyAfterDrop).toMatchObject({
		outcome: 'fallback-empty-after-drop',
		keepPath: 'empty',
		candidates: [],
		candidatesAfter: 0,
		droppedCount: emptyAfterDrop.candidatesBefore,
	})

	const dropboxIntent = understandSearchQuery({
		query: 'dropbox shared link',
		entities: [],
	})
	const dropboxPackage = makeCandidate({
		id: 'dropbox',
		title: '@acme/dropbox',
		type: 'package',
		match: {
			type: 'package',
			packageId: 'pkg-dropbox',
			kodyId: 'dropbox',
			name: '@acme/dropbox',
			title: '@acme/dropbox',
			description: 'Direct download URLs and shared-link helpers.',
			tags: ['files'],
			hasApp: false,
			hidden: false,
			actionMatches: [],
		},
	})
	const descriptionOnlyPackage = makeCandidate({
		id: 'notes',
		title: '@acme/notes',
		type: 'package',
		match: {
			type: 'package',
			packageId: 'pkg-notes',
			kodyId: 'notes',
			name: '@acme/notes',
			title: '@acme/notes',
			description: 'dropbox shared link notes that are not the package.',
			tags: ['shared', 'link'],
			hasApp: false,
			hidden: false,
			actionMatches: [],
		},
	})
	const identityKept = await rerank(
		scoreRun(() => ({ score: jevSearchMinKeepScore - 1, confidence: 0.9 })),
		{
			query: 'dropbox shared link',
			intent: dropboxIntent,
			limit: 5,
			candidates: makeNecessityRunPool([
				descriptionOnlyPackage,
				dropboxPackage,
				makeCandidate({ id: 'shared', title: 'Shared link capability' }),
			]),
		},
	)
	expect(identityKept).toMatchObject({
		outcome: 'applied',
		keepPath: 'kept-identity',
		top1Type: 'package',
	})
	expect(idsOf(identityKept)).toEqual(['dropbox'])
	expect(identityKept.candidatesAfter).toBe(1)
	expect(identityKept.droppedCount).toBeGreaterThan(0)

	const longName = makeCandidate({
		id: 'home-assistant-controls',
		title: '@user/home-assistant-controls',
		type: 'package',
		match: {
			type: 'package',
			packageId: 'pkg-home',
			kodyId: 'home-assistant-controls',
			name: '@user/home-assistant-controls',
			title: '@user/home-assistant-controls',
			description: 'Controls for the house.',
			tags: [],
			hasApp: false,
			hidden: false,
			actionMatches: [],
		},
	})
	const longNameIntent = understandSearchQuery({
		query: 'use home assistant controls',
		entities: [],
	})
	expect(hybridCandidateMatchesIdentityTerm(longName, longNameIntent)).toBe(
		true,
	)
	expect(
		hybridCandidateMatchesIdentityTerm(descriptionOnlyPackage, longNameIntent),
	).toBe(false)
	const longNameMatch = longName.match
	if (longNameMatch.type !== 'package') {
		throw new Error('expected a package candidate')
	}
	expect(
		hybridCandidateMatchesIdentityTerm(
			{
				...longName,
				id: 'home-assistant-controls#./controls',
				match: { ...longNameMatch, exportSubpath: './controls' },
			},
			longNameIntent,
		),
	).toBe(false)

	const midTier = await rerank(
		scoreRun((key) => {
			if (key === 'c0') return { score: 1.2, confidence: 0.9 }
			if (key === 'c1') return { score: 1.05, confidence: 0.85 }
			return { score: 0.2, confidence: 0.8 }
		}),
		{ limit: 5 },
	)
	expect(midTier.outcome).toBe('applied')
	expect(midTier.keepPath).toBe('kept-lowered')
	expect(idsOf(midTier)).toEqual(['a', 'b'])
})

test('rerankSearchCandidatesWithJev falls back to hybrid order with a bounded error reason', async () => {
	consoleWarn.mockImplementation(() => {})
	const incompletePool = makeNecessityRunPool(pair)
	const throwing = (message: string) =>
		vi.fn(async () => {
			throw new Error(message)
		})
	const balanceMessage =
		'Insufficient balance; add money to your gateway or use BYOK'
	const cases = [
		{
			name: 'missing gateway',
			run: vi.fn(),
			env: (run: unknown) => ({ AI: { run } }),
			errorReason: 'ai-gateway-required-for-typesafe-jev',
			calls: 0,
		},
		{
			name: 'blank gateway',
			run: vi.fn(),
			env: (run: unknown) => ({ AI: { run }, AI_GATEWAY_ID: '   ' }),
			errorReason: 'ai-gateway-required-for-typesafe-jev',
			calls: 0,
		},
		{
			name: 'provider error message',
			run: throwing(balanceMessage),
			errorReason: balanceMessage,
		},
		{
			name: 'blank error message',
			run: throwing('   '),
			errorReason: 'unknown-jev-error',
		},
		{
			name: 'incomplete answers',
			run: vi.fn(async () => ({
				answers: { c0: { type: 'score', score: 2.4 } },
			})),
			errorReason: `incomplete-score-answers expected=${String(incompletePool.length)} received=0 keys=answers result.answers=missing answerKeys=c0`,
		},
	]
	for (const { run, env, errorReason, calls } of cases) {
		const result = await rerank(run, {
			...packagesQuery,
			candidates: incompletePool,
			...(env ? { env: env(run) as unknown as Env } : {}),
		})
		expect(result).toMatchObject({
			outcome: 'fallback-error',
			errorReason,
			model: jevSearchModel,
		})
		expect(idsOf(result)).toEqual(['a', 'b'])
		if (calls === 0) {
			expect(result.aiCallCount).toBe(0)
			expect(result.usage).toEqual({ inputTokens: null, outputTokens: null })
			expect(run).not.toHaveBeenCalled()
		} else {
			expect(run.mock.calls[0]?.[2]).toEqual(gatewayOptions)
		}
	}
	expect(consoleWarn).toHaveBeenCalled()

	const longError = await rerank(
		throwing(
			`Gateway authentication is required to use unified billing. ${'x'.repeat(300)}`,
		),
		packagesQuery,
	)
	expect(longError.outcome).toBe('fallback-error')
	expect(longError.errorReason?.length).toBeLessThanOrEqual(240)
	expect(longError.errorReason?.endsWith('...')).toBe(true)
})

test('rerankSearchCandidatesWithJev batches Score questions, sums usage, and fails on a partial batch', async () => {
	const widePool = makeCandidates(jevSearchScoreQuestionBatchSize + 4)
	const bestWideId = widePool[widePool.length - 1]!.id
	const firstBatchKeys = Array.from(
		{ length: jevSearchScoreQuestionBatchSize },
		(_, index) => `c${String(index)}`,
	)
	const multiBatchRun = vi.fn(
		async (_model: string, body: ScoreBody, _options?: unknown) => ({
			answers: scoreAnswersForQuestions(body.questions, (key) =>
				key === `c${String(widePool.length - 1)}`
					? { score: 2.8, confidence: 0.96 }
					: { score: 0.3, confidence: 0.9 },
			),
			usage: Object.keys(body.questions).includes('c0')
				? { prompt_tokens: 40, completion_tokens: 12 }
				: { input_tokens: 18, output_tokens: 7 },
		}),
	)
	const multiBatch = await rerank(multiBatchRun, { candidates: widePool })
	expect(multiBatch).toMatchObject({
		outcome: 'applied',
		model: jevSearchModel,
		aiCallCount: 2,
		usage: { inputTokens: 58, outputTokens: 19 },
	})
	expect(multiBatch.errorReason).toBeUndefined()
	expect(idsOf(multiBatch)).toEqual([bestWideId])
	expect(multiBatchRun.mock.calls.map((call) => call[2])).toEqual([
		gatewayOptions,
		gatewayOptions,
	])
	expect(Object.keys(jevRunBody(multiBatchRun, 0).questions)).toEqual(
		firstBatchKeys,
	)
	expect(Object.keys(jevRunBody(multiBatchRun, 1).questions)).toEqual(
		Array.from(
			{ length: 4 },
			(_, index) => `c${String(jevSearchScoreQuestionBatchSize + index)}`,
		),
	)
	for (const callIndex of [0, 1]) {
		expect(jevRunBody(multiBatchRun, callIndex).state.candidates).toHaveLength(
			widePool.length,
		)
	}

	const partialBatchRun = vi.fn(
		async (_model: string, body: ScoreBody, _options?: unknown) =>
			Object.keys(body.questions).includes('c0')
				? {
						answers: scoreAnswersForQuestions(body.questions, () => ({
							score: 2.1,
							confidence: 0.9,
						})),
					}
				: { answers: {} },
	)
	const partialBatch = await rerank(partialBatchRun, { candidates: widePool })
	expect(partialBatch).toMatchObject({
		outcome: 'fallback-error',
		model: jevSearchModel,
		aiCallCount: 2,
		errorReason: `incomplete-score-answers expected=${String(widePool.length)} received=${String(jevSearchScoreQuestionBatchSize)} keys=answers result.answers=missing answerKeys=${firstBatchKeys.join(',')}`,
	})
	expect(idsOf(partialBatch)).toEqual([widePool[0]!.id, widePool[1]!.id])
	expect(partialBatchRun.mock.calls.map((call) => call[2])).toEqual([
		gatewayOptions,
		gatewayOptions,
	])
})

test('rerankSearchCandidatesWithJev aborts Score batches past the budget and keeps hybrid order', async () => {
	vi.useFakeTimers()
	try {
		const signals: Array<AbortSignal> = []
		const hangingRun = vi.fn(
			(_model: string, _body: unknown, options: { signal: AbortSignal }) => {
				signals.push(options.signal)
				return new Promise((_, reject) => {
					options.signal.addEventListener('abort', () => {
						reject(options.signal.reason)
					})
				})
			},
		)
		const pool = makeNecessityRunPool()
		const pending = rerank(hangingRun, { candidates: pool })
		await vi.advanceTimersByTimeAsync(jevSearchScoreBudgetMs - 1)
		expect(signals.every((signal) => !signal.aborted)).toBe(true)
		await vi.advanceTimersByTimeAsync(1)
		const result = await pending

		expect(result.outcome).toBe('fallback-timeout')
		expect(result.errorReason).toBeUndefined()
		expect(result.model).toBe(jevSearchModel)
		expect(result.aiCallCount).toBe(3)
		expect(idsOf(result)).toEqual([pool[0]!.id, pool[1]!.id])
		expect(signals.length).toBeGreaterThan(0)
		expect(signals.every((signal) => signal.aborted)).toBe(true)
	} finally {
		vi.useRealTimers()
	}
})

test('rerankSearchCandidatesWithJev aborts in-flight Score batches when the caller search deadline aborts', async () => {
	const signals: Array<AbortSignal> = []
	const hangingRun = vi.fn(
		(_model: string, _body: unknown, options: { signal: AbortSignal }) => {
			signals.push(options.signal)
			return new Promise(() => {})
		},
	)
	const caller = new AbortController()
	const pending = rerank(hangingRun, {
		candidates: makeNecessityRunPool(),
		limit: 1,
		signal: caller.signal,
	})
	await Promise.resolve()
	caller.abort(new Error('search-deadline'))
	const result = await pending
	expect(result.outcome).toBe('fallback-timeout')
	expect(signals.length).toBeGreaterThan(0)
	expect(signals.every((signal) => signal.aborted)).toBe(true)
})

test('rerankSearchCandidatesWithJev times out even when the AI binding ignores abort', async () => {
	vi.useFakeTimers()
	try {
		const pool = makeNecessityRunPool()
		const pending = rerank(
			vi.fn(() => new Promise(() => {})),
			{ candidates: pool, limit: 1, scoreBudgetMs: 50 },
		)
		await vi.advanceTimersByTimeAsync(50)
		const result = await pending
		expect(result.outcome).toBe('fallback-timeout')
		expect(idsOf(result)).toEqual([pool[0]!.id])
	} finally {
		vi.useRealTimers()
	}
})

test('rerankSearchCandidatesWithJev applies wrapped gateway Score answers and samples missing-answer keys', async () => {
	const wrappedPool = makeNecessityRunPool(pair)
	const wrappedBatches = Math.ceil(
		wrappedPool.length / jevSearchScoreQuestionBatchSize,
	)

	const wrappedRun = vi.fn(async (_model: string, body: ScoreBody) => ({
		success: true,
		errors: [],
		messages: [],
		result: {
			model: 'jev-1.13.0',
			answers: scoreAnswersForQuestions(body.questions, (key) =>
				key === 'c1'
					? { score: 2.7, confidence: 0.95 }
					: { score: 0.2, confidence: 0.9 },
			),
			usage: { input_tokens: 426, output_tokens: 73 },
		},
	}))
	const wrapped = await rerank(wrappedRun, { candidates: wrappedPool })
	expect(wrapped.outcome).toBe('applied')
	expect(wrapped.errorReason).toBeUndefined()
	expect(idsOf(wrapped)).toEqual(['b'])
	expect(wrapped.usage).toEqual({
		inputTokens: 426 * wrappedBatches,
		outputTokens: 73 * wrappedBatches,
	})
	expect(wrappedRun).toHaveBeenCalledTimes(wrappedBatches)

	const unwrapped = await rerank(
		vi.fn(async (_model: string, body: ScoreBody) => ({
			model: 'jev-1.13.0',
			answers: scoreAnswersForQuestions(body.questions, (key) =>
				key === 'c0'
					? { score: 2.8, confidence: 0.91 }
					: { score: 0.4, confidence: 0.88 },
			),
			usage: { input_tokens: 190, output_tokens: 0 },
		})),
		{ candidates: wrappedPool },
	)
	expect(unwrapped.outcome).toBe('applied')
	expect(idsOf(unwrapped)).toEqual(['a'])
	expect(unwrapped.usage).toEqual({
		inputTokens: 190 * wrappedBatches,
		outputTokens: 0,
	})

	const missingAnswers = await rerank(
		vi.fn(async () => ({
			success: true,
			errors: [],
			result: { model: 'jev-1.13.0' },
		})),
		{ candidates: wrappedPool },
	)
	expect(missingAnswers.outcome).toBe('fallback-error')
	expect(missingAnswers.errorReason).toBe(
		`incomplete-score-answers expected=${String(wrappedPool.length)} received=0 keys=success,errors,result result.answers=missing answerKeys=none`,
	)
	expect(missingAnswers.usage).toEqual({
		inputTokens: null,
		outputTokens: null,
	})
})

test('rerankSearchCandidatesWithJev skips free plan and clear small pools', async () => {
	const unusedRun = vi.fn()
	const skipEnv = { env: { AI: { run: unusedRun } } as unknown as Env }

	const freePlan = await rerank(unusedRun, {
		...skipEnv,
		candidates: makeNecessityRunPool(),
		planEligible: false,
	})
	expect(freePlan.outcome).toBe('skipped-plan')

	const small = await rerank(unusedRun, {
		...skipEnv,
		candidates: makeCandidates(jevSearchNecessitySmallPoolMax),
	})
	expect(small.outcome).toBe('skipped-small-pool')

	const clearWinner = makeCandidates(jevSearchNecessityMediumPoolMax).map(
		(candidate, index) => ({
			...candidate,
			scoreComponents: {
				...candidate.scoreComponents,
				final: index === 0 ? 2 : 0.2,
			},
		}),
	)
	expect(evaluateJevSearchNecessity(clearWinner)).toEqual({
		run: false,
		outcome: 'skipped-clear-winner',
	})
	const clear = await rerank(unusedRun, { ...skipEnv, candidates: clearWinner })
	expect(clear.outcome).toBe('skipped-clear-winner')
	expect(unusedRun).not.toHaveBeenCalled()

	const tightMedium = makeCandidates(12).map((candidate, index) => ({
		...candidate,
		scoreComponents: {
			...candidate.scoreComponents,
			final: 1 - index * (jevSearchNecessityTightScoreGap / 2),
		},
	}))
	expect(evaluateJevSearchNecessity(tightMedium)).toEqual({ run: true })
	expect(evaluateJevSearchNecessity(makeCandidates(21))).toEqual({ run: true })
})
