import { blendLexicalAndVectorScore } from '#worker/vectorize/scoring.ts'

import { type SearchMatch } from './search-format.ts'
import {
	type SearchCandidate,
	type SearchScoreComponents,
	type SearchTelemetry,
} from './search-types.ts'
import {
	type SearchIntent,
	extractSearchTokens,
	normalizeSearchText,
} from './understand-search-query.ts'

export function buildCandidateTelemetry(input: {
	intent: SearchIntent
	candidates: Array<SearchCandidate>
	matches: Array<SearchMatch>
	trimmedMatchCount?: number
}): SearchTelemetry {
	const candidateCounts = input.candidates.reduce(
		(counts, candidate) => {
			counts[candidate.type] = (counts[candidate.type] ?? 0) + 1
			return counts
		},
		{} as Partial<Record<SearchMatch['type'], number>>,
	)

	return {
		intent: {
			task: input.intent.task.name,
			confidence: input.intent.confidence,
			entityCount: input.intent.entities.length,
			actionCount: input.intent.actions.length,
			constraintCount: input.intent.constraints.length,
			topEntities: input.intent.entities.slice(0, 3).map((entity) => ({
				type: entity.type,
				id: entity.id,
				confidence: entity.confidence,
			})),
		},
		candidateCounts,
		topResultTypes: input.matches.slice(0, 5).map((match) => match.type),
		...(input.trimmedMatchCount !== undefined
			? {
					trimmedMatchCount: input.trimmedMatchCount,
					responseTrimmed: input.trimmedMatchCount > 0,
				}
			: {}),
	}
}

export function buildCandidateBaseScore(input: {
	lexical: number
	vector?: number
}): SearchScoreComponents {
	const vector = input.vector ?? 0
	return {
		base:
			input.vector === undefined
				? input.lexical
				: blendLexicalAndVectorScore(input.lexical, vector),
		lexical: input.lexical,
		vector,
		entityMatch: 0,
		providerEntityAffinity: 0,
		actionMatch: 0,
		taskAffinity: 0,
		appAvailability: 0,
		wrapperWorkflow: 0,
		constraint: 0,
		final:
			input.vector === undefined
				? input.lexical
				: blendLexicalAndVectorScore(input.lexical, vector),
	}
}

export function scoreMatchedTerms(
	fields: ReadonlyArray<string>,
	matchedTerms: ReadonlyArray<string>,
): number {
	if (matchedTerms.length === 0 || fields.length === 0) return 0
	const fieldTokens = new Set<string>()
	for (const field of fields) {
		if (typeof field !== 'string') continue
		for (const token of extractSearchTokens(field)) {
			fieldTokens.add(token)
		}
	}
	let matched = 0
	for (const term of matchedTerms) {
		if (fieldTokens.has(term)) matched += 1
	}
	return matched / Math.max(1, matchedTerms.length)
}

function semanticSearchConcept(token: string): string {
	const normalized = normalizeSearchText(token)
	if (['speaker', 'speakers', 'player', 'players'].includes(normalized)) {
		return 'media-player'
	}
	if (
		[
			'playing',
			'paused',
			'running',
			'connected',
			'disconnected',
			'status',
			'statuses',
			'state',
			'states',
		].includes(normalized)
	) {
		return 'live-state'
	}
	if (normalized.endsWith('ies') && normalized.length > 3) {
		return `${normalized.slice(0, -3)}y`
	}
	if (
		normalized.endsWith('s') &&
		normalized.length > 3 &&
		!normalized.endsWith('ss')
	) {
		return normalized.slice(0, -1)
	}
	return normalized
}

function scoreSemanticMatchedTerms(
	fields: ReadonlyArray<string>,
	matchedTerms: ReadonlyArray<string>,
): number {
	if (matchedTerms.length === 0 || fields.length === 0) return 0
	const fieldConcepts = new Set(
		fields.flatMap((field) =>
			extractSearchTokens(field).map(semanticSearchConcept),
		),
	)
	const matched = matchedTerms.filter((term) =>
		fieldConcepts.has(semanticSearchConcept(term)),
	).length
	return matched / matchedTerms.length
}

