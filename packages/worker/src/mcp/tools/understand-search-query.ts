import type { SearchEntityType } from './search-format-types.ts'

const searchTokenPattern = /[a-z0-9]+/g
const trivialSearchStopwords = new Set([
	'a',
	'an',
	'and',
	'for',
	'from',
	'i',
	'in',
	'into',
	'is',
	'me',
	'my',
	'of',
	'on',
	'or',
	'please',
	'the',
	'to',
	'with',
])

const taskLexicon = {
	operate: [
		'open',
		'play',
		'pause',
		'resume',
		'start',
		'stop',
		'run',
		'launch',
		'add',
		'create',
		'update',
		'schedule',
		'enable',
		'disable',
		'block',
		'unblock',
		'set',
		'turn',
		'skip',
		'queue',
		'volume',
		'remote',
	],
	setup: [
		'connect',
		'setup',
		'configure',
		'config',
		'oauth',
		'login',
		'auth',
		'authenticate',
		'secret',
		'token',
		'install',
	],
	inspect: [
		'list',
		'show',
		'status',
		'state',
		'details',
		'inspect',
		'view',
		'current',
		'latest',
		'summary',
		'check',
		'checking',
		'whether',
		'playing',
		'running',
		'paused',
		'connected',
		'disconnected',
	],
	learn: [
		'what',
		'how',
		'guide',
		'guides',
		'docs',
		'documentation',
		'explain',
		'usage',
		'schema',
	],
	debug: [
		'debug',
		'why',
		'error',
		'errors',
		'fail',
		'failed',
		'failing',
		'broken',
		'troubleshoot',
		'diagnose',
		'trace',
		'traces',
		'triage',
	],
} as const

const deviceConstraintTerms = new Set([
	'laptop',
	'computer',
	'desktop',
	'phone',
	'tablet',
	'browser',
	'tv',
	'app',
])

const stateConstraintTerms = new Set([
	'active',
	'paused',
	'playing',
	'running',
	'connected',
	'disconnected',
	'current',
	'latest',
])

export type SearchTask =
	| 'operate'
	| 'setup'
	| 'inspect'
	| 'learn'
	| 'debug'
	| 'unknown'

export type SearchConstraint = {
	kind: 'device' | 'state'
	value: string
}

export type SearchIntentAction = {
	name: SearchTask
	matchedTerms: Array<string>
	confidence: number
}

export type SearchIntentEntity = {
	type: SearchEntityType
	id: string
	title: string
	matchedTerms: Array<string>
	confidence: number
}

export type SearchIntent = {
	normalizedQuery: string
	tokens: Array<string>
	meaningfulTokens: Array<string>
	phrases: Array<string>
	task: {
		name: SearchTask
		confidence: number
	}
	actions: Array<SearchIntentAction>
	entities: Array<SearchIntentEntity>
	constraints: Array<SearchConstraint>
	confidence: number
}

export type SearchableEntityDescriptor = {
	type: SearchEntityType
	id: string
	title: string
	primaryAliases: Array<string>
	secondaryAliases?: Array<string>
	tertiaryAliases?: Array<string>
}

export function normalizeSearchText(text: string): string {
	return text
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/[_./:-]+/g, ' ')
		.toLowerCase()
}

export function extractSearchTokens(text: string): Array<string> {
	return normalizeSearchText(text).match(searchTokenPattern) ?? []
}

export function extractMeaningfulSearchTokens(text: string): Array<string> {
	const tokens = extractSearchTokens(text)
	const meaningful: Array<string> = []
	const seen = new Set<string>()
	for (const token of tokens) {
		if (token.length < 2) continue
		if (trivialSearchStopwords.has(token)) continue
		if (seen.has(token)) continue
		seen.add(token)
		meaningful.push(token)
	}
	return meaningful
}

export function buildSearchPhrases(
	tokens: ReadonlyArray<string>,
): Array<string> {
	if (tokens.length < 2) return []
	const phrases: Array<string> = []
	for (let index = 0; index < tokens.length - 1; index += 1) {
		const first = tokens[index]
		const second = tokens[index + 1]
		if (!first || !second) continue
		phrases.push(`${first} ${second}`)
	}
	return phrases
}

function collectMatchedTerms(
	queryTokens: ReadonlyArray<string>,
	phrases: ReadonlyArray<string>,
	fields: ReadonlyArray<string>,
) {
	const fieldTokens = new Set<string>()
	const normalizedFields = fields.map((field) => normalizeSearchText(field))
	for (const field of fields) {
		for (const token of extractSearchTokens(field)) {
			fieldTokens.add(token)
		}
	}

	const matchedTerms = queryTokens.filter((token) => fieldTokens.has(token))
	const matchedPhrases = phrases.filter((phrase) =>
		normalizedFields.some((field) => field.includes(phrase)),
	)

	return {
		matchedTerms,
		matchedPhrases,
	}
}

