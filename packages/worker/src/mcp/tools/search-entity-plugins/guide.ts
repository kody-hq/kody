import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { guideMetadataList } from '#worker/guide-catalog-modules.ts'
import { resolveMarkdownDocument } from '#worker/guides/document-sections.ts'
import { type GuideMetadata } from '#worker/guides/guide-types.ts'
import { formatRequestedLineLabel } from '#worker/guides/line-anchor.ts'
import { lexicalScore } from '#worker/vectorize/scoring.ts'

import { type SearchEntityPlugin } from '../search-entity-plugin.ts'
import { maxChars } from '../search-constants.ts'
import {
	buildGuideDetailHeaderLines,
	guideContentsModeLine,
	guideLinesModeLine,
	guideSearchBodyBudget,
	guideSectionModeLine,
} from '../guide-search-budget.ts'
import { buildEntityRef, buildGuideUsage } from '../search-format-helpers.ts'
import { buildCandidateBaseScore } from '../search-scoring.ts'
import {
	buildSearchPhrases,
	extractMeaningfulSearchTokens,
	extractSearchTokens,
	normalizeSearchText,
} from '../understand-search-query.ts'

const advertisedPublicGuides = guideMetadataList.filter(
	(guide) => !guide.unadvertised && !guide.adminOnly,
)

function searchableGuides(includeAdmin: boolean) {
	if (includeAdmin) {
		return guideMetadataList.filter((guide) => !guide.unadvertised)
	}
	return advertisedPublicGuides
}

function guideBelongsInDomain(domain: string | undefined) {
	return domain == null || domain === capabilityDomainNames.coding
}

function guideSearchText(guide: GuideMetadata) {
	return [guide.id, guide.slug, guide.title, guide.provider]
		.filter((value): value is string => Boolean(value))
		.join('\n')
}

const guideDiscoveryNoise = new Set([
	'guide',
	'guides',
	'docs',
	'documentation',
	'official',
])

function phraseHasMultipleTokens(phrase: string) {
	return extractSearchTokens(phrase).length >= 2
}

function guideQueryTokens(query: string) {
	return extractMeaningfulSearchTokens(query).filter(
		(token) => !guideDiscoveryNoise.has(token),
	)
}

function identityTokensCoveredByQuery(
	identityPhrase: string,
	queryTokens: ReadonlyArray<string>,
) {
	const identityTokens = guideQueryTokens(identityPhrase)
	if (identityTokens.length < 2) return false
	return identityTokens.every((token) => queryTokens.includes(token))
}

/**
 * A multi-word query that names the guide's topic and appears as a phrase in
 * its summary, e.g. "executor credential" for the credentials guide.
 */
function queryNarrowsGuideBySummary(
	tokens: ReadonlyArray<string>,
	identity: string,
	summary: string,
) {
	if (tokens.length < 2) return false
	// Tokenize the summary like the query so stopwords drop out of both.
	const summaryText = ` ${extractSearchTokens(summary)
		.filter((token) => guideQueryTokens(token).length > 0)
		.join(' ')} `
	return (
		tokens.some((token) => identity.includes(token)) &&
		summaryText.includes(` ${tokens.join(' ')} `)
	)
}

function guideHasStrongQueryMatch(query: string, guide: GuideMetadata) {
	const identity = normalizeSearchText(guideSearchText(guide))
	const tokens = guideQueryTokens(query)
	if (tokens.length === 0) return false
	const focusedQuery = tokens.join(' ')
	if (identity.includes(focusedQuery)) return true
	const idPhrase = normalizeSearchText(guide.id)
	const slugPhrase = normalizeSearchText(guide.slug)
	if (phraseHasMultipleTokens(idPhrase) && focusedQuery.includes(idPhrase)) {
		return true
	}
	if (
		phraseHasMultipleTokens(slugPhrase) &&
		focusedQuery.includes(slugPhrase)
	) {
		return true
	}
	if (identityTokensCoveredByQuery(idPhrase, tokens)) return true
	if (identityTokensCoveredByQuery(slugPhrase, tokens)) return true
	if (queryNarrowsGuideBySummary(tokens, identity, guide.summary)) return true
	if (tokens.length === 1) {
		return extractSearchTokens(identity).includes(tokens[0] ?? '')
	}
	return buildSearchPhrases(tokens).some((phrase) => identity.includes(phrase))
}