const nonIdentityQueryTerms = new Set([
	'any',
	'are',
	'be',
	'do',
	'does',
	'is',
	'whether',
])

function getSearchIdentityTerms(intent: SearchIntent): Array<string> {
	const actionTerms = new Set(
		intent.actions.flatMap((action) => action.matchedTerms),
	)
	const constraintTerms = new Set(
		intent.constraints.map((constraint) => constraint.value),
	)
	return intent.meaningfulTokens.filter(
		(token) =>
			!actionTerms.has(token) &&
			!constraintTerms.has(token) &&
			!nonIdentityQueryTerms.has(token),
	)
}

function scoreConstraintBoost(
	fields: ReadonlyArray<string>,
	intent: SearchIntent,
): number {
	if (intent.constraints.length === 0) return 0
	const normalizedFields = fields
		.filter((field): field is string => typeof field === 'string')
		.map((field) => normalizeSearchText(field))
	let score = 0
	for (const constraint of intent.constraints) {
		if (
			normalizedFields.some((field) =>
				field.includes(normalizeSearchText(constraint.value)),
			) ||
			scoreSemanticMatchedTerms(fields, [constraint.value]) > 0
		) {
			score += 0.08
		}
	}
	return score
}

const wrapperWorkflowTokenSignals = new Set([
	'wrap',
	'wrapper',
	'wrappers',
	'wraps',
	'wrapping',
	'safe',
	'safer',
	'safety',
	'guardrail',
	'guardrails',
	'confirmation',
	'confirm',
	'confirmed',
	'workflow',
	'workflows',
	'orchestrate',
	'orchestrates',
	'orchestration',
	'automation',
	'automations',
	'helper',
	'helpers',
])

const wrapperWorkflowPhraseSignals = [
	'package first',
	'high level',
	'higher level',
	'safe wrapper',
	'workflow glue',
] as const

const packageSurfaceTokenSignals = new Set([
	'app',
	'ui',
	'workflow',
	'workflows',
	'subscription',
	'subscriptions',
	'job',
	'jobs',
])

function scorePackageWrapperWorkflowBoost(
	candidate: SearchCandidate,
	intent: SearchIntent,
) {
	if (candidate.type !== 'package') return 0
	if (intent.meaningfulTokens.length === 0) return 0

	const fieldText = candidate.searchFields.join('\n')
	const fieldTokens = new Set(extractSearchTokens(fieldText))
	const normalizedFieldText = normalizeSearchText(fieldText)
	const matchedQueryTerms = intent.meaningfulTokens.filter((token) =>
		fieldTokens.has(token),
	)
	const queryCoverage =
		matchedQueryTerms.length / Math.max(1, intent.meaningfulTokens.length)
	const actionTermCount = intent.actions.flatMap(
		(action) => action.matchedTerms,
	).length
	const actionCoverage = scoreMatchedTerms(
		candidate.searchFields,
		intent.actions.flatMap((action) => action.matchedTerms),
	)

	const wrapperSignalCount = [...wrapperWorkflowTokenSignals].filter((token) =>
		fieldTokens.has(token),
	).length
	const wrapperPhraseCount = wrapperWorkflowPhraseSignals.filter((phrase) =>
		normalizedFieldText.includes(phrase),
	).length
	const surfaceSignalCount = [...packageSurfaceTokenSignals].filter((token) =>
		fieldTokens.has(token),
	).length
	const hasPackageSurface =
		surfaceSignalCount > 0 ||
		('hasApp' in candidate.match && candidate.match.hasApp)

	if (wrapperSignalCount + wrapperPhraseCount === 0 && !hasPackageSurface) {
		return 0
	}
	if (queryCoverage < 0.2 && (actionTermCount === 0 || actionCoverage <= 0)) {
		return 0
	}

	const taskWeight =
		intent.task.name === 'learn'
			? 0.25
			: intent.task.name === 'inspect' && isLiveStatusInspect(intent)
				? 0.15
				: intent.task.name === 'unknown'
					? 0.75
					: 1
	const confidenceWeight = Math.min(
		1,
		Math.max(0.35, intent.confidence, intent.task.confidence),
	)
	let boost = 0
	if (wrapperSignalCount > 0) boost += 0.14
	if (wrapperPhraseCount > 0) boost += 0.1
	if (hasPackageSurface) boost += 0.1
	if ('hasApp' in candidate.match && candidate.match.hasApp) boost += 0.04
	boost += Math.min(0.1, queryCoverage * 0.16)
	boost += Math.min(0.08, actionCoverage * 0.1)
	return Math.min(0.42, boost) * confidenceWeight * taskWeight
}

