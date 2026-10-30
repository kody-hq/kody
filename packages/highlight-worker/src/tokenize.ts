import { createHighlighter } from '@tanstack/highlight/core'
import { css } from '@tanstack/highlight/languages/css'
import { diff } from '@tanstack/highlight/languages/diff'
import { dockerfile } from '@tanstack/highlight/languages/dockerfile'
import { env } from '@tanstack/highlight/languages/env'
import { go } from '@tanstack/highlight/languages/go'
import { graphql } from '@tanstack/highlight/languages/graphql'
import { html } from '@tanstack/highlight/languages/html'
import { ini } from '@tanstack/highlight/languages/ini'
import { json } from '@tanstack/highlight/languages/json'
import { markdown } from '@tanstack/highlight/languages/markdown'
import { python } from '@tanstack/highlight/languages/python'
import { rust } from '@tanstack/highlight/languages/rust'
import { shell } from '@tanstack/highlight/languages/shell'
import { sql } from '@tanstack/highlight/languages/sql'
import { toml } from '@tanstack/highlight/languages/toml'
import { tsx } from '@tanstack/highlight/languages/tsx'
import { ts } from '@tanstack/highlight/languages/ts'
import { js } from '@tanstack/highlight/languages/js'
import { jsx } from '@tanstack/highlight/languages/jsx'
import { yaml } from '@tanstack/highlight/languages/yaml'
import { githubDarkTheme } from '@tanstack/highlight/themes/github-dark'
import { githubLightTheme } from '@tanstack/highlight/themes/github-light'
import {
	plainHighlightedCode,
	type HighlightedCode,
	type HighlightedSpan,
	type HighlightSnippet,
} from '../../worker/universal/highlighted-code.ts'

// Reuse a selective registry, including HTML's embedded JavaScript and CSS.
const highlighter = createHighlighter({
	languages: [
		css,
		diff,
		dockerfile,
		env,
		go,
		graphql,
		html,
		ini,
		json,
		markdown,
		python,
		rust,
		shell,
		sql,
		toml,
		tsx,
		ts,
		js,
		jsx,
		yaml,
	],
})
const maxHighlightChars = 50_000
const maxLineLength = 2_000
const aliases: Record<string, string> = {
	cjs: 'js',
	mjs: 'js',
	zsh: 'shell',
	console: 'shell',
	shellscript: 'shell',
	dotenv: 'env',
	xml: 'html',
}

export function tokenizeSnippet(snippet: HighlightSnippet): HighlightedCode {
	const code = snippet.code
	if (
		code.length > maxHighlightChars ||
		code.split('\n').some((line) => line.length > maxLineLength)
	)
		return plainHighlightedCode(code, snippet.lang)
	const primary =
		snippet.lang
			?.trim()
			.toLowerCase()
			.split(/[\s{,]+/, 1)[0] ?? ''
	const alias = Object.hasOwn(aliases, primary) ? aliases[primary] : undefined
	const lang = highlighter.normalizeLanguage(alias ?? primary)
	if (lang === 'plaintext') return plainHighlightedCode(code, snippet.lang)
	let result: ReturnType<typeof highlighter.tokenize>
	try {
		result = highlighter.tokenize(code, { lang })
	} catch {
		return plainHighlightedCode(code, snippet.lang)
	}
	const lines: Array<Array<HighlightedSpan>> = [[]]
	for (const token of result.tokens) {
		const parts = token.value.split('\n')
		for (const [index, content] of parts.entries()) {
			if (index > 0) lines.push([])
			if (!content) continue
			const style = token.className
				? {
						color: githubLightTheme.tokens[token.className],
						'--highlight-dark': githubDarkTheme.tokens[token.className],
					}
				: undefined
			lines[lines.length - 1]?.push({ content, ...(style ? { style } : {}) })
		}
	}
	return {
		code,
		lang,
		plain: false,
		fg: `${githubLightTheme.foreground};--highlight-dark:${githubDarkTheme.foreground}`,
		bg: `${githubLightTheme.background};--highlight-dark-bg:${githubDarkTheme.background}`,
		lines,
	}
}

export function tokenizeSnippets(
	snippets: Array<HighlightSnippet>,
): Array<HighlightedCode> {
	return snippets.map(tokenizeSnippet)
}
