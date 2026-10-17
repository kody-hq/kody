/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'
/**
 * Safe markdown rendering for untrusted, third-party authored content
 * (public package READMEs).
 *
 * Safety model (do not regress):
 * - Markdown is parsed with `marked`'s lexer only; its HTML renderer is never
 *   used. Output is built exclusively from JSX text and an allowlist of token
 *   types, so every string goes through the framework's escaping.
 * - Raw HTML tokens (block and inline) are rendered as escaped literal text,
 *   never as markup. First-party guides (`linkPolicy: 'first-party'`) may
 *   additionally emit allowlisted `<details>` / `<summary>`, GitHub-style
 *   `> [!TIP]` callouts, `> [!WATCH]` YouTube figures (validated video
 *   id, privacy-enhanced embed, click to play), and `> [!DIAGRAM] <id>`
 *   figures drawn from a fixed first-party registry. Untrusted markdown
 *   never takes that path.
 * - Fenced code paints pre-tokenized highlight data as JSX text and
 *   inline styles — never `innerHTML` — so highlighting cannot introduce
 *   markup. Missing tokens fall back to escaped plaintext.
 * - Resource-loading elements are not emitted by default (`<img>`,
 *   `<iframe>`, media, etc.). The one iframe exception is a first-party
 *   `[!WATCH]` block, which mounts the existing lite player. Community
 *   READMEs may opt in to `<img>` only for in-repo relative paths rewritten
 *   to this package's first-party
 *   `/assets/` route. Remote, protocol-relative, and user-scope URLs stay
 *   links (or plain text) so a README cannot hotlink arbitrary hosts or
 *   point the browser at hosted package endpoints (`/@username/packages/*`
 *   and `/packages/*`), which execute author-controlled code.
 * - Links must be absolute `http:`/`https:`/`mailto:` URLs. Relative URLs
 *   (which would resolve against this origin) and URLs whose path points at a
 *   hosted package surface (`/@...` or `/packages/...`) render as plain text.
 *   Allowed links open in a new tab with `rel="noopener noreferrer nofollow
 *   ugc"`.
 *
 * The first-party CSP (`security-headers.ts`) blocks off-site scripts,
 * images, and connections as defense in depth; this module must stay safe
 * without relying on it.
 */
import { SiteLink } from './site-link.tsx'

import { lexer, type Token, type Tokens } from 'marked'
import { type CSSObject } from '@emotion/react'
import { type ReactNode } from 'react'
import { CopyCodeBlock } from './copy-code-block.tsx'
import { DocYoutubeEmbed } from './doc-youtube-embed.tsx'
import { renderMarkdownHeadingAnchor } from './markdown-heading-anchor.tsx'
import { renderDocDiagram } from './doc-diagrams.tsx'
import {
	coalesceFirstPartyDetails,
	firstPartyAlertKind,
	firstPartyAlertLabel,
	firstPartyDiagramId,
	isFirstPartyDetailsToken,
	stripFirstPartyAlertMarker,
	stripFirstPartyDiagramMarker,
} from '#client/markdown-first-party.ts'
import { renderHighlightedCode } from './syntax-highlight.tsx'
import { parseDocWatchBlock } from '#universal/doc-youtube.ts'
import {
	plainHighlightedCode,
	type HighlightedCode,
} from '#universal/highlighted-code.ts'
import {
	joinPackageReadmeImageHref,
	resolvePackageReadmeImagePath,
} from '#universal/package-readme-images.ts'
import {
	getAccentCalloutCss,
	nativeDisclosureCss,
} from '#universal/styles/style-primitives.ts'
import { colors } from '#universal/styles/tokens.ts'

const allowedLinkProtocols = new Set(['http:', 'https:', 'mailto:'])