function isPackageOrientedInspect(intent: SearchIntent): boolean {
	return intent.meaningfulTokens.some((token) =>
		[
			'note',
			'notes',
			'package',
			'packages',
			'setup',
			'readme',
			'doc',
			'docs',
		].includes(token),
	)
}

/** Inspect queries about live device/playback state, not package notes. */
function isLiveStatusInspect(intent: SearchIntent): boolean {
	if (intent.task.name !== 'inspect') return false
	if (isPackageOrientedInspect(intent)) return false
	return (
		intent.constraints.some((constraint) => constraint.kind === 'state') ||
		intent.actions.some(
			(action) =>
				action.name === 'inspect' &&
				action.matchedTerms.some((term) =>
					[
						'check',
						'whether',
						'playing',
						'status',
						'running',
						'paused',
						'connected',
						'disconnected',
					].includes(term),
				),
		)
	)
}

function scoreTaskAffinity(
	candidate: SearchCandidate,
	intent: SearchIntent,
): Pick<
	SearchScoreComponents,
	| 'taskAffinity'
	| 'actionMatch'
	| 'appAvailability'
	| 'wrapperWorkflow'
	| 'constraint'
> {
	const taskConfidenceWeight = Math.min(
		1,
		Math.max(0.2, intent.task.confidence),
	)
	const matchedActionTerms = intent.actions.flatMap(
		(action) => action.matchedTerms,
	)
	const actionMatch =
		scoreSemanticMatchedTerms(candidate.searchFields, matchedActionTerms) *
		0.25 *
		taskConfidenceWeight
	const constraint =
		scoreConstraintBoost(candidate.searchFields, intent) * taskConfidenceWeight

	let taskAffinity = 0
	let appAvailability = 0

	switch (intent.task.name) {
		case 'operate':
			if (candidate.type === 'package') {
				taskAffinity += 0.16
				if ('hasApp' in candidate.match && candidate.match.hasApp) {
					appAvailability += 0.12
				}
			}
			if (candidate.type === 'integration') taskAffinity += 0.08
			if (candidate.type === 'capability') taskAffinity -= 0.04
			break
		case 'setup':
			if (candidate.type === 'integration') taskAffinity += 0.18
			if (candidate.type === 'capability') taskAffinity += 0.05
			break
		case 'inspect': {
			const packageOrientedInspect = isPackageOrientedInspect(intent)
			const liveStatusInspect = isLiveStatusInspect(intent)
			if (packageOrientedInspect) {
				if (candidate.type === 'capability') taskAffinity += 0.04
				if (candidate.type === 'integration') {
					taskAffinity += 0.06
				}
				if (candidate.type === 'package') taskAffinity += 0.16
			} else if (liveStatusInspect) {
				const inspectionTerms = [
					'status',
					'list',
					'state',
					'current',
					'playing',
					'show',
					'check',
				] as const
				const inspectionKeyHits = inspectionTerms.filter(
					(term) => scoreMatchedTerms(candidate.searchFields, [term]) > 0,
				).length
				if (candidate.type === 'capability') {
					taskAffinity += 0.16 + Math.min(0.16, inspectionKeyHits * 0.08)
				}
				if (candidate.type === 'integration') {
					taskAffinity += 0.06
				}
				if (candidate.type === 'package') {
					taskAffinity -= 0.12
					if (inspectionKeyHits === 0) taskAffinity -= 0.1
				}
			} else {
				if (candidate.type === 'integration') {
					taskAffinity += 0.12
				}
				if (candidate.type === 'package') taskAffinity += 0.05
			}
			break
		}
		case 'learn':
			if (candidate.type === 'capability') taskAffinity += 0.16
			if (candidate.type === 'package') taskAffinity -= 0.02
			break
		case 'debug':
			if (candidate.type === 'integration') taskAffinity += 0.16
			if (candidate.type === 'package') {
				taskAffinity += 0.1
				if ('hasApp' in candidate.match && candidate.match.hasApp) {
					appAvailability += 0.08
				}
			}
			if (candidate.type === 'capability') taskAffinity += 0.06
			break
		case 'unknown':
			break
	}

	return {
		taskAffinity: taskAffinity * taskConfidenceWeight,
		actionMatch,
		appAvailability,
		wrapperWorkflow: scorePackageWrapperWorkflowBoost(candidate, intent),
		constraint,
	}
}

