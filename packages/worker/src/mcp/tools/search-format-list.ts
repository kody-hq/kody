import { isCapabilityAvailableViaApiTool } from '#worker/open-api/api-capability-surface.ts'

import {
	escapeMarkdownText,
	formatMarkdownInlineCode,
} from './markdown-safety.ts'
import {
	buildEntityRef,
	buildKodyCapabilityAccessor,
	buildPackageActionImportUsage,
	buildPackageListNextStep,
	formatOneLineSentence,
	getPrimaryPackageActionFunction,
} from './search-format-helpers.ts'
import { type SearchMatch } from './search-format-types.ts'

export function formatSearchMarkdown(input: {
	matches: Array<SearchMatch>
	warnings?: Array<string>
	warningCount?: number
	guidance?: string
	includePreamble?: boolean
}) {
	const lines: Array<string> = ['# Search results', '']
	const hasDomainMatch = input.matches.some((match) => match.type === 'domain')
	const hasEntityBackedMatch = input.matches.some(
		(match) => match.type !== 'domain',
	)
	if (hasDomainMatch) {
		lines.push(
			'Domain overview for a broad query. Search again with a more specific query, or list every capability in one domain with `search({ domain: "<name>" })`.',
			'',
		)
	}
	if ((input.includePreamble ?? true) && hasEntityBackedMatch) {
		lines.push(
			'For full detail on entity-backed hits, call `search` with `entity: "{type}:{id}"`.',
			'',
		)
	}

	if (input.matches.length === 0) {
		lines.push(
			'> **No matches.** Rephrase `query` or call `metaListCapabilities` for the full capability registry. `entity` looks up a known id — it does not improve an empty ranked list.',
		)
	} else {
		input.matches.forEach((match, index) => {
			lines.push(formatMatchListItem(match, index))
		})
	}

	const warnings = input.warnings ?? []
	if (warnings.length > 0) {
		lines.push('', '## Notices', '')
		for (const warning of warnings) {
			// Keep full notice text (URLs / onboarding links); structured carries
			// the same strings without truncation.
			lines.push(`- ${escapeMarkdownText(warning.replace(/\s+/g, ' ').trim())}`)
		}
	} else {
		const warningCount = input.warningCount ?? 0
		if (warningCount > 0) {
			lines.push('', `> ${String(warningCount)} search notice(s).`)
		}
	}

	if (input.guidance) {
		lines.push('', '## Recommended next step', '', input.guidance)
	}

	return lines.join('\n').trim()
}

/**
 * Domain overview lines stay shorter than regular hits so a full all-domain
 * map fits inside the default `maxResponseSize` without trimming.
 */
const domainOverviewDescriptionMaxLength = 110

function formatMatchedTermsNote(
	matchedTerms: ReadonlyArray<string> | undefined,
) {
	if (!matchedTerms || matchedTerms.length === 0) return ''
	return ` Matched: ${matchedTerms
		.map((term) => formatMarkdownInlineCode(term))
		.join(', ')}.`
}

function formatExportCallContractMarkdown(
	contract: NonNullable<
		Extract<SearchMatch, { type: 'package' }>['exportCallContract']
	>,
) {
	const lines: Array<string> = [
		`   Import: ${formatMarkdownInlineCode(contract.importSpecifier)}`,
	]
	const truncatedNote = contract.typeDefinitionTruncated
		? '; use entity detail for the full definition'
		: ''
	const typePart = contract.typeDefinition
		? ` — ${formatMarkdownInlineCode(contract.typeDefinition)}${truncatedNote}`
		: ''
	lines.push(`   ${formatMarkdownInlineCode(contract.usage)}${typePart}`)
	lines.push('   ```ts')
	for (const exampleLine of contract.executeExample.split('\n')) {
		lines.push(`   ${exampleLine}`)
	}
	lines.push('   ```')
	if (contract.functions.length > 1) {
		const functionSummary = contract.functions
			.map((fn) => {
				const description = fn.description
					? ` — ${escapeMarkdownText(formatOneLineSentence(fn.description))}`
					: ''
				return `${formatMarkdownInlineCode(fn.name)}${description}`
			})
			.join('; ')
		lines.push(`   Functions: ${functionSummary}`)
	}
	return lines.join('\n')
}

