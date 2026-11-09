import { McpCallerError } from '#mcp/caller-error.ts'
import {
	FileAnchorError,
	readAnchoredText,
	splitFileAnchor,
} from '#worker/guides/file-anchor.ts'
import { boundAnchoredText } from '#worker/guides/line-anchor.ts'

import { maxChars } from './search-constants.ts'
import type { SearchEntityDetailFormatResult } from './search-entity-plugin.ts'
import { buildEntityRef } from './search-format-helpers.ts'
import type { SearchEntityDetail } from './search-format-types.ts'

type PackageEntityDetail = Extract<SearchEntityDetail, { type: 'package' }>

/**
 * Open one package source file from `package:{id}#{path}` when the fragment
 * is not an export subpath. Returns null when the section is not file-shaped
 * so the caller can keep the unknown-export error.
 */
export function formatPackageFileEntityDetail(input: {
	detail: PackageEntityDetail
	section: string
	includeBoilerplate?: boolean
	maxChars?: number
}): SearchEntityDetailFormatResult | null {
	const requested = splitPackageFileSection(input.section)
	const located = findPackageSourceFile(input.detail.files, requested.path)
	if (!located) {
		if (requested.fragment || looksLikePackageFilePath(requested.path)) {
			throw new McpCallerError(
				`Unknown file ${JSON.stringify(requested.path)} for ${buildEntityRef(input.detail.record.kodyId, 'package')}.`,
			)
		}
		return null
	}
	const entitySection = requested.fragment
		? `${located.path}#${requested.fragment}`
		: located.path
	const entityRef = buildEntityRef(
		input.detail.record.kodyId,
		'package',
		entitySection,
	)
	const includeBoilerplate = input.includeBoilerplate ?? true
	const followUp = buildPackageFileFollowUp({
		packageId: input.detail.record.id,
		entityRef,
	})
	const header = [
		`# Package file — \`${input.detail.record.kodyId}\``,
		'',
		`\`${entityRef}\``,
		'',
	].join('\n')
	const tail = includeBoilerplate ? `\n\n## Follow up\n\n${followUp}` : ''
	const opened = openPackageFileContent({
		path: located.path,
		content: located.content,
		fragment: requested.fragment,
		entityRef,
		maxChars: Math.max(
			0,
			(input.maxChars ?? maxChars) - header.length - tail.length,
		),
	})
	const markdown = `${header}${opened.content}${tail}`
	return {
		markdown,
		structured: {
			kind: 'entity',
			type: 'package',
			detailMode: 'file',
			id: input.detail.record.kodyId,
			entityRef,
			title: `${input.detail.record.name} ${located.path}`,
			description: input.detail.description,
			usage: `search({ entity: ${JSON.stringify(entityRef)} })`,
			packageId: input.detail.record.id,
			kodyId: input.detail.record.kodyId,
			name: input.detail.record.name,
			path: located.path,
			content: opened.content,
			truncated: opened.truncated,
			anchor: opened.anchor,
		},
	}
}

function splitPackageFileSection(section: string) {
	try {
		return splitFileAnchor(section)
	} catch (error) {
		if (error instanceof FileAnchorError) {
			throw new McpCallerError(error.message, { cause: error })
		}
		throw error
	}
}

function openPackageFileContent(input: {
	path: string
	content: string
	fragment: string | null
	entityRef: string
	maxChars: number
}) {
	if (!input.fragment) {
		const bounded = boundAnchoredText({
			text: input.content,
			maxChars: input.maxChars,
			tighterHint: `Open a line range with \`${input.entityRef}#L1-L200\` or a Markdown heading slug.`,
		})
		return {
			content: bounded.text,
			truncated: bounded.truncated,
			anchor: null,
		}
	}
	try {
		const anchored = readAnchoredText({
			path: input.path,
			content: input.content,
			fragment: input.fragment,
			maxChars: input.maxChars,
		})
		return {
			content: anchored.content,
			truncated: anchored.truncated,
			anchor: anchored.anchor,
		}
	} catch (error) {
		if (error instanceof FileAnchorError) {
			throw new McpCallerError(error.message, { cause: error })
		}
		throw error
	}
}

function findPackageSourceFile(
	files: Record<string, string>,
	requestedPath: string,
) {
	const normalized = normalizePackageFilePath(requestedPath)
	if (Object.prototype.hasOwnProperty.call(files, normalized)) {
		return { path: normalized, content: files[normalized] ?? '' }
	}
	const dotted = `./${normalized}`
	if (Object.prototype.hasOwnProperty.call(files, dotted)) {
		return { path: dotted, content: files[dotted] ?? '' }
	}
	return null
}

function normalizePackageFilePath(path: string) {
	const trimmed = path.trim().replace(/^\.\//, '')
	if (
		!trimmed ||
		trimmed.startsWith('/') ||
		trimmed.split('/').includes('..') ||
		trimmed.split('/').includes('.')
	) {
		throw new McpCallerError(
			`Invalid package file path ${JSON.stringify(path)}.`,
		)
	}
	return trimmed
}

function looksLikePackageFilePath(path: string) {
	const normalized = path.trim().replace(/^\.\//, '')
	if (normalized.includes('/') || normalized.includes('#')) return true
	return /\.[A-Za-z0-9]{1,12}$/.test(normalized)
}

function buildPackageFileFollowUp(input: {
	packageId: string
	entityRef: string
}) {
	const session = `repoOpenSession({ target: { kind: "package", package_id: ${JSON.stringify(input.packageId)} } })`
	return `This is one file. Edit it with ${session}, then repoEditFiles. Re-open a region with search({ entity: ${JSON.stringify(input.entityRef)} }). Line anchors are #L165 and #L165-L180. Markdown files also accept a heading slug.`
}
