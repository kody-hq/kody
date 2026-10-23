import { expect, test } from 'vitest'
import {
	CAPABILITY_EMBEDDING_DIMENSIONS,
	deterministicEmbedding,
} from '#worker/vectorize/embedding.ts'
import { searchCapabilities } from './capability-search.ts'
import { type CapabilitySpec } from './types.ts'

function spec(name: string, description: string): CapabilitySpec {
	return {
		name,
		domain: 'meta',
		description,
		keywords: name.split('_'),
		readOnly: true,
		idempotent: true,
		destructive: false,
		orgPermission: 'none',
		source: 'builtin',
		inputFields: [],
		requiredInputFields: [],
		outputFields: [],
		inputSchema: { type: 'object', properties: {} },
		inputTypeDefinition: `type ${name}Input = Record<string, never>`,
	}
}

function onlineEnv(matches: Array<{ id: string; score: number }>) {
	const embeddedTexts: Array<string> = []
	const capturedFilters: Array<Record<string, unknown> | undefined> = []
	const capturedNamespaces: Array<string | undefined> = []
	const env = {
		SENTRY_ENVIRONMENT: 'production',
		AI: {
			async run(...args: Array<unknown>) {
				const input = args[1] as { text?: unknown }
				const texts = Array.isArray(input.text)
					? input.text.map(String)
					: [String(input.text ?? '')]
				embeddedTexts.push(...texts)
				return {
					data: texts.map((text) => deterministicEmbedding(text)),
					shape: [texts.length, CAPABILITY_EMBEDDING_DIMENSIONS],
				}
			},
		},
		CAPABILITY_VECTOR_INDEX: {
			async query(
				_values: Array<number>,
				options: { filter?: Record<string, unknown>; namespace?: string },
			) {
				capturedFilters.push(options.filter)
				capturedNamespaces.push(options.namespace)
				return { matches }
			},
		},
	} as unknown as Env
	return { env, embeddedTexts, capturedFilters, capturedNamespaces }
}

test('capability Vectorize stays builtin-scoped, query-embed-only, and lexical-only for misses', async () => {
	const query = 'oauth redirect uri provider registration'
	const specs = {
		capability_noise_a: spec('capability_noise_a', 'Unrelated helper'),
		oauth_redirect_helper: spec(
			'oauth_redirect_helper',
			'oauth redirect uri provider registration guide for configuring providers.',
		),
	}
	const { env, embeddedTexts, capturedFilters, capturedNamespaces } = onlineEnv(
		[
			{ id: 'package_pkg-1', score: 0.99 },
			{ id: 'capability_noise_a', score: 0.41 },
		],
	)
	const result = await searchCapabilities({
		env,
		query,
		limit: 3,
		detail: false,
		specs,
		vectorMetadataFilter: { domain: { $eq: 'meta' } },
	})
	expect(embeddedTexts).toEqual([query])
	expect(capturedFilters[0]).toMatchObject({
		domain: { $eq: 'meta' },
		kind: { $eq: 'builtin' },
	})
	expect(capturedNamespaces).toHaveLength(1)
	expect(result.matches.map((match) => match.name)).toContain(
		'oauth_redirect_helper',
	)
	expect(result.matches.map((match) => match.name)).not.toContain(
		'package_pkg-1',
	)

	const lexical = await searchCapabilities({
		env: onlineEnv([{ id: 'weak_vector_hit', score: 0.22 }]).env,
		query: 'check whether sonos speakers are playing status',
		limit: 2,
		detail: false,
		specs: {
			weak_vector_hit: spec('weak_vector_hit', 'barely related helper'),
			strong_lexical_only: spec(
				'strong_lexical_only',
				'sonos player status playing speakers check whether live playback state',
			),
		},
	})
	const lexicalOnly = lexical.matches.find(
		(match) => match.name === 'strong_lexical_only',
	)
	const vectorHit = lexical.matches.find(
		(match) => match.name === 'weak_vector_hit',
	)
	expect(lexicalOnly?.vectorRank).toBeUndefined()
	expect(lexicalOnly?.vectorScore).toBe(0)
	expect(lexicalOnly!.lexicalScore).toBeGreaterThan(vectorHit!.lexicalScore)
	expect(vectorHit?.vectorRank).toBe(1)
})

test('offline capability search returns matches without Vectorize', async () => {
	const env = {
		SENTRY_ENVIRONMENT: 'test',
		AI: {} as Ai,
	} as unknown as Env

	const oauthGuide = await searchCapabilities({
		env,
		query: 'oauth redirect uri provider registration',
		limit: 1,
		detail: false,
		specs: {
			oauth_setup_guide: spec(
				'oauth_setup_guide',
				'Guide for configuring OAuth redirect URIs.',
			),
		},
	})

	expect(oauthGuide.offline).toBe(true)
	expect(oauthGuide.matches.map((match) => match.name)).toEqual([
		'oauth_setup_guide',
	])
})
