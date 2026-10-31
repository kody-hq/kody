import { type CapabilitySpec } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { buildKodyCapabilityAccessor } from '#mcp/kody-capability-accessors.ts'
import { listingAheadSearchNotice } from '#universal/community-listing-ahead.ts'
import { buildPackageImportSpecifier } from '#worker/package-registry/package-import-specifier.ts'
import { type PackageJobSchedule } from '#worker/package-registry/types.ts'
import { resolveHostedPackageAppUrl } from '@kody-internal/shared/public-urls.ts'

import {
	searchEntityRefTypes,
	type SearchEntityType,
	type SearchMatch,
} from './search-format-types.ts'

export { buildKodyCapabilityAccessor } from '#mcp/kody-capability-accessors.ts'

export function buildPackageHostedUrl(input: {
	packageAppBaseUrl: string | null
	appBaseUrl: string
	username: string
	kodyId: string
}) {
	return resolveHostedPackageAppUrl(input)
}

export function buildEntityRef(
	id: string,
	type: SearchEntityType,
	section?: string,
) {
	const ref = `${type}:${id}`
	return section ? `${ref}#${section}` : ref
}

export function buildCapabilityUsage(spec: {
	name: string
	source?: CapabilitySpec['source']
	mcpServer?: CapabilitySpec['mcpServer']
}) {
	return `execute with ${buildKodyCapabilityAccessor(spec)}(params)`
}

export const inlineCapabilityInputTypeMaxLength = 500

export function compactCapabilityInputTypeDefinition(
	inputTypeDefinition: string,
	options: {
		maxLength?: number
		requiredInputFields?: ReadonlyArray<string>
	} = {},
): { definition: string; truncated: boolean } {
	const maxLength = options.maxLength ?? inlineCapabilityInputTypeMaxLength
	const collapsed = formatInlineTypeDefinition(inputTypeDefinition)
	if (collapsed.length <= maxLength) {
		return { definition: collapsed, truncated: false }
	}
	const requiredFields = options.requiredInputFields ?? []
	const requiredFieldsMarker =
		requiredFields.length > 0
			? ` /* required fields: ${requiredFields.join(', ')} */`
			: ''
	const suffix = `...${requiredFieldsMarker}`
	const prefixLength = Math.max(0, maxLength - suffix.length)
	return {
		definition: `${collapsed.slice(0, prefixLength).trimEnd()}${suffix}`,
		truncated: true,
	}
}

export function buildPackageMaintainSnippets(packageId: string) {
	return {
		gitLane: `packageGetGitRemote({ package_id: ${JSON.stringify(packageId)} })`,
		publish: `packagePublishExternalPush({ package_id: ${JSON.stringify(packageId)} })`,
		sourceSession: `repoOpenSession({ target: { kind: "package", package_id: ${JSON.stringify(packageId)} } })`,
	}
}

export function buildPackageSourceFollowUp(input: {
	packageId: string
	kodyId: string
}) {
	const headingCall = `search({ entity: ${JSON.stringify(`package:${input.kodyId}#<subpath>`)} })`
	const packageGetCall = `packageGet({ package_id: ${JSON.stringify(input.packageId)} })`
	const sessionCall = `repoOpenSession({ target: { kind: "package", package_id: ${JSON.stringify(input.packageId)} } })`
	const gitLaneCall = `packageGetGitRemote({ package_id: ${JSON.stringify(input.packageId)} })`
	const fileCall = `search({ entity: ${JSON.stringify(`package:${input.kodyId}#README.md`)} })`
	return `Open one export with ${headingCall} for its import specifier, types, and execute snippet. ${packageGetCall} returns the full export array plus package-scoped secret metadata. That call does not return files. For one file, ${fileCall} (append #L165, #L165-L180, or a heading slug such as #export-jsdoc). A fragment that matches an export subpath still opens that export. For the tree, open a repo session with ${sessionCall} then repoReadFile({ session_id, path: "README.md" }) (the same # fragments work on path; browse other files with repoTree). Discard the session with repoDiscardSession when finished. If you have a local git client, call ${gitLaneCall} instead and clone. search({ entity: "guide:package_authoring" }) covers inbound webhooks and maintenance workflows.`
}

export function buildCapabilityExecuteExample(spec: CapabilitySpec) {
	return `import { kody } from 'kody:runtime'

export default async function main(params) {
\treturn await ${buildKodyCapabilityAccessor(spec)}(params)
}`
}

export function buildPackageRootImportUsage(packageName: string) {
	return `import entry from ${JSON.stringify(buildPackageImportSpecifier(packageName, '.'))}`
}

export function buildPackageActionImportUsage(input: {
	packageName: string
	subpath: string
	functionName: string
}) {
	const importSpecifier = buildPackageImportSpecifier(
		input.packageName,
		input.subpath,
	)
	if (input.functionName === 'home' || input.functionName === 'default') {
		return `import action from ${JSON.stringify(importSpecifier)}`
	}
	return `import { ${input.functionName} } from ${JSON.stringify(importSpecifier)}`
}

export function getPrimaryPackageActionFunction<
	FunctionShape extends { name: string },
>(actionMatch: { functions: ReadonlyArray<FunctionShape> }) {
	return (
		actionMatch.functions.find((fn) => fn.name !== 'home') ??
		actionMatch.functions[0] ??
		null
	)
}

/**
 * Shared next-step copy for package list hits. Used by slim structured
 * matches and list markdown so content-preferring and structured-preferring
 * MCP hosts see the same guidance.
 */