export const guideSearchEntityPlugin = {
	type: 'guide',
	buildDescriptors(input) {
		if (!guideBelongsInDomain(input.domain)) return []
		return searchableGuides(input.includeAdminGuides === true).map((guide) => ({
			type: 'guide' as const,
			id: guide.id,
			title: guide.title,
			primaryAliases: [guide.id, guide.slug, guide.title],
			secondaryAliases: [
				guide.summary,
				...(guide.provider ? [guide.provider] : []),
				'official guide',
			],
		}))
	},
	buildCandidates(input) {
		if (!guideBelongsInDomain(input.domain)) return []
		return searchableGuides(input.includeAdminGuides === true)
			.filter((guide) => guideHasStrongQueryMatch(input.query, guide))
			.map((guide) => {
				// A summary-phrase match has no identity overlap to score.
				const lexical =
					lexicalScore(input.query, guideSearchText(guide)) ||
					lexicalScore(input.query, guide.summary)
				return {
					match: {
						type: 'guide' as const,
						id: guide.id,
						title: guide.title,
						description: guide.summary,
						category: guide.category,
						slug: guide.slug,
						provider: guide.provider,
					},
					type: 'guide' as const,
					id: guide.id,
					title: guide.title,
					searchFields: [
						guide.id,
						guide.slug,
						guide.title,
						...(guide.provider ? [guide.provider] : []),
					],
					identityFields: [guide.id, guide.slug],
					scoreComponents: buildCandidateBaseScore({
						lexical,
					}),
				}
			})
			.filter((candidate) => candidate.scoreComponents.base > 0)
	},
	formatSlimMatch({ match }) {
		return {
			type: 'guide',
			id: match.id,
			entityRef: buildEntityRef(match.id, 'guide'),
			title: match.title,
			description: match.description,
			usage: buildGuideUsage(match.id),
			category: match.category,
			slug: match.slug,
			provider: match.provider,
		}
	},
	formatEntityDetail(detail) {
		const entityRef = buildEntityRef(detail.id, 'guide')
		const headerLines = buildGuideDetailHeaderLines(detail)
		let resolved
		try {
			resolved = resolveMarkdownDocument({
				markdown: detail.body,
				maxChars: guideSearchBodyBudget({
					...detail,
					maxChars,
				}),
				entityRef,
				...(detail.section ? { section: detail.section } : {}),
			})
		} catch (error) {
			throw new McpCallerError(
				error instanceof Error ? error.message : String(error),
				{ cause: error },
			)
		}
		const lineLabel = resolved.lines
			? formatRequestedLineLabel(resolved.lines)
			: null
		const selectedRef = lineLabel
			? buildEntityRef(detail.id, 'guide', lineLabel)
			: resolved.selected
				? buildEntityRef(detail.id, 'guide', resolved.selected.slug)
				: entityRef
		const modeLines = guideDetailModeLines(resolved)
		const bodyLines = [...headerLines, ...modeLines, '', resolved.markdown]
		return {
			markdown: bodyLines.join('\n'),
			structured: {
				kind: 'entity',
				type: 'guide',
				id: detail.id,
				entityRef: selectedRef,
				title: detail.title,
				description: detail.description,
				usage: resolved.selected
					? `search({ entity: ${JSON.stringify(selectedRef)} })`
					: buildGuideUsage(detail.id),
				category: detail.category,
				slug: detail.slug,
				body: resolved.markdown,
				bodyMode: resolved.mode,
				section: resolved.selected
					? {
							title: resolved.selected.title,
							slug: resolved.selected.slug,
						}
					: null,
				lines: resolved.lines,
				sections: resolved.headings
					.filter((heading) => heading.level >= 2)
					.map((heading) => ({
						title: heading.title,
						slug: heading.slug,
						level: heading.level,
						entityRef: buildEntityRef(detail.id, 'guide', heading.slug),
					})),
				provider: detail.provider,
				lastVerified: detail.lastVerified,
			},
		}
	},
} satisfies SearchEntityPlugin<'guide'>

function guideDetailModeLines(resolved: {
	mode: 'full' | 'toc' | 'section' | 'lines'
	selected: { slug: string } | null
	lines: { requestedStartLine: number; requestedEndLine: number } | null
}) {
	switch (resolved.mode) {
		case 'full':
			return []
		case 'toc':
			return [guideContentsModeLine]
		case 'section':
			return resolved.selected
				? [guideSectionModeLine(resolved.selected.slug)]
				: []
		case 'lines':
			return resolved.lines
				? [guideLinesModeLine(formatRequestedLineLabel(resolved.lines))]
				: []
		default: {
			const exhaustive: never = resolved.mode
			throw new Error(`Unsupported guide detail mode: ${exhaustive}`)
		}
	}
}
