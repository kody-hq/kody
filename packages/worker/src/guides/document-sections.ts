import { McpCallerError } from '#mcp/caller-error.ts'
import {
	FileAnchorError,
	formatLineExcerpt,
	formatRequestedLineLabel,
	parseLineAnchor,
	splitSourceLines,
} from './line-anchor.ts'

export type DocumentHeading = {
	level: number
	title: string
	slug: string
	start: number
	end: number
}

type ResolvedDocumentLines = {
	startLine: number
	endLine: number
	requestedStartLine: number
	requestedEndLine: number
	totalLines: number
}

export type ResolvedDocumentSection = {
	mode: 'full' | 'toc' | 'section' | 'lines'
	markdown: string
	headings: Array<DocumentHeading>
	selected: DocumentHeading | null
	lines: ResolvedDocumentLines | null
}

const headingLinePattern = /^(#{1,6})\s+(.+?)\s*$/
const fencedBlockPattern = /^(`{3,}|~{3,})/

export function slugifyDocumentHeading(title: string) {
	return normalizeHeadingKey(title)
		.replace(/[^\p{L}\p{N}._-]+/gu, '-')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '')
}

export function parseDocumentHeadings(
	markdown: string,
): Array<DocumentHeading> {
	const lines = markdown.split('\n')
	const parsed: Array<Omit<DocumentHeading, 'end' | 'slug'>> = []
	let fence: string | null = null

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? ''
		const fenceMatch = line.match(fencedBlockPattern)
		if (fenceMatch) {
			const marker = fenceMatch[1] ?? ''
			if (fence == null) {
				fence = marker
			} else if (
				marker[0] === fence[0] &&
				marker.length >= fence.length &&
				line.slice(marker.length).trim() === ''
			) {
				fence = null
			}
			continue
		}
		if (fence != null) continue

		const headingMatch = line.match(headingLinePattern)
		if (!headingMatch) continue
		const marks = headingMatch[1] ?? ''
		const rawTitle = headingMatch[2] ?? ''
		parsed.push({
			level: marks.length,
			title: rawTitle.replace(/\s+#+\s*$/, '').trim(),
			start: index,
		})
	}

	const usedSlugs = new Map<string, number>()
	return parsed.map((heading, index) => {
		const nextSameOrHigher = parsed
			.slice(index + 1)
			.find((candidate) => candidate.level <= heading.level)
		const baseSlug = slugifyDocumentHeading(heading.title) || 'section'
		const seen = usedSlugs.get(baseSlug) ?? 0
		usedSlugs.set(baseSlug, seen + 1)
		return {
			...heading,
			slug: seen === 0 ? baseSlug : `${baseSlug}-${String(seen + 1)}`,
			end: nextSameOrHigher?.start ?? lines.length,
		}
	})
}

export function findDocumentHeading(
	headings: ReadonlyArray<DocumentHeading>,
	section: string,
) {
	const requested = decodeSectionFragment(section)
	if (!requested) return null
	const requestedSlug = slugifyDocumentHeading(requested)
	return (
		headings.find((heading) => heading.slug === requested) ??
		headings.find((heading) => heading.slug === requestedSlug) ??
		headings.find(
			(heading) => normalizeHeadingKey(heading.title) === requested,
		) ??
		headings.find(
			(heading) =>
				normalizeHeadingKey(heading.title) === normalizeHeadingKey(requested),
		) ??
		null
	)
}

export function formatDocumentContents(input: {
	headings: ReadonlyArray<DocumentHeading>
	entityRef: string
	parent?: DocumentHeading | null
}) {
	const requestable = requestableHeadings(input.headings, input.parent)
	const lines = [
		'## Contents',
		'',
		input.parent
			? `Section ${formatHeadingLabel(input.parent.title)} is larger than the search response budget. Open a subsection:`
			: 'This document is larger than the search response budget. Open one section:',
		'',
		...requestable.map((heading) => {
			const indent = '  '.repeat(Math.max(0, heading.level - 2))
			return `${indent}- ${formatHeadingLabel(heading.title)} — \`${input.entityRef}#${heading.slug}\``
		}),
		'',
		`Request a section with \`search({ entity: "${input.entityRef}#${requestable[0]?.slug ?? 'section-slug'}" })\`.`,
	]
	return lines.join('\n')
}

