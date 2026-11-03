/**
 * Inline package-export call contracts on high-confidence top ranked hits.
 *
 * Mirrors capability `attachTopCapabilityCallShapes`: agents get import path
 * + signature/types (same substance as `entity: package:{id}#{subpath}`)
 * without a second round-trip when the top hit is clearly the right export.
 * Ambiguous top-2 / weak scores stay skinny and point at entity detail.
 */

import { buildPackageImportSpecifier } from '#worker/package-registry/package-import-specifier.ts'

import {
	exportCallContractMinJevMeanConfidence,
	exportCallContractMinScoreGap,
	exportCallContractMinTopScore,
	inlineExportCallContractTypeMaxLength,
} from './search-constants.ts'
import {
	buildPackageActionImportUsage,
	compactCapabilityInputTypeDefinition,
	getPrimaryPackageActionFunction,
} from './search-format-helpers.ts'
import type {
	JevSearchRerankOutcome,
	SearchMatch,
} from './search-format-types.ts'
import type { SearchCandidate } from './search-types.ts'

function isDefaultExportName(name: string) {
	return name === 'default' || name === 'home'
}

function buildExportExecuteExample(input: {
	packageName: string
	subpath: string
	functions: ReadonlyArray<{ name: string }>
}): string {
	const importSpecifier = buildPackageImportSpecifier(
		input.packageName,
		input.subpath,
	)
	const primary = getPrimaryPackageActionFunction({
		functions: input.functions,
	})
	if (!primary) {
		return `import * as exported from ${JSON.stringify(importSpecifier)}

export default async function main() {
	return exported
}`
	}
	const isDefaultImport = isDefaultExportName(primary.name)
	const localName = isDefaultImport ? 'action' : primary.name
	const importLine = isDefaultImport
		? `import ${localName} from ${JSON.stringify(importSpecifier)}`
		: `import { ${localName} } from ${JSON.stringify(importSpecifier)}`
	return `${importLine}

export default async function main(params) {
	return await ${localName}(params)
}`
}

/**
 * Score for a post-collapse match from the ranked candidate list that
 * produced it. Collapse can drop/replace leading synthesized MCP tools, so
 * index 0 of the candidate list is not always `matches[0]`.
 */
function finalScoreForMatch(
	rankedCandidates: ReadonlyArray<SearchCandidate>,
	match: SearchMatch | undefined,
): number | null {
	if (!match) return null
	const candidate = rankedCandidates.find((entry) => entry.match === match)
	return candidate?.scoreComponents.final ?? null
}

/**
 * Whether the top ranked hit should carry an inlined export call contract.
 *
 * Uses post-Jev meanConfidence when Jev applied; otherwise score gap and
 * top-1 floor from the candidates that correspond to the post-collapse
 * matches (not pre-collapse index 0/1). Ambiguous top-2 never inlines.
 */
export function shouldInlineExportCallContract(input: {
	matches: ReadonlyArray<SearchMatch>
	rankedCandidates: ReadonlyArray<SearchCandidate>
	jevOutcome: JevSearchRerankOutcome
	jevMeanConfidence: number | null
}): boolean {
	const [topMatch, secondMatch] = input.matches
	if (topMatch?.type !== 'package' || !topMatch.exportSubpath) return false
	const [actionMatch] = topMatch.actionMatches ?? []
	if (!actionMatch) return false

	if (input.jevOutcome === 'applied') {
		const mean = input.jevMeanConfidence
		if (mean == null || mean < exportCallContractMinJevMeanConfidence) {
			return false
		}
		// Same-package rival export in slot 2 → keep skinny; entity for detail.
		if (
			secondMatch?.type === 'package' &&
			secondMatch.exportSubpath &&
			secondMatch.kodyId === topMatch.kodyId
		) {
			return false
		}
		return true
	}

	const topScore = finalScoreForMatch(input.rankedCandidates, topMatch)
	if (topScore == null || topScore < exportCallContractMinTopScore) {
		return false
	}
	const secondScore = finalScoreForMatch(input.rankedCandidates, secondMatch)
	if (secondScore == null) return true
	return topScore - secondScore >= exportCallContractMinScoreGap
}

/**
 * Attach a compact export call contract to the top match when confidence
 * is high. Mutates `matches[0]` in place (same pattern as capability shapes).
 */
export function attachHighConfidenceExportCallContract(input: {
	matches: Array<SearchMatch>
	rankedCandidates: ReadonlyArray<SearchCandidate>
	jevOutcome: JevSearchRerankOutcome
	jevMeanConfidence: number | null
}): void {
	if (!shouldInlineExportCallContract(input)) return
	const topMatch = input.matches[0]
	if (topMatch?.type !== 'package' || !topMatch.exportSubpath) return
	const [actionMatch] = topMatch.actionMatches ?? []
	if (!actionMatch) return

	const importSpecifier = buildPackageImportSpecifier(
		topMatch.name,
		actionMatch.subpath,
	)
	const primary = getPrimaryPackageActionFunction(actionMatch)
	const usage = primary
		? buildPackageActionImportUsage({
				packageName: topMatch.name,
				subpath: actionMatch.subpath,
				functionName: primary.name,
			})
		: `import * as exported from ${JSON.stringify(importSpecifier)}`
	const rawType =
		actionMatch.typeDefinition ??
		primary?.typeDefinition ??
		actionMatch.functions.map((fn) => fn.typeDefinition).find(Boolean) ??
		null
	let typeDefinition: string | null = null
	let typeDefinitionTruncated = false
	if (rawType) {
		const compact = compactCapabilityInputTypeDefinition(rawType, {
			maxLength: inlineExportCallContractTypeMaxLength,
		})
		typeDefinition = compact.definition
		typeDefinitionTruncated = compact.truncated
	}
	topMatch.exportCallContract = {
		importSpecifier,
		usage,
		executeExample: buildExportExecuteExample({
			packageName: topMatch.name,
			subpath: actionMatch.subpath,
			functions: actionMatch.functions,
		}),
		typeDefinition,
		...(typeDefinitionTruncated ? { typeDefinitionTruncated: true } : {}),
		functions: actionMatch.functions.map((fn) => ({
			name: fn.name,
			description: fn.description,
			typeDefinition: fn.typeDefinition
				? compactCapabilityInputTypeDefinition(fn.typeDefinition, {
						maxLength: inlineExportCallContractTypeMaxLength,
					}).definition
				: null,
		})),
	}
}
