import {
	type BlockNode,
	type InlineNode,
	type MarkdownExtension,
} from '@tanstack/markdown'

const firstPartyAlertKinds = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING'] as const
export type FirstPartyAlertKind = (typeof firstPartyAlertKinds)[number]
const alertMarkerRe = /^\[!(NOTE|TIP|IMPORTANT|WARNING)\][ \t]*/
const diagramMarkerRe = /^\[!DIAGRAM\][ \t]+([a-z0-9-]+)\s*/

/** Only repo-authored docs enable this allowlisted disclosure syntax. */
export const firstPartyDetailsExtension: MarkdownExtension = {
	name: 'kody-details',
	parseBlock(context) {
		const first = context.lines[context.index] ?? ''
		if (!/^\s*<details(?:\s+open)?\s*>/i.test(first)) return
		let end = context.index
		while (
			end < context.lines.length &&
			!/<\/details\s*>/i.test(context.lines[end] ?? '')
		)
			end++
		if (end === context.lines.length) return
		const raw = context.lines
			.slice(context.index, end + 1)
			.join('\n')
			.trim()
		const match =
			/^<details(?:\s+open)?\s*>\s*<summary\s*>([\s\S]*?)<\/summary\s*>([\s\S]*?)<\/details\s*>$/i.exec(
				raw,
			)
		if (!match || /<\/?details\b/i.test(match[2] ?? '')) return
		const summary = match[1]?.replace(/<[^>]+>/g, '').trim()
		if (!summary) return
		context.consume(end - context.index + 1)
		return {
			type: 'component',
			name: 'kody-details',
			attributes: { summary },
			children: context.parseBlocks((match[2] ?? '').trim()),
		}
	},
}

export function markdownInlineText(nodes: Array<InlineNode>): string {
	return nodes
		.map((node) => {
			if ('children' in node) return markdownInlineText(node.children)
			if (node.type === 'image') return node.alt
			if (node.type === 'break') return ' '
			if (node.type === 'inlineHtml') return ''
			return 'value' in node
				? node.type === 'text'
					? decodeMarkdownText(node.value)
					: node.value
				: ''
		})
		.join('')
}

export function markdownBlockText(nodes: Array<BlockNode>): string {
	return nodes
		.map((node) => {
			if (node.type === 'paragraph' || node.type === 'heading')
				return markdownInlineText(node.children)
			if (node.type === 'blockquote') return markdownBlockText(node.children)
			return ''
		})
		.join('\n')
}

function blockquoteMarker(node: BlockNode, marker: RegExp) {
	if (node.type !== 'blockquote') return null
	const first = node.children[0]
	if (first?.type !== 'paragraph') return null
	return marker.exec(markdownInlineText(first.children).trimStart())
}
export function firstPartyAlertKind(
	node: BlockNode,
): FirstPartyAlertKind | null {
	const match = blockquoteMarker(node, alertMarkerRe)
	return match ? (match[1] as FirstPartyAlertKind) : null
}
export function firstPartyDiagramId(node: BlockNode): string | null {
	return blockquoteMarker(node, diagramMarkerRe)?.[1] ?? null
}
export function stripFirstPartyAlertMarker(
	nodes: Array<BlockNode>,
): Array<BlockNode> {
	return stripLeadingMarker(nodes, alertMarkerRe)
}
export function stripFirstPartyDiagramMarker(
	nodes: Array<BlockNode>,
): Array<BlockNode> {
	return stripLeadingMarker(nodes, diagramMarkerRe)
}
function stripLeadingMarker(
	nodes: Array<BlockNode>,
	marker: RegExp,
): Array<BlockNode> {
	const [first, ...rest] = nodes
	if (first?.type !== 'paragraph') return nodes
	const [inline, ...remaining] = first.children
	if (inline?.type !== 'text') return nodes
	const value = inline.value.trimStart().replace(marker, '')
	return [
		{
			...first,
			children: value ? [{ ...inline, value }, ...remaining] : remaining,
		},
		...rest,
	]
}

export function firstPartyAlertLabel(kind: FirstPartyAlertKind): string {
	switch (kind) {
		case 'NOTE':
			return 'Note'
		case 'TIP':
			return 'Tip'
		case 'IMPORTANT':
			return 'Important'
		case 'WARNING':
			return 'Warning'
		default: {
			const exhaustive: never = kind
			return exhaustive
		}
	}
}

const namedEntities: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: '\u00a0',
}

/**
 * Markdown text tokens keep character references (`&amp;`, `&#65;`) verbatim
 * and are rendered as JSX text. We render as JSX text (which
 * re-escapes), so decode them first to display what the author meant.
 */
export function decodeMarkdownText(value: string): string {
	if (!value.includes('&')) return value
	return value.replace(
		/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi,
		(match, entity: string) => {
			if (entity.startsWith('#')) {
				const codePoint =
					entity[1]?.toLowerCase() === 'x'
						? Number.parseInt(entity.slice(2), 16)
						: Number.parseInt(entity.slice(1), 10)
				if (!Number.isInteger(codePoint) || codePoint <= 0) return match
				try {
					return String.fromCodePoint(codePoint)
				} catch {
					return match
				}
			}
			return namedEntities[entity.toLowerCase()] ?? match
		},
	)
}