function findStrongSynthesizedIdentityTerms(input: {
	candidates: Array<SearchCandidate>
	intent: SearchIntent
}): Map<string, Set<string>> {
	const queryIdentityTerms = getSearchIdentityTerms(input.intent)
	const candidatesByProvider = new Map<string, Array<SearchCandidate>>()
	for (const candidate of input.candidates) {
		if (!candidate.synthesizedProviderKey) continue
		const group =
			candidatesByProvider.get(candidate.synthesizedProviderKey) ?? []
		group.push(candidate)
		candidatesByProvider.set(candidate.synthesizedProviderKey, group)
	}

	const strongTermsByProvider = new Map<string, Set<string>>()
	for (const [providerKey, candidates] of candidatesByProvider) {
		const providerConcepts = new Set(
			candidates
				.flatMap((candidate) =>
					(candidate.providerIdentityFields ?? []).flatMap(extractSearchTokens),
				)
				.map(semanticSearchConcept),
		)
		const operationConceptCounts = new Map<string, number>()
		for (const candidate of candidates) {
			const candidateConcepts = new Set(
				(candidate.identityFields ?? [])
					.flatMap(extractSearchTokens)
					.map(semanticSearchConcept),
			)
			for (const concept of candidateConcepts) {
				operationConceptCounts.set(
					concept,
					(operationConceptCounts.get(concept) ?? 0) + 1,
				)
			}
		}
		const strongTerms = queryIdentityTerms.filter((term) => {
			const concept = semanticSearchConcept(term)
			return (
				providerConcepts.has(concept) ||
				(operationConceptCounts.get(concept) ?? 0) >= 2
			)
		})
		if (strongTerms.length > 0) {
			strongTermsByProvider.set(providerKey, new Set(strongTerms))
		}
	}
	return strongTermsByProvider
}

const maxSynthesizedProviderEntityAffinity = 1.1
const maxPackageProviderEntityAffinity = 1.15

function findPackageProviderAffinity(input: {
	candidate: SearchCandidate
	candidates: ReadonlyArray<SearchCandidate>
	strongIdentityTermsByProvider: ReadonlyMap<string, ReadonlySet<string>>
}): number {
	if (
		input.candidate.type !== 'package' ||
		!input.candidate.packageIdentityFields?.length
	) {
		return 0
	}
	let affinity = 0
	for (const [
		providerKey,
		strongTerms,
	] of input.strongIdentityTermsByProvider) {
		const providerIdentityFields = input.candidates.flatMap((candidate) =>
			candidate.synthesizedProviderKey === providerKey
				? (candidate.providerIdentityFields ?? [])
				: [],
		)
		const providerTerms = Array.from(
			new Set(providerIdentityFields.flatMap(extractSearchTokens)),
		)
		if (
			scoreSemanticMatchedTerms(
				input.candidate.packageIdentityFields,
				providerTerms,
			) <= 0 ||
			scoreSemanticMatchedTerms(input.candidate.packageIdentityFields, [
				...strongTerms,
			]) <= 0
		) {
			continue
		}
		affinity = Math.max(
			affinity,
			Math.min(
				maxPackageProviderEntityAffinity,
				scoreSemanticMatchedTerms(
					input.candidate.packageIdentityFields,
					providerTerms,
				) * maxPackageProviderEntityAffinity,
			),
		)
	}
	return affinity
}

