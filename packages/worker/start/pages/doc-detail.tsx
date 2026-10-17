/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'
import { renderMcpEventsFlagCallout } from './mcp-events-flag-callout.tsx'
import { renderPackageSkillsFlagCallout } from './package-skills-flag-callout.tsx'
import { isFeatureFlagEnabled } from '#client/feature-flags.ts'
import {
	mcpEventsExtensionFlagKey,
	mcpSkillsExtensionFlagKey,
} from '#universal/feature-flags/registry.ts'
import { type CSSObject } from '@emotion/react'
import { type CSSProperties, type ReactNode, useMemo } from 'react'
import { type HighlightedCode } from '#universal/highlighted-code.ts'
import { type DocDetailLoaderData } from '#universal/loader-data.ts'
import { type WalkthroughHostPick } from '#universal/walkthrough-hosts.ts'
import { type SessionInfo } from '#client/session.ts'
import { routes } from '#universal/routes.ts'
import { findDocsNavSection } from '#universal/docs-nav.ts'
import { extractDocWatchMarkdown } from '#universal/doc-youtube.ts'
import { userHasRole } from '#universal/permissions.ts'
import { colors, radius } from '#universal/styles/tokens.ts'
import {
	articleMeasure,
	pageHeadCss,
	proseCss,
} from '#universal/styles/style-primitives.ts'
import { renderMarkdownNodes } from '../components/markdown-view.tsx'
import { SiteLink } from '../components/site-link.tsx'
import {
	formatLastVerified,
	renderDocsPager,
	renderDocsShell,
} from './docs-shell.tsx'
import { HowKodyWorksWalkthrough } from './how-kody-works-walkthrough.tsx'
import { renderGoogleOauthWalkthrough } from './google-oauth-walkthrough.tsx'
const interactiveDocRenderers: Readonly<
	Record<
		string,
		(
			highlights?: Record<string, HighlightedCode>,
			hosts?: WalkthroughHostPick,
		) => ReactNode
	>
> = {
	'how-kody-works': (highlights, hosts) => (
		<HowKodyWorksWalkthrough highlights={highlights} hosts={hosts} />
	),
	'google-oauth': (highlights) => renderGoogleOauthWalkthrough(highlights),
}

