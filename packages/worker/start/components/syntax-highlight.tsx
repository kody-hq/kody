/** @jsxImportSource @emotion/react */

import { type ReactNode } from 'react'
import {
	shikiPreClass,
	type HighlightedCode,
} from '#universal/highlighted-code.ts'

/**
 * Paints a pre-tokenized code block. Origin (or the highlight worker) owns
 * Shiki; this module only turns serializable spans into JSX text and
 * inline styles — never `innerHTML`.
 */
function rootStyleFromTokens(fg: string | undefined, bg: string | undefined) {
	const style: Record<string, string> = {}
	for (const value of [bg, fg]) {
		if (!value) continue
		const [first, ...rest] = value.split(';')
		if (first && value === bg) style.backgroundColor = first
		if (first && value === fg) style.color = first
		for (const part of rest) {
			const separator = part.indexOf(':')
			if (separator <= 0) continue
			style[part.slice(0, separator)] = part.slice(separator + 1)
		}
	}
	return style
}

export function renderHighlightedCode(
	highlighted: HighlightedCode,
	key?: number,
): ReactNode {
	if (highlighted.plain || highlighted.lines.length === 0) {
		return (
			<pre key={key} className={shikiPreClass}>
				<code>{highlighted.code}</code>
			</pre>
		)
	}
	return (
		<pre
			key={key}
			className={shikiPreClass}
			style={rootStyleFromTokens(highlighted.fg, highlighted.bg)}
		>
			<code>
				{highlighted.lines.map((line, lineIndex) => (
					<span className="line" key={lineIndex}>
						{line.map((token, tokenIndex) => (
							<span key={tokenIndex} style={token.style}>
								{token.content}
							</span>
						))}
						{lineIndex < highlighted.lines.length - 1 ? '\n' : null}
					</span>
				))}
			</code>
		</pre>
	)
}