function hasExactNonProviderEntityTarget(input: {
	candidates: ReadonlyArray<SearchCandidate>
	intent: SearchIntent
}): boolean {
	return input.candidates.some(
		(candidate) =>
			candidate.synthesizedProviderKey == null &&
			[candidate.id, candidate.title].some(
				(identity) =>
					normalizeSearchText(identity).trim() === input.intent.normalizedQuery,
			),
	)
}

export function rerankCandidates(input: {
	candidates: Array<SearchCandidate>
	intent: SearchIntent
	limit: number
}): Array<SearchCandidate> {
	const entityConfidenceByKey = new Map<string, number>(
		input.intent.entities.map((entity) => [
			`${entity.type}:${entity.id}`,
			entity.confidence,
		]),
	)
	const rerankWeight = Math.min(1, Math.max(0.25, input.intent.confidence))
	const strongIdentityTermsByProvider =
		findStrongSynthesizedIdentityTerms(input)
	const exactNonProviderEntityTarget = hasExactNonProviderEntityTarget(input)

	const reranked = input.candidates.map((candidate) => {
		const entityMatch =
			(entityConfidenceByKey.get(`${candidate.type}:${candidate.id}`) ?? 0) *
			0.45 *
			rerankWeight
		const strongIdentityTerms = candidate.synthesizedProviderKey
			? strongIdentityTermsByProvider.get(candidate.synthesizedProviderKey)
			: undefined
		const matchesStrongSynthesizedIdentity =
			strongIdentityTerms != null &&
			scoreSemanticMatchedTerms(
				[
					...(candidate.identityFields ?? []),
					...(candidate.providerIdentityFields ?? []),
				],
				[...strongIdentityTerms],
			) > 0
		const synthesizedProviderAffinity =
			matchesStrongSynthesizedIdentity && !exactNonProviderEntityTarget
				? Math.min(
						maxSynthesizedProviderEntityAffinity,
						scoreSemanticMatchedTerms(
							[
								...candidate.searchFields,
								...(candidate.providerIdentityFields ?? []),
							],
							getSearchIdentityTerms(input.intent),
						) * maxSynthesizedProviderEntityAffinity,
					)
				: 0
		const packageProviderAffinity = findPackageProviderAffinity({
			candidate,
			candidates: input.candidates,
			strongIdentityTermsByProvider,
		})
		const providerEntityAffinity = Math.max(
			synthesizedProviderAffinity,
			packageProviderAffinity,
		)
		const taskSignals = scoreTaskAffinity(candidate, input.intent)
		const final =
			candidate.scoreComponents.base +
			entityMatch +
			providerEntityAffinity +
			taskSignals.actionMatch +
			taskSignals.taskAffinity +
			taskSignals.appAvailability +
			taskSignals.wrapperWorkflow +
			taskSignals.constraint

		return {
			...candidate,
			scoreComponents: {
				...candidate.scoreComponents,
				entityMatch,
				providerEntityAffinity,
				actionMatch: taskSignals.actionMatch,
				taskAffinity: taskSignals.taskAffinity,
				appAvailability: taskSignals.appAvailability,
				wrapperWorkflow: taskSignals.wrapperWorkflow,
				constraint: taskSignals.constraint,
				final,
			},
		}
	})

	return reranked
		.filter((candidate) => candidate.scoreComponents.final > 0)
		.sort((left, right) => {
			if (right.scoreComponents.final !== left.scoreComponents.final) {
				return right.scoreComponents.final - left.scoreComponents.final
			}
			return left.title.localeCompare(right.title)
		})
		.slice(0, input.limit)
}