export function resolveMarkdownDocument(input: {
	markdown: string
	maxChars: number
	entityRef: string
	section?: string
}): ResolvedDocumentSection {
	const headings = parseDocumentHeadings(input.markdown)
	if (input.section != null) {
		const lineAnchor = parseLineAnchor(input.section)
		if (lineAnchor.status === 'invalid') {
			throw new McpCallerError(lineAnchor.message)
		}
		if (lineAnchor.status === 'ok') {
			return resolveLineAnchor({
				markdown: input.markdown,
				maxChars: input.maxChars,
				entityRef: input.entityRef,
				headings,
				startLine: lineAnchor.startLine,
				endLine: lineAnchor.endLine,
			})
		}
		const selected = findDocumentHeading(headings, input.section)
		if (!selected) {
			const available = requestableHeadings(headings)
				.map((heading) => heading.slug)
				.join(', ')
			throw new McpCallerError(
				`Unknown section ${JSON.stringify(input.section)} for ${input.entityRef}. Available: ${available || 'none'}.`,
			)
		}
		return resolveSelectedSection({
			markdown: input.markdown,
			maxChars: input.maxChars,
			entityRef: input.entityRef,
			headings,
			selected,
		})
	}

	if (input.markdown.length <= input.maxChars) {
		return {
			mode: 'full',
			markdown: input.markdown,
			headings,
			selected: null,
			lines: null,
		}
	}

	return {
		mode: 'toc',
		markdown: formatDocumentContents({
			headings,
			entityRef: input.entityRef,
		}),
		headings,
		selected: null,
		lines: null,
	}
}

function resolveLineAnchor(input: {
	markdown: string
	maxChars: number
	entityRef: string
	headings: Array<DocumentHeading>
	startLine: number
	endLine: number
}): ResolvedDocumentSection {
	const label = `${input.entityRef}#${formatRequestedLineLabel({
		requestedStartLine: input.startLine,
		requestedEndLine: input.endLine,
	})}`
	try {
		const excerpt = formatLineExcerpt({
			label,
			lines: splitSourceLines(input.markdown),
			startLine: input.startLine,
			endLine: input.endLine,
			maxChars: input.maxChars,
		})
		return {
			mode: 'lines',
			markdown: excerpt.content,
			headings: input.headings,
			selected: null,
			lines: {
				startLine: excerpt.startLine,
				endLine: excerpt.endLine,
				requestedStartLine: excerpt.requestedStartLine,
				requestedEndLine: excerpt.requestedEndLine,
				totalLines: excerpt.totalLines,
			},
		}
	} catch (error) {
		if (error instanceof FileAnchorError) {
			throw new McpCallerError(error.message, { cause: error })
		}
		throw error
	}
}

function resolveSelectedSection(input: {
	markdown: string
	maxChars: number
	entityRef: string
	headings: Array<DocumentHeading>
	selected: DocumentHeading
}): ResolvedDocumentSection {
	const lines = input.markdown.split('\n')
	const sectionMarkdown = lines
		.slice(input.selected.start, input.selected.end)
		.join('\n')
		.trim()
	if (sectionMarkdown.length <= input.maxChars) {
		return {
			mode: 'section',
			markdown: sectionMarkdown,
			headings: input.headings,
			selected: input.selected,
			lines: null,
		}
	}

	const childHeadings = requestableHeadings(input.headings, input.selected)
	if (childHeadings.length === 0) {
		const footer =
			'\n\n--- TRUNCATED ---\nThis section is larger than the search response budget and has no subsections.'
		const budget = Math.max(0, input.maxChars - footer.length)
		return {
			mode: 'section',
			markdown: `${sectionMarkdown.slice(0, budget)}${footer}`,
			headings: input.headings,
			selected: input.selected,
			lines: null,
		}
	}

	return {
		mode: 'toc',
		markdown: formatDocumentContents({
			headings: input.headings,
			entityRef: input.entityRef,
			parent: input.selected,
		}),
		headings: input.headings,
		selected: input.selected,
		lines: null,
	}
}

function requestableHeadings(
	headings: ReadonlyArray<DocumentHeading>,
	parent?: DocumentHeading | null,
) {
	if (parent) {
		return headings.filter(
			(heading) =>
				heading.start > parent.start &&
				heading.start < parent.end &&
				heading.level > parent.level,
		)
	}
	const belowTitle = headings.filter((heading) => heading.level >= 2)
	return belowTitle.length > 0 ? belowTitle : [...headings]
}

function formatHeadingLabel(title: string) {
	return /[`*_[\]]/.test(title) ? title : `\`${title}\``
}

function decodeSectionFragment(section: string) {
	const trimmed = section.trim()
	if (!trimmed) return ''
	try {
		return normalizeHeadingKey(decodeURIComponent(trimmed.replace(/\+/g, ' ')))
	} catch {
		return normalizeHeadingKey(trimmed)
	}
}

function normalizeHeadingKey(value: string) {
	return value
		.replace(/[`*_~]/g, '')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase()
}