function formatMatchListItem(match: SearchMatch, index: number) {
	if (match.type === 'domain') {
		const sample =
			match.sampleCapabilities.length > 0
				? ` e.g. ${match.sampleCapabilities
						.map((name) => formatMarkdownInlineCode(name))
						.join(', ')}.`
				: ''
		return `${String(index + 1)}. **domain** ${formatMarkdownInlineCode(match.name)} (${String(match.capabilityCount)} ${match.capabilityCount === 1 ? 'capability' : 'capabilities'}) — ${escapeMarkdownText(formatOneLineSentence(match.description, domainOverviewDescriptionMaxLength))}${sample}`
	}
	if (match.type === 'mcp-server') {
		const entityRef = buildEntityRef(match.kodyName, 'mcp-server')
		const packageSuffix = match.wrappingPackage
			? ` Wrapping package: ${formatMarkdownInlineCode(match.wrappingPackage.name)} (Entity: ${formatMarkdownInlineCode(match.wrappingPackage.entityRef)}).`
			: ''
		const instructionsNote = match.instructions
			? ` Instructions: ${escapeMarkdownText(formatOneLineSentence(match.instructions, 200))}`
			: ''
		return `${String(index + 1)}. **mcp-server** ${escapeMarkdownText(match.title)} (${formatMarkdownInlineCode(match.domain)}, ${String(match.capabilityCount)} tools) — ${escapeMarkdownText(formatOneLineSentence(match.description))} Entity: ${formatMarkdownInlineCode(entityRef)}.${instructionsNote} List tools with \`search({ entity: ${JSON.stringify(entityRef)} })\`. Call via ${formatMarkdownInlineCode(match.usage)}.${packageSuffix}`
	}
	if (match.type === 'capability') {
		const entityRef = buildEntityRef(match.name, 'capability')
		const apiNote = isCapabilityAvailableViaApiTool(match.name)
			? ''
			: '. Execute-only (not on Open API / MCP `api`)'
		const mainLine = `${String(index + 1)}. **capability** ${formatMarkdownInlineCode(match.title ?? match.name)} (${formatMarkdownInlineCode(match.domain)}) — ${escapeMarkdownText(formatOneLineSentence(match.description))} Entity: ${formatMarkdownInlineCode(entityRef)}${apiNote}`
		if (!match.inputTypeDefinition) {
			return mainLine
		}
		const accessor = buildKodyCapabilityAccessor(match)
		const truncatedNote = match.inputTypeDefinitionTruncated
			? '; use entity detail for the full definition'
			: ''
		return `${mainLine}\n   ${formatMarkdownInlineCode(`${accessor}(params)`)} — ${formatMarkdownInlineCode(match.inputTypeDefinition)}${truncatedNote}`
	}
	if (match.type === 'guide') {
		const entityRef = buildEntityRef(match.id, 'guide')
		return `${String(index + 1)}. **guide** ${escapeMarkdownText(match.title)} — ${escapeMarkdownText(formatOneLineSentence(match.description))} Entity: ${formatMarkdownInlineCode(entityRef)}`
	}
	if (match.type === 'package') {
		const entityRef = buildEntityRef(
			match.kodyId,
			'package',
			match.exportSubpath,
		)
		const [actionMatch] = match.actionMatches ?? []
		const actionFunction = actionMatch
			? getPrimaryPackageActionFunction(actionMatch)
			: null
		const exportLabel = match.exportSubpath
			? ` export ${formatMarkdownInlineCode(match.exportSubpath)}`
			: ''
		const matchedNote = formatMatchedTermsNote(actionMatch?.matchedTerms)
		const actionSummary =
			actionMatch && actionFunction
				? match.exportSubpath
					? ` Use ${formatMarkdownInlineCode(buildPackageActionImportUsage({ packageName: match.name, subpath: actionMatch.subpath, functionName: actionFunction.name }))}${actionFunction.description ? ` — ${escapeMarkdownText(formatOneLineSentence(actionFunction.description))}` : ''}${matchedNote}`
					: ` Best action: ${formatMarkdownInlineCode(actionFunction.name)} via ${formatMarkdownInlineCode(buildPackageActionImportUsage({ packageName: match.name, subpath: actionMatch.subpath, functionName: actionFunction.name }))}${actionFunction.description ? ` — ${escapeMarkdownText(formatOneLineSentence(actionFunction.description))}` : ''}${matchedNote}`
				: matchedNote
		const listingAheadNote =
			match.listingAhead === true
				? ' Listing ahead — origin has new commits; communityGet then repoPublishSession with absorbed_upstream_commit.'
				: ''
		const mainLine = `${String(index + 1)}. **package** ${escapeMarkdownText(match.title)} (${formatMarkdownInlineCode(match.kodyId)}${exportLabel}) — ${escapeMarkdownText(formatOneLineSentence(match.description))} Entity: ${formatMarkdownInlineCode(entityRef)}${actionSummary}${listingAheadNote}`
		const nextStepLine = `   Next: ${buildPackageListNextStep(match)}`
		if (!match.exportCallContract) {
			return `${mainLine}\n${nextStepLine}`
		}
		return `${mainLine}\n${formatExportCallContractMarkdown(match.exportCallContract)}\n${nextStepLine}`
	}
	if (match.type === 'integration') {
		const entityRef = buildEntityRef(match.integrationName, 'integration')
		const trouble = match.lastAuthFailure?.reconnectable
			? ` ${escapeMarkdownText(match.lastAuthFailure.why)} ${escapeMarkdownText(match.lastAuthFailure.doLabel)} at ${formatMarkdownInlineCode(match.lastAuthFailure.reconnectHref)}.`
			: ''
		return `${String(index + 1)}. **integration** ${formatMarkdownInlineCode(match.integrationName)} — ${escapeMarkdownText(formatOneLineSentence(match.description))} Entity: ${formatMarkdownInlineCode(entityRef)}${trouble}`
	}
	const entityRef = buildEntityRef(match.name, 'secret')
	return `${String(index + 1)}. **secret** ${formatMarkdownInlineCode(match.name)} — ${escapeMarkdownText(formatOneLineSentence(match.description))} Entity: ${formatMarkdownInlineCode(entityRef)}`
}