export type RenderMarkdownOptions = {
	/**
	 * Added to each heading's authored depth before rendering (clamped to
	 * h2–h6, so page-owned h1 is never emitted). Defaults to 2 — the README
	 * demotion where `#` renders as h3. First-party surfaces that own their h1
	 * (the blog post) pass 0 so `##` keeps its authored h2 rhythm.
	 */
	headingOffset?: number
	/**
	 * `rel` for allowed links. Defaults to the third-party README policy
	 * (`nofollow ugc`); first-party content passes 'noopener noreferrer'.
	 */
	linkRel?: string
	/**
	 * Link resolution policy. The default `untrusted` policy (community
	 * READMEs) only allows absolute http(s)/mailto URLs and refuses anything
	 * that reaches a user scope. `first-party` is ONLY for repo-authored
	 * content (guides, blog): it additionally allows same-origin relative
	 * links (`/connect/oauth?...`), rendered as normal same-tab navigations.
	 * User-scope paths stay refused under every policy.
	 */
	linkPolicy?: 'untrusted' | 'first-party'
	/**
	 * Render fenced code blocks with a copy-to-clipboard button. Only for
	 * first-party surfaces whose snippets are meant to be pasted (guides).
	 */
	copyCodeBlocks?: boolean
	/**
	 * Highlight tokens for fenced code, in the same order `marked` emits
	 * `code` tokens. Missing or mismatched entries fall back to plaintext.
	 */
	fences?: Array<HighlightedCode>
	/**
	 * When true, headings get kebab-case `id` attributes (unique within one
	 * render) so first-party posts and docs can deep-link to a section. Off
	 * by default so third-party READMEs do not grow extra attributes.
	 */
	headingIds?: boolean
	/**
	 * First-party `/assets/` prefix for this package. When set, relative
	 * markdown images (`./docs/poster.png`) become `<img>` tags pointing at
	 * that prefix. Empty keeps the default "images are links" policy.
	 */
	imageBaseHref?: string
	/**
	 * Directory of the markdown file, used to resolve `./` image hrefs.
	 * Root READMEs leave this empty.
	 */
	imageFromDirectory?: string
}

type ResolvedRenderOptions = Required<Omit<RenderMarkdownOptions, 'fences'>> & {
	fences: Array<HighlightedCode>
	fenceCursor: { index: number }
	headingSlugCounts: Map<string, number>
}

const defaultRenderOptions = {
	headingOffset: 2,
	linkRel: 'noopener noreferrer nofollow ugc',
	linkPolicy: 'untrusted' as const,
	copyCodeBlocks: false,
	headingIds: false,
	fences: [] as Array<HighlightedCode>,
	imageBaseHref: '',
	imageFromDirectory: '',
}

/**
 * True when the URL's path could reach a hosted package surface: a user scope
 * (`/@...`) on any host, or a package-app mount (`/packages/...`, the path
 * shape served on per-user package-app subdomains). Deliberately
 * over-matches: it refuses these path shapes on *every* host because this
 * module cannot know the deployment's package-app domain (the same trade-off
 * the `/@` rule already makes for hosts like `medium.com/@author`). Repeated
 * leading slashes collapse (the worker routes with
 * `split('/').filter(Boolean)`, so `//@user` still reaches package apps) and
 * percent-encoding is decoded repeatedly (`/%40user`, `/%2540user`) before
 * checking. Undecodable paths are treated as user-scope so ambiguity always
 * fails closed.
 */
function hasUserScopePath(url: URL): boolean {
	let pathname = url.pathname
	for (let pass = 0; ; pass++) {
		let decoded: string
		try {
			decoded = decodeURIComponent(pathname)
		} catch {
			return true
		}
		if (decoded === pathname) break
		// Still decodable after several passes: pathologically nested
		// encoding, so fail closed rather than guessing.
		if (pass >= 4) return true
		pathname = decoded
	}
	const normalized = pathname.replace(/^\/+/, '')
	return (
		normalized.startsWith('@') ||
		normalized === 'packages' ||
		normalized.startsWith('packages/')
	)
}

/**
 * Returns a normalized href when the link is safe to emit, otherwise null.
 * Only absolute http(s)/mailto URLs pass, and any URL whose path enters a
 * user scope is refused on every host so READMEs cannot funnel viewers into
 * author-controlled endpoints.
 */
function getSafeMarkdownLinkHref(href: string): string | null {
	let url: URL
	try {
		url = new URL(href)
	} catch {
		return null
	}
	if (!allowedLinkProtocols.has(url.protocol)) return null
	if (hasUserScopePath(url)) return null
	return url.href
}

type ResolvedMarkdownLink = { href: string; external: boolean }

