import { McpCallerError } from '#mcp/caller-error.ts'
import type { PackageExportProjection } from '#worker/package-registry/manifest.ts'
import { buildPackageImportSpecifier } from '#worker/package-registry/package-import-specifier.ts'

import { maxChars } from './search-constants.ts'
import { formatMarkdownInlineCode } from './markdown-safety.ts'
import type { SearchEntityDetailFormatResult } from './search-entity-plugin.ts'
import {
	buildEntityRef,
	getPrimaryPackageActionFunction,
} from './search-format-helpers.ts'
import type { SearchEntityDetail } from './search-format-types.ts'

const packageExportReferencedTypesOmittedLine =
	'Referenced type definitions omitted (exceeds search response budget). `packageGet` returns the full export array.'

function normalizePackageExportFragment(section: string) {
	const trimmed = section.trim()
	if (trimmed === '.' || trimmed === './') return '.'
	return trimmed.replace(/^\.\//, '')
}

export function findPackageExportByFragment<
	ExportShape extends { subpath: string },
>(exports: ReadonlyArray<ExportShape>, section: string) {
	const requested = normalizePackageExportFragment(section)
	if (!requested) return null
	return (
		exports.find(
			(item) => normalizePackageExportFragment(item.subpath) === requested,
		) ?? null
	)
}

export function formatUnknownPackageExportError(input: {
	entityRef: string
	section: string
	exports: ReadonlyArray<{ subpath: string }>
}) {
	const available = input.exports
		.map((item) => item.subpath)
		.filter((subpath) => subpath.trim().length > 0)
		.join(', ')
	return `Unknown export ${JSON.stringify(input.section)} for ${input.entityRef}. Available: ${available || 'none'}.`
}

function splitPackageExportJsDoc(jsDoc: string | null | undefined): {
	purpose: string | null
	example: string | null
} {
	if (!jsDoc?.trim()) return { purpose: null, example: null }
	const purposeLines: Array<string> = []
	const exampleLines: Array<string> = []
	let currentTag: string | null = null
	for (const line of jsDoc.replace(/\r\n/g, '\n').split('\n')) {
		const tagMatch = line.trim().match(/^@([a-zA-Z][\w-]*)\b/)
		if (tagMatch) {
			currentTag = tagMatch[1] ?? null
			if (currentTag === 'example') {
				const rest = line
					.trim()
					.replace(/^@example\b/, '')
					.trim()
				if (rest) exampleLines.push(rest)
			}
			continue
		}
		if (currentTag === 'example') {
			exampleLines.push(line)
			continue
		}
		if (currentTag == null) {
			purposeLines.push(line)
		}
	}
	return {
		purpose: purposeLines.join('\n').trim() || null,
		example: exampleLines.join('\n').trim() || null,
	}
}

function buildPackageExportExecuteExample(input: {
	packageName: string
	subpath: string
	functions: ReadonlyArray<{ name: string }>
}) {
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
	const isDefaultImport = primary.name === 'default' || primary.name === 'home'
	const localName = isDefaultImport ? 'action' : primary.name
	const importLine = isDefaultImport
		? `import ${localName} from ${JSON.stringify(importSpecifier)}`
		: `import { ${localName} } from ${JSON.stringify(importSpecifier)}`
	return `${importLine}

export default async function main(params) {
	return await ${localName}(params)
}`
}

function buildPackageExportFollowUp(input: { packageId: string }) {
	const packageGetCall = `packageGet({ package_id: ${JSON.stringify(input.packageId)} })`
	return `${packageGetCall} returns the full export array plus package-scoped secret metadata. That call does not return files.`
}

function isDefaultExportName(name: string) {
	return name === 'default' || name === 'home'
}

function referencedTypeLine(type: {
	name: string
	kind: string
	definition: string | null
}) {
	if (type.definition?.trim()) return type.definition.trim()
	return `${type.kind} ${type.name}`
}

function fitReferencedTypes(input: {
	referencedTypes: PackageExportProjection['referencedTypes']
	budget: number
}): {
	referencedTypes: Array<{
		name: string
		kind: PackageExportProjection['referencedTypes'][number]['kind']
		definition: string | null
	}>
	truncated: boolean
	markdown: string
} {
	const named = input.referencedTypes.map((type) => ({
		name: type.name,
		kind: type.kind,
		definition: type.definition,
	}))
	if (named.length === 0) {
		return { referencedTypes: [], truncated: false, markdown: '' }
	}
	const fullBlock = [
		'',
		'## Referenced types',
		'',
		'```ts',
		...named.map((type) => referencedTypeLine(type)),
		'```',
	].join('\n')
	if (fullBlock.length <= input.budget) {
		return {
			referencedTypes: named,
			truncated: false,
			markdown: fullBlock,
		}
	}
	const names = named
		.map((type) => formatMarkdownInlineCode(type.name))
		.join(', ')
	const namesBlock = [
		'',
		'## Referenced types',
		'',
		`- Names: ${names}`,
		'',
		packageExportReferencedTypesOmittedLine,
	].join('\n')
	if (namesBlock.length <= input.budget) {
		return {
			referencedTypes: named.map((type) => ({
				name: type.name,
				kind: type.kind,
				definition: null,
			})),
			truncated: true,
			markdown: namesBlock,
		}
	}
	return {
		referencedTypes: named.map((type) => ({
			name: type.name,
			kind: type.kind,
			definition: null,
		})),
		truncated: true,
		markdown: `\n\n${packageExportReferencedTypesOmittedLine}`,
	}
}

export function formatPackageExportEntityDetail(input: {
	detail: Extract<SearchEntityDetail, { type: 'package' }>
	exportDetail: PackageExportProjection
	includeBoilerplate?: boolean
	maxChars?: number
}): SearchEntityDetailFormatResult {
	const section = input.detail.section
	if (!section) {
		throw new McpCallerError(
			'Package export detail requires a section fragment.',
		)
	}
	const normalized = normalizePackageExportFragment(section)
	const entityRef = buildEntityRef(
		input.detail.record.kodyId,
		'package',
		normalized,
	)
	const importSpecifier = buildPackageImportSpecifier(
		input.detail.record.name,
		input.exportDetail.subpath,
	)
	const jsDoc = splitPackageExportJsDoc(
		input.exportDetail.description ??
			input.exportDetail.functions.find((fn) => fn.description)?.description,
	)
	const purpose =
		jsDoc.purpose ?? input.exportDetail.description ?? input.detail.description
	const executeExample = buildPackageExportExecuteExample({
		packageName: input.detail.record.name,
		subpath: input.exportDetail.subpath,
		functions: input.exportDetail.functions,
	})
	const includeBoilerplate = input.includeBoilerplate ?? true
	const followUp = includeBoilerplate
		? buildPackageExportFollowUp({
				packageId: input.detail.record.id,
			})
		: ''
	const functions = input.exportDetail.functions.map((fn) => ({
		name: fn.name,
		description:
			splitPackageExportJsDoc(fn.description).purpose ?? fn.description,
		typeDefinition: fn.typeDefinition,
	}))
	const headerLines = [
		`# Package export — \`${input.detail.record.kodyId}\` / \`${normalized}\``,
		'',
		purpose,
		'',
		'## Summary',
		'',
		`- Entity: \`${entityRef}\``,
		`- Package name: \`${input.detail.record.name}\``,
		`- kody_id: \`${input.detail.record.kodyId}\``,
		`- Import: \`${importSpecifier}\``,
		'',
		'## Execute from `execute`',
		'',
		'```ts',
		executeExample,
		'```',
	]
	const typeLines: Array<string> = []
	if (input.exportDetail.typeDefinition) {
		typeLines.push(
			'',
			'## Type definition',
			'',
			'```ts',
			input.exportDetail.typeDefinition,
			'```',
		)
	}
	if (functions.length > 1) {
		typeLines.push('', '## Functions', '')
		for (const fn of functions) {
			typeLines.push(
				`- ${formatMarkdownInlineCode(fn.name)}${fn.description ? ` — ${fn.description}` : ''}`,
			)
			if (fn.typeDefinition) {
				typeLines.push('', '```ts', fn.typeDefinition, '```', '')
			}
		}
	} else if (
		!input.exportDetail.typeDefinition &&
		functions[0]?.typeDefinition
	) {
		typeLines.push(
			'',
			'## Type definition',
			'',
			'```ts',
			functions[0].typeDefinition,
			'```',
		)
	}
	const exampleLines =
		jsDoc.example != null
			? ['', '## Example', '', '```ts', jsDoc.example, '```']
			: []
	const followUpLines =
		followUp.length > 0 ? ['', '## Follow up', '', followUp] : []
	const budget = input.maxChars ?? maxChars
	const reservedTail = [...exampleLines, ...followUpLines].join('\n')
	const core = [...headerLines, ...typeLines].join('\n')
	const remaining = Math.max(0, budget - core.length - reservedTail.length - 1)
	const referenced = fitReferencedTypes({
		referencedTypes: input.exportDetail.referencedTypes,
		budget: remaining,
	})
	const markdown = [core, referenced.markdown, reservedTail]
		.filter((part) => part.length > 0)
		.join('\n')
	const primary = getPrimaryPackageActionFunction({
		functions: input.exportDetail.functions,
	})
	const usage = !primary
		? `import * as exported from ${JSON.stringify(importSpecifier)}`
		: isDefaultExportName(primary.name)
			? `import action from ${JSON.stringify(importSpecifier)}`
			: `import { ${primary.name} } from ${JSON.stringify(importSpecifier)}`
	return {
		markdown,
		structured: {
			kind: 'entity',
			type: 'package',
			detailMode: 'export',
			id: input.detail.record.kodyId,
			entityRef,
			title: `${input.detail.record.name} ${input.exportDetail.subpath}`,
			description: purpose,
			usage,
			packageId: input.detail.record.id,
			kodyId: input.detail.record.kodyId,
			name: input.detail.record.name,
			importSpecifier,
			executeExample,
			typeDefinition: input.exportDetail.typeDefinition,
			functions,
			referencedTypes: referenced.referencedTypes,
			example: jsDoc.example,
			followUp,
			hidden: input.detail.record.hidden,
			...(referenced.truncated ? { referencedTypesTruncated: true } : {}),
		},
	}
}