function stripLeadingH1(body: string): string {
	return body.replace(/^# [^\n]*\n+/, '')
}

function describeDoc(doc: DocDetailLoaderData): string {
	if (doc.lastVerified) {
		return `Verified against the ${doc.provider ?? 'provider'} console, ${formatLastVerified(doc.lastVerified)}`
	}
	if (doc.audience === 'agents') {
		return 'Agent playbook — written for the agent connected to your account; you can read along'
	}
	return 'Official Kody doc'
}

const options = {
	headingOffset: 0,
	linkRel: 'noopener noreferrer',
	linkPolicy: 'first-party' as const,
	copyCodeBlocks: true,
	headingIds: true,
}

export function DocDetailRoute({
	doc,
	session,
}: {
	doc: DocDetailLoaderData
	session: SessionInfo | null
}) {
	const slug = doc.slug
	const isAdmin = Boolean(session && userHasRole(session, 'admin'))

	const renderedBody = useMemo(
		() =>
			renderMarkdownNodes(stripLeadingH1(doc.body), {
				...options,
				fences: doc.bodyFences,
			}),
		[doc.body, doc.bodyFences],
	)
	const watch = useMemo(
		() =>
			interactiveDocRenderers[doc.slug]
				? renderMarkdownNodes(
						extractDocWatchMarkdown(stripLeadingH1(doc.body)) ?? '',
						options,
					)
				: [],
		[doc.slug, doc.body],
	)
	return renderDocsShell({
		current: slug,
		isAdmin,
		children: (
			<article css={docPageCss}>
				<header css={docHeadCss}>
					<p
						data-rise
						style={{ '--rise': '0' } as CSSProperties}
						css={docEyebrowCss}
					>
						{doc.category === 'provider' ? (
							<SiteLink href={routes.docsConnect.href()}>
								Connect a provider
							</SiteLink>
						) : (
							(findDocsNavSection(doc.slug)?.label ?? 'Docs')
						)}
					</p>
					<h1
						data-docs-heading
						tabIndex={-1}
						data-rise
						style={{ '--rise': '1' } as CSSProperties}
					>
						{doc.title}
					</h1>
					<p
						data-rise
						style={{ '--rise': '2' } as CSSProperties}
						css={docMetaCss}
					>
						{describeDoc(doc)}
					</p>
				</header>
				{doc.slug === 'mcp-events'
					? renderMcpEventsFlagCallout({
							loggedIn: Boolean(session),
							enabled: isFeatureFlagEnabled(session, mcpEventsExtensionFlagKey),
						})
					: null}
				{doc.slug === 'package-skills'
					? renderPackageSkillsFlagCallout({
							loggedIn: Boolean(session),
							enabled: isFeatureFlagEnabled(session, mcpSkillsExtensionFlagKey),
						})
					: null}

				{doc.image && doc.imageAlt ? (
					<img
						src={publicAsset(doc.image)}
						alt={doc.imageAlt}
						width={1024}
						height={1024}
						loading="eager"
						decoding="async"
						data-rise
						style={{ '--rise': '3' } as CSSProperties}
						css={docImageCss}
					/>
				) : null}

				{watch.length ? <div css={docProseCss}>{watch}</div> : null}

				{interactiveDocRenderers[doc.slug]?.(
					doc.walkthroughHighlights,
					doc.walkthroughHosts,
				) ?? <div css={docProseCss}>{renderedBody}</div>}

				{renderDocsPager(doc.slug, isAdmin)}

				<footer css={docFootCss}>
					<p>
						Working with an agent? This page is also plain markdown at{' '}
						<SiteLink
							href={routes.docDetailMarkdown.href({ slug: doc.slug })}
							data-rmx-document
						>
							/docs/{doc.slug}.md
						</SiteLink>
						, or load it over MCP with{' '}
						<code>{`search({ entity: 'guide:${doc.id}' })`}</code>.
					</p>
				</footer>
			</article>
		),
	})
}

/* Blog post rhythm on the 43rem measure. */

// Tables scroll inside the article column; the sidebar leaves no room for
// the blog's viewport-centered breakout.
const docProseCss = proseCss

const docPageCss = {
	maxWidth: articleMeasure,
	minWidth: 0,
	padding: 'clamp(2.5rem, 6vw, 4rem) 0 clamp(4rem, 8vw, 6.5rem)',
} satisfies CSSObject

const docEyebrowCss = {
	margin: 0,
	fontSize: '0.8rem',
	fontWeight: 650,
	letterSpacing: '0.08em',
	textTransform: 'uppercase' as const,
	color: colors.primaryText,
	'& a': {
		color: 'inherit',
		textDecoration: 'none',
	},
} satisfies CSSObject

const docHeadCss = {
	position: 'relative' as const,
	isolation: 'isolate' as const,
	'&::before': {
		...pageHeadCss['&::before'],
		inset: '-90% -30% -250%',
		background: `radial-gradient(ellipse 46% 55% at 70% 30%, oklch(from ${colors.text} l c h / 0.05), transparent 72%)`,
	},
	'& h1': {
		margin: '0.6rem 0 0',
		fontSize: 'clamp(2.1rem, 5vw, 3rem)',
		fontWeight: 760,
		letterSpacing: '-0.028em',
		lineHeight: 1.06,
		textWrap: 'balance' as const,
	},
	'& > p + p': {
		marginTop: '0.9rem',
	},
} satisfies CSSObject

const docMetaCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.88rem',
	'& a': {
		color: colors.primaryText,
	},
} satisfies CSSObject

const docImageCss = {
	display: 'block',
	width: '100%',
	height: 'auto',
	margin: 'clamp(1.5rem, 4vw, 2.2rem) 0 clamp(2rem, 5vw, 3rem)',
	borderRadius: radius.card,
	border: `1px solid ${colors.border}`,
} satisfies CSSObject

const docFootCss = {
	marginTop: 'clamp(2rem, 5vw, 3rem)',
	paddingTop: 'clamp(1.8rem, 4vw, 2.5rem)',
	borderTop: `1px solid ${colors.border}`,
	'& p': {
		margin: 0,
		color: colors.textMuted,
		fontSize: '0.95rem',
	},
	'& a': {
		color: colors.primaryText,
	},
} satisfies CSSObject