/**
 * Resolves a link under the render options' policy. Under `first-party`,
 * root-relative links (`/docs/oauth`, `/connect/oauth?...`) resolve as
 * internal same-tab navigations — still refusing user-scope paths, which are
 * never linkable from rendered markdown regardless of trust level.
 */
function resolveMarkdownLink(
	href: string,
	options: ResolvedRenderOptions,
): ResolvedMarkdownLink | null {
	if (options.linkPolicy === 'first-party' && href.startsWith('/')) {
		let url: URL
		try {
			url = new URL(href, 'https://kody.local')
		} catch {
			return null
		}
		if (hasUserScopePath(url)) return null
		return { href: `${url.pathname}${url.search}${url.hash}`, external: false }
	}
	const safeHref = getSafeMarkdownLinkHref(href)
	if (!safeHref) return null
	return { href: safeHref, external: true }
}

function slugifyMarkdownHeading(text: string): string {
	return text
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}._-]+/gu, '-')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '')
}

/**
 * Accessible name for a heading that also hosts a permalink. Built from
 * parsed inline tokens so emphasis, code, images, and links contribute
 * visible text instead of markdown source.
 */
function headingPermalinkLabel(
	tokens: Array<Token> | undefined,
	headingId: string,
): string {
	const visible = inlineTokensAccessibleName(tokens).replace(/\s+/g, ' ').trim()
	return visible || headingId
}

function inlineTokensAccessibleName(tokens: Array<Token> | undefined): string {
	if (!tokens) return ''
	let name = ''
	for (const token of tokens) {
		name += inlineTokenAccessibleName(token)
	}
	return name
}

function inlineTokenAccessibleName(token: Token): string {
	switch (token.type) {
		case 'text': {
			const textToken = token as Tokens.Text
			if (textToken.tokens?.length) {
				return inlineTokensAccessibleName(textToken.tokens)
			}
			return decodeCharacterReferences(textToken.text)
		}
		case 'strong':
		case 'em':
		case 'del':
		case 'link':
			return inlineTokensAccessibleName(token.tokens)
		case 'image':
			return decodeCharacterReferences(token.text)
		case 'codespan':
		case 'escape':
			return token.text
		case 'br':
			return ' '
		case 'html':
			return ''
		default:
			if ('tokens' in token && Array.isArray(token.tokens)) {
				return inlineTokensAccessibleName(token.tokens)
			}
			return ''
	}
}

function nextHeadingId(used: Map<string, number>, text: string): string {
	const base = slugifyMarkdownHeading(text) || 'section'
	const seen = used.get(base) ?? 0
	used.set(base, seen + 1)
	return seen === 0 ? base : `${base}-${seen + 1}`
}