export function buildPackageListNextStep(
	match: Extract<SearchMatch, { type: 'package' }>,
): string {
	const exportSubpath = match.exportSubpath
	const [actionMatch] = match.actionMatches ?? []
	const actionFunction = actionMatch
		? getPrimaryPackageActionFunction(actionMatch)
		: null
	const primaryUsage =
		actionMatch && actionFunction
			? buildPackageActionImportUsage({
					packageName: match.name,
					subpath: actionMatch.subpath,
					functionName: actionFunction.name,
				})
			: null
	const listingAheadSuffix =
		match.listingAhead === true ? ` ${listingAheadSearchNotice}` : ''
	const entityRef = buildEntityRef(match.kodyId, 'package', exportSubpath)
	if (exportSubpath) {
		if (match.exportCallContract) {
			return `Use the inlined export call contract above from \`execute\`. Inspect search({ entity: ${JSON.stringify(entityRef)} }) only if you need referenced types or the full package.${listingAheadSuffix}`
		}
		if (primaryUsage) {
			return `Use ${primaryUsage}; inspect search({ entity: ${JSON.stringify(entityRef)} }) only if you need the full export contract.${listingAheadSuffix}`
		}
		return `Inspect the export contract with search({ entity: ${JSON.stringify(entityRef)} }).${listingAheadSuffix}`
	}
	if (primaryUsage) {
		return `Use ${primaryUsage}; inspect search({ entity: "package:${match.kodyId}" }) only if you need more exports.${listingAheadSuffix}`
	}
	if (match.hasApp) {
		return `Inspect package detail with search({ entity: "package:${match.kodyId}" }) to review exports, jobs, and the hosted app URL.${listingAheadSuffix}`
	}
	return `Inspect package detail with search({ entity: "package:${match.kodyId}" }) to review exports, then import the needed entry from "${buildPackageImportSpecifier(match.name, '.')}".${listingAheadSuffix}`
}

export function formatInlineTypeDefinition(typeDefinition: string) {
	return typeDefinition.replace(/\s+/g, ' ').trim()
}

export function buildIntegrationUsage(name: string) {
	return `kody.integrationGet({ name: ${JSON.stringify(name)} })`
}

export function buildSecretUsage(name: string) {
	return /^[a-zA-Z0-9._-]+$/.test(name)
		? `{{secret:${name}|scope=user}}`
		: '(secret placeholder unavailable for this name)'
}

export function buildGuideUsage(id: string) {
	return `search({ entity: ${JSON.stringify(buildEntityRef(id, 'guide'))} })`
}

export function formatSearchEntityRefTypeList() {
	const types = [...searchEntityRefTypes]
	if (types.length <= 1) return types[0] ?? ''
	return `${types.slice(0, -1).join(', ')}, or ${types[types.length - 1]}`
}

function isSearchEntityRefType(type: string): type is SearchEntityType {
	return (searchEntityRefTypes as ReadonlyArray<string>).includes(type)
}

function decodeEntitySection(raw: string) {
	const trimmed = raw.trim()
	if (!trimmed) return undefined
	try {
		return decodeURIComponent(trimmed).trim() || undefined
	} catch {
		return trimmed
	}
}

function formatOneLineSummary(value: string, maxLength = 180) {
	const summary = value.replace(/\s+/g, ' ').trim()
	if (summary.length <= maxLength) return summary
	return `${summary.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
}

export function formatOneLineSentence(value: string, maxLength?: number) {
	const summary = formatOneLineSummary(value, maxLength)
	if (!summary) return 'No description.'
	return /[.!?]$/.test(summary) ? summary : `${summary}.`
}

export function formatPackageSchedule(
	schedule: PackageJobSchedule,
	timezone?: string,
) {
	if (schedule.type === 'cron') {
		return `Runs on cron "${schedule.expression}" in ${timezone?.trim() || 'UTC'}`
	}
	return `Runs every ${schedule.every}`
}

export function parseEntityRef(entity: string): {
	id: string
	type: SearchEntityType
	section?: string
} {
	const trimmed = entity.trim()
	const hash = trimmed.indexOf('#')
	const hasSectionFragment = hash >= 0
	const section = hasSectionFragment
		? decodeEntitySection(trimmed.slice(hash + 1))
		: undefined
	const withoutSection = hasSectionFragment ? trimmed.slice(0, hash) : trimmed
	const firstColon = withoutSection.indexOf(':')
	if (firstColon <= 0 || firstColon === withoutSection.length - 1) {
		throw new McpCallerError(
			`Entity must use the format "{type}:{id}" where type is ${formatSearchEntityRefTypeList()}.`,
		)
	}
	const firstSegment = withoutSection.slice(0, firstColon).trim()
	const rest = withoutSection.slice(firstColon + 1).trim()
	if (isSearchEntityRefType(firstSegment)) {
		if (!rest) {
			throw new McpCallerError('Entity id must not be empty.')
		}
		if (hasSectionFragment && !section) {
			throw new McpCallerError(
				'Section fragment after "{type}:{id}#" must not be empty.',
			)
		}
		return section
			? { id: rest, type: firstSegment, section }
			: { id: rest, type: firstSegment }
	}
	throw new McpCallerError(
		`Entity type must be one of: ${formatSearchEntityRefTypeList()}.`,
	)
}

export function formatList(items: Array<string>) {
	if (items.length === 0) return 'none'
	return items.map((item) => `\`${item}\``).join(', ')
}

export function formatTtlMs(ttlMs: number | null) {
	if (ttlMs == null) return 'none'
	return `\`${ttlMs.toLocaleString()}\``
}
