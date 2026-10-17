/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { type CSSProperties } from 'react'
import { type DocsConnectLoaderData } from '#universal/loader-data.ts'
import { docHref } from '#universal/docs-nav.ts'
import { colors } from '#universal/styles/tokens.ts'
import {
	articleMeasure,
	pageHeadCss,
} from '#universal/styles/style-primitives.ts'
import { SiteLink } from '../components/site-link.tsx'
import {
	docListCss,
	docsGroupHeadingCss,
	renderDocListItem,
	renderDocsShell,
} from './docs-shell.tsx'
export function DocsConnectRoute({
	data,
	isAdmin,
}: {
	data: DocsConnectLoaderData
	isAdmin: boolean
}) {
	const guides = data.guides
	return renderDocsShell({
		current: 'connect',
		isAdmin,
		children: (
			<section css={connectPageCss}>
				<header css={connectHeadCss}>
					<p data-rise style={{ '--rise': '0' } as CSSProperties}>
						Docs
					</p>
					<h1
						data-docs-heading
						tabIndex={-1}
						data-rise
						style={{ '--rise': '1' } as CSSProperties}
					>
						Connect a provider
					</h1>
					<p data-rise style={{ '--rise': '2' } as CSSProperties}>
						How to connect Discord, GitHub, Google, Notion, Origin, Salesforce,
						Slack, or Spotify to Kody. Each walkthrough is verified against the
						real console — append <code>.md</code> to hand it to your agent.
					</p>
					<p data-rise style={{ '--rise': '3' } as CSSProperties}>
						Provider not listed? Follow{' '}
						<SiteLink href={docHref('integration-bootstrap')}>
							Integration bootstrap
						</SiteLink>{' '}
						and{' '}
						<SiteLink href={docHref('oauth')}>
							OAuth (bring your own app)
						</SiteLink>
						, or store a key with{' '}
						<SiteLink href={docHref('secret-backed-integration')}>
							Secret-backed integrations
						</SiteLink>
						.
					</p>
				</header>

				{guides !== null ? (
					<>
						<section>
							<h2 css={docsGroupHeadingCss}>Providers</h2>
							<ul css={docListCss}>
								{guides.map((guide, index) => renderDocListItem(guide, index))}
							</ul>
						</section>
						<section>
							<h2 css={docsGroupHeadingCss}>Related</h2>
							<ul css={docListCss}>
								<li data-rise style={{ '--rise': '2' } as CSSProperties}>
									<SiteLink
										href={docHref('local-mcp-tunnels')}
										css={relatedLinkCss}
									>
										<strong>Connect a home MCP server</strong>
										<span css={relatedSummaryCss}>
											Run a local MCP process (vault, CLI, or home devices) and
											connect it to Kody.
										</span>
									</SiteLink>
								</li>
								<li data-rise style={{ '--rise': '3' } as CSSProperties}>
									<SiteLink
										href={docHref('locked-mcp-server')}
										css={relatedLinkCss}
									>
										<strong>Lock an MCP server to a package</strong>
										<span css={relatedSummaryCss}>
											Keep a connected server's tools off execute and other
											packages.
										</span>
									</SiteLink>
								</li>
							</ul>
						</section>
					</>
				) : null}
			</section>
		),
	})
}

const connectPageCss = {
	maxWidth: articleMeasure,
	minWidth: 0,
	padding: 'clamp(2.5rem, 6vw, 4rem) 0 clamp(4rem, 8vw, 6.5rem)',
} satisfies CSSObject

const connectEyebrowCss = {
	fontSize: '0.8rem',
	fontWeight: 650,
	letterSpacing: '0.08em',
	textTransform: 'uppercase' as const,
	color: colors.primaryText,
} satisfies CSSObject

const connectHintCss = {
	fontSize: '0.95rem',
	color: colors.textMuted,
	maxWidth: '58ch',
} satisfies CSSObject

const connectHeadCss = {
	...pageHeadCss,
	textAlign: 'left' as const,
	'& h1': {
		...pageHeadCss['& h1'],
		margin: '0.6rem 0 0',
		fontSize: 'clamp(2.1rem, 5vw, 3rem)',
	},
	'& > p': {
		...pageHeadCss['& > p'],
		margin: '1rem 0 0',
	},
	'& > p:first-of-type': connectEyebrowCss,
	'& > p:last-of-type': connectHintCss,
	'& a': {
		color: colors.primaryText,
		textDecoration: 'underline',
		textUnderlineOffset: '0.15em',
	},
} satisfies CSSObject

const relatedLinkCss = {
	display: 'block',
	padding: '1.05rem 0',
	textDecoration: 'none',
	color: 'inherit',
	'& strong': {
		fontSize: '1.08rem',
		fontWeight: 700,
		letterSpacing: '-0.012em',
		color: colors.primaryText,
	},
} satisfies CSSObject

const relatedSummaryCss = {
	display: 'block',
	marginTop: '0.35rem',
	color: colors.textMuted,
	fontSize: '0.95rem',
	lineHeight: 1.5,
	maxWidth: '62ch',
} satisfies CSSObject