/** True when raw HTML consists only of comments and whitespace. */
function isHtmlCommentOnly(raw: unknown): boolean {
	if (typeof raw !== 'string') return false
	const stripped = raw.replace(/<!--[\s\S]*?-->/g, '')
	return stripped.trim() === '' && stripped !== raw
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
 * because marked expects HTML passthrough. We render as JSX text (which
 * re-escapes), so decode them first to display what the author meant.
 */
function decodeCharacterReferences(value: string): string {
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

function resolveMarkdownImageSrc(
	href: string,
	options: ResolvedRenderOptions,
): string | null {
	if (!options.imageBaseHref) return null
	const relativePath = resolvePackageReadmeImagePath(
		href,
		options.imageFromDirectory,
	)
	if (!relativePath) return null
	return joinPackageReadmeImageHref(options.imageBaseHref, relativePath)
}

function renderLink(
	key: number,
	href: string,
	children: ReactNode,
	options: ResolvedRenderOptions,
): ReactNode {
	const resolved = resolveMarkdownLink(href, options)
	if (!resolved) return <span key={key}>{children}</span>
	if (!resolved.external) {
		return (
			<SiteLink key={key} href={resolved.href}>
				{children}
			</SiteLink>
		)
	}
	return (
		<a key={key} href={resolved.href} target="_blank" rel={options.linkRel}>
			{children}
		</a>
	)
}

function renderTableCell(
	cell: Tokens.TableCell,
	key: number,
	tag: 'th' | 'td',
	options: ResolvedRenderOptions,
): ReactNode {
	const Tag = tag
	return (
		<Tag key={key} css={cell.align ? { textAlign: cell.align } : undefined}>
			{renderTokens(cell.tokens, options)}
		</Tag>
	)
}

const compactLastColumnMaxChars = 40

function tableLastColumnIsCompact(table: Tokens.Table): boolean {
	const lastCells = [
		table.header.at(-1),
		...table.rows.map((row) => row.at(-1)),
	]
	return lastCells.every((cell) => {
		const text = cell?.text.trim() ?? ''
		return text.length > 0 && text.length <= compactLastColumnMaxChars
	})
}

function renderToken(
	token: Token,
	key: number,
	options: ResolvedRenderOptions,
): ReactNode {
	if (isFirstPartyDetailsToken(token)) {
		return (
			<details key={key} data-doc-disclosure="" css={firstPartyDetailsCss}>
				<summary>{token.summary}</summary>
				<div>{renderTokens(token.tokens, options)}</div>
			</details>
		)
	}
	switch (token.type) {
		case 'space':
		case 'def':
			return null
		case 'heading': {
			// Authored depth + offset, clamped so the page always owns h1 (the
			// README default offset of 2 also keeps listing-owned h2 clear).
			const level = Math.min(
				Math.max(token.depth + options.headingOffset, 2),
				6,
			)
			const Tag = `h${level}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
			const children = renderTokens(token.tokens, options)
			if (!options.headingIds) {
				return <Tag key={key}>{children}</Tag>
			}
			const headingId = nextHeadingId(options.headingSlugCounts, token.text)
			return (
				<Tag
					key={key}
					id={headingId}
					aria-label={headingPermalinkLabel(token.tokens, headingId)}
				>
					{renderMarkdownHeadingAnchor(key, headingId)}
					<span data-heading-text="">{children}</span>
				</Tag>
			)
		}
		case 'paragraph':
			return <p key={key}>{renderTokens(token.tokens, options)}</p>
		case 'blockquote': {
			if (options.linkPolicy === 'first-party') {
				const watch = parseDocWatchBlock(token.raw)
				if (watch) {
					return (
						<DocYoutubeEmbed
							key={key}
							videoId={watch.videoId}
							title={watch.title}
							label={watch.label}
						/>
					)
				}
				const diagramId = firstPartyDiagramId(token)
				const diagram = diagramId
					? renderDocDiagram({
							id: diagramId,
							key,
							caption: renderTokens(
								stripFirstPartyDiagramMarker(token.tokens),
								options,
							),
						})
					: null
				if (diagram) return diagram
				const alertKind = firstPartyAlertKind(token)
				if (alertKind) {
					const accentColor =
						alertKind === 'WARNING' || alertKind === 'IMPORTANT'
							? colors.danger
							: undefined
					return (
						<aside
							key={key}
							data-doc-callout={alertKind.toLowerCase()}
							css={{
								...getAccentCalloutCss({ accentColor }),
								...firstPartyCalloutBoxCss,
							}}
						>
							<strong>{firstPartyAlertLabel(alertKind)}</strong>
							{renderTokens(stripFirstPartyAlertMarker(token.tokens), options)}
						</aside>
					)
				}
			}
			return (
				<blockquote key={key}>{renderTokens(token.tokens, options)}</blockquote>
			)
		}
		case 'hr':
			return <hr key={key} />
		case 'code': {
			const codeToken = token as Tokens.Code
			const highlighted = takeFence(options, codeToken.text, codeToken.lang)
			if (options.copyCodeBlocks) {
				return (
					<CopyCodeBlock
						key={key}
						code={codeToken.text}
						lang={codeToken.lang}
						highlighted={highlighted}
					/>
				)
			}
			return renderHighlightedCode(highlighted, key)
		}
		case 'list': {
			// marked's Token union includes a generic catch-all, so `type`
			// narrowing alone leaves these fields untyped (same for `table`).
			const listToken = token as Tokens.List
			const items = listToken.items.map((item, index) =>
				renderToken(item, index, options),
			)
			if (!listToken.ordered) return <ul key={key}>{items}</ul>
			const start =
				typeof listToken.start === 'number' && listToken.start !== 1
					? listToken.start
					: undefined
			return (
				<ol key={key} start={start}>
					{items}
				</ol>
			)
		}
		case 'list_item':
			return <li key={key}>{renderTokens(token.tokens, options)}</li>
		case 'checkbox':
			return (
				<input key={key} type="checkbox" disabled checked={token.checked} />
			)
		case 'table': {
			const tableToken = token as Tokens.Table
			const compactLast = tableLastColumnIsCompact(tableToken)
			return (
				<div
					key={key}
					data-markdown-table=""
					data-markdown-table-compact-last={compactLast ? '' : undefined}
				>
					<table>
						<thead>
							<tr>
								{tableToken.header.map((cell, index) =>
									renderTableCell(cell, index, 'th', options),
								)}
							</tr>
						</thead>
						<tbody>
							{tableToken.rows.map((row, rowIndex) => (
								<tr key={rowIndex}>
									{row.map((cell, cellIndex) =>
										renderTableCell(cell, cellIndex, 'td', options),
									)}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)
		}
		case 'strong':
			return <strong key={key}>{renderTokens(token.tokens, options)}</strong>
		case 'em':
			return <em key={key}>{renderTokens(token.tokens, options)}</em>
		case 'del':
			return <del key={key}>{renderTokens(token.tokens, options)}</del>
		case 'codespan':
			return <code key={key}>{token.text}</code>
		case 'br':
			return <br key={key} />
		case 'escape':
			return token.text
		case 'link':
			return renderLink(
				key,
				token.href,
				renderTokens(token.tokens, options),
				options,
			)
		case 'image': {
			const imageSrc = resolveMarkdownImageSrc(token.href, options)
			if (imageSrc) {
				return <img key={key} src={publicAsset(imageSrc)} alt={token.text} />
			}
			// Remote / unsafe hrefs stay links (or plain text). Auto-loading
			// author-chosen URLs is exactly what this renderer exists to prevent.
			return renderLink(key, token.href, token.text || token.href, options)
		}
		case 'html':
			// Comment-only tokens carry author/agent notes (guides embed agent
			// steering in HTML comments); showing them as literal text would
			// leak scaffolding into the page, so they render as nothing under
			// every policy. Other raw HTML stays escaped literal text so
			// authors see their markup but it never becomes part of the
			// document.
			if (isHtmlCommentOnly(token.raw)) return null
			return token.raw
		case 'text': {
			const textToken = token as Tokens.Text
			if (textToken.tokens?.length) {
				return <span key={key}>{renderTokens(textToken.tokens, options)}</span>
			}
			return decodeCharacterReferences(textToken.text)
		}
		default:
			// marked's token union is open (extensions add types), so exhaustive
			// `never` checking is impossible; fall back to escaped raw text.
			return typeof token.raw === 'string' ? token.raw : null
	}
}

function renderTokens(
	tokens: Array<Token> | undefined,
	options: ResolvedRenderOptions,
): Array<ReactNode> {
	if (!tokens) return []
	const resolved =
		options.linkPolicy === 'first-party'
			? coalesceFirstPartyDetails(tokens, lexer)
			: tokens
	return resolved.map((token, index) => renderToken(token, index, options))
}

function takeFence(
	options: ResolvedRenderOptions,
	code: string,
	lang: string | null | undefined,
): HighlightedCode {
	const next = options.fences[options.fenceCursor.index]
	options.fenceCursor.index += 1
	if (next && next.code === code) return next
	return plainHighlightedCode(code, lang)
}

/** Parses untrusted markdown and returns safe JSX (see module docs). */
export function renderMarkdownNodes(
	markdown: string,
	options?: RenderMarkdownOptions,
): Array<ReactNode> {
	return renderTokens(lexer(markdown), {
		...defaultRenderOptions,
		...options,
		fences: options?.fences ?? defaultRenderOptions.fences,
		fenceCursor: { index: 0 },
		headingSlugCounts: new Map(),
	})
}

const firstPartyCalloutBoxCss = {
	margin: '0 0 1.4rem',
	maxWidth: '62ch',
	'& > strong': {
		fontSize: '0.92rem',
		color: colors.text,
	},
	'& > p': {
		margin: 0,
		color: colors.text,
	},
} satisfies CSSObject

const firstPartyDetailsCss = {
	...nativeDisclosureCss,
	margin: '1.4rem 0 0',
	maxWidth: '62ch',
} satisfies CSSObject
