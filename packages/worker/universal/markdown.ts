import { parseMarkdown } from '@tanstack/markdown/parser'
import { type MarkdownExtension } from '@tanstack/markdown'
import { firstPartyDetailsExtension } from './markdown-first-party.ts'

/** Keep explicit angle links supported without enabling arbitrary HTML. */
const angleLinks: MarkdownExtension = {
	name: 'kody-angle-links',
	inlineParser: {
		markers: '<',
		parse({ source, index, inLink }) {
			if (inLink) return
			const match = /^<((?:https?:\/\/|mailto:)[^<>\s]+)>/i.exec(
				source.slice(index),
			)
			const href = match?.[1]
			if (!match || !href) return
			return {
				length: match[0].length,
				node: { type: 'link', href, children: [{ type: 'text', value: href }] },
			}
		},
	},
}

/** Each docs figure owns one contiguous quote, even beside another figure. */
const docQuotes: MarkdownExtension = {
	name: 'kody-doc-quotes',
	parseBlock(context) {
		if (
			!/^\s*>\s*\[!(?:WATCH|DIAGRAM|NOTE|TIP|IMPORTANT|WARNING)\]/.test(
				context.lines[context.index] ?? '',
			)
		)
			return
		const lines: Array<string> = []
		let end = context.index
		while (
			end < context.lines.length &&
			/^\s*>/.test(context.lines[end] ?? '')
		) {
			lines.push((context.lines[end] ?? '').replace(/^\s*> ?/, ''))
			end++
		}
		context.consume(end - context.index)
		return {
			type: 'blockquote',
			children: context.parseBlocks(lines.join('\n')),
		}
	},
}

export function parseKodyMarkdown(markdown: string, firstParty = false) {
	return parseMarkdown(markdown, {
		// HTML nodes are rendered as escaped JSX text, never inserted as markup.
		allowHtml: true,
		// The renderer applies Kody's stricter link and package-asset policies.
		urlTransform: (url) => url,
		extensions: firstParty
			? [angleLinks, firstPartyDetailsExtension, docQuotes]
			: [angleLinks],
	})
}