function scoreEntityDescriptor(
	descriptor: SearchableEntityDescriptor,
	queryTokens: ReadonlyArray<string>,
	phrases: ReadonlyArray<string>,
) {
	if (queryTokens.length === 0) {
		return {
			score: 0,
			matchedTerms: [] as Array<string>,
		}
	}

	const primary = collectMatchedTerms(
		queryTokens,
		phrases,
		descriptor.primaryAliases,
	)
	const secondary = collectMatchedTerms(
		queryTokens,
		phrases,
		descriptor.secondaryAliases ?? [],
	)
	const tertiary = collectMatchedTerms(
		queryTokens,
		phrases,
		descriptor.tertiaryAliases ?? [],
	)

	const primaryScore =
		primary.matchedTerms.length / Math.max(1, queryTokens.length) +
		primary.matchedPhrases.length * 0.2
	const secondaryScore =
		secondary.matchedTerms.length / Math.max(1, queryTokens.length) +
		secondary.matchedPhrases.length * 0.15
	const tertiaryScore =
		tertiary.matchedTerms.length / Math.max(1, queryTokens.length) +
		tertiary.matchedPhrases.length * 0.1

	const score = primaryScore * 0.75 + secondaryScore * 0.4 + tertiaryScore * 0.2
	const matchedTerms = Array.from(
		new Set([
			...primary.matchedTerms,
			...secondary.matchedTerms,
			...tertiary.matchedTerms,
		]),
	)

	return { score, matchedTerms }
}

function inferTaskSignals(
	meaningfulTokens: ReadonlyArray<string>,
	normalizedQuery: string,
) {
	const tokenSet = new Set(meaningfulTokens)
	const results = (
		Object.entries(taskLexicon) as Array<[SearchTask, ReadonlyArray<string>]>
	).map(([task, terms]) => {
		const matchedTerms = terms.filter(
			(term) =>
				tokenSet.has(term) ||
				(term.includes(' ') && normalizedQuery.includes(term)) ||
				(term === 'setup' && normalizedQuery.includes('set up')),
		)
		const setupBoost =
			terms.includes('setup') && normalizedQuery.includes('set up') ? 1 : 0
		const score =
			(matchedTerms.length + setupBoost) /
			Math.max(1, Math.min(3, meaningfulTokens.length))
		return {
			task,
			matchedTerms,
			score,
		}
	})

	results.sort((left, right) => right.score - left.score)
	const strongest = results[0]
	if (!strongest || strongest.score <= 0) {
		return {
			task: { name: 'unknown' as const, confidence: 0 },
			actions: [] as Array<SearchIntentAction>,
		}
	}

	const actions = results
		.filter((result) => result.score > 0)
		.map((result) => ({
			name: result.task,
			matchedTerms: result.matchedTerms,
			confidence: Math.min(1, result.score),
		}))

	// Prefer inspect over setup for package/note lookups.
	const inspectAction = actions.find((action) => action.name === 'inspect')
	const setupAction = actions.find((action) => action.name === 'setup')
	const packageOrientedTokens = meaningfulTokens.some((token) =>
		['note', 'notes', 'package', 'packages', 'readme', 'doc', 'docs'].includes(
			token,
		),
	)
	const prefersInspectOverSetup =
		packageOrientedTokens &&
		inspectAction != null &&
		setupAction != null &&
		inspectAction.matchedTerms.some((term) =>
			['show', 'list', 'view', 'inspect'].includes(term),
		)
	const task = prefersInspectOverSetup
		? {
				name: 'inspect' as const,
				confidence: Math.min(1, inspectAction.confidence),
			}
		: {
				name: strongest.task,
				confidence: Math.min(1, strongest.score),
			}

	return {
		task,
		actions,
	}
}

function inferConstraints(
	meaningfulTokens: ReadonlyArray<string>,
): Array<SearchConstraint> {
	const constraints: Array<SearchConstraint> = []
	for (const token of meaningfulTokens) {
		if (deviceConstraintTerms.has(token)) {
			constraints.push({ kind: 'device', value: token })
			continue
		}
		if (stateConstraintTerms.has(token)) {
			constraints.push({ kind: 'state', value: token })
		}
	}
	return constraints
}

export function understandSearchQuery(input: {
	query: string
	entities: Array<SearchableEntityDescriptor>
}): SearchIntent {
	const normalizedQuery = normalizeSearchText(input.query).trim()
	const tokens = extractSearchTokens(normalizedQuery)
	const meaningfulTokens = extractMeaningfulSearchTokens(normalizedQuery)
	const phrases = buildSearchPhrases(meaningfulTokens)
	const { task, actions } = inferTaskSignals(meaningfulTokens, normalizedQuery)
	const entities = input.entities
		.map((descriptor) => {
			const { score, matchedTerms } = scoreEntityDescriptor(
				descriptor,
				meaningfulTokens,
				phrases,
			)
			return {
				type: descriptor.type,
				id: descriptor.id,
				title: descriptor.title,
				matchedTerms,
				confidence: Math.min(1, score),
			} satisfies SearchIntentEntity
		})
		.filter((entity) => entity.confidence > 0.15)
		.sort((left, right) => right.confidence - left.confidence)
		.slice(0, 8)
	const constraints = inferConstraints(meaningfulTokens)
	const confidenceInputs = [
		task.confidence,
		entities[0]?.confidence ?? 0,
		actions[0]?.confidence ?? 0,
	]
	const confidence =
		confidenceInputs.reduce((sum, value) => sum + value, 0) /
		confidenceInputs.length

	return {
		normalizedQuery,
		tokens,
		meaningfulTokens,
		phrases,
		task,
		actions,
		entities,
		constraints,
		confidence,
	}
}
