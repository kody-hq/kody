/** @jsxImportSource @emotion/react */
import { SiteLink } from '../components/site-link.tsx'
import { type CSSObject } from '@emotion/react'
import {
	caseStudies,
	caseStudyAttribution,
	type CaseStudy,
} from '#universal/case-studies.ts'
import { routes } from '#universal/routes.ts'
import {
	articleMeasure,
	pageGutter,
	pageHeadCss,
} from '#universal/styles/style-primitives.ts'
import { colors } from '#universal/styles/tokens.ts'

/**
 * Case studies index. Mirrors the case-studies blog post (`early-kody-users`)
 * so `/case-studies` and deep links like `#maciek-sitkowski` stay live.
 * Section `id`s match homepage carousel `storyAnchor` values; the carousel
 * links to the blog as the long-form home.
 */

export function CaseStudiesRoute() {
	return (
		<article css={pageCss}>
			<header css={headCss}>
				<h1>Case studies</h1>
				<p>
					Longer notes from people using Kody — how it shows up in their work,
					in their words. The same stories also live on the{' '}
					<SiteLink href={routes.blogPost.href({ slug: 'early-kody-users' })}>
						case studies blog post
					</SiteLink>
					.
				</p>
			</header>

			<div css={listCss}>
				{caseStudies.map((study: CaseStudy) => {
					const attribution = caseStudyAttribution(study)
					return (
						<section key={study.id} css={studyCss}>
							<h2 id={study.id} css={studyTitleCss}>
								{study.href ? (
									<SiteLink href={study.href} css={nameLinkCss}>
										{study.name}
									</SiteLink>
								) : (
									study.name
								)}
							</h2>
							{attribution ? <p css={attributionCss}>{attribution}</p> : null}
							<blockquote css={quoteCss}>
								{study.body.split(/\n\n+/).map((paragraph) => (
									<p key={paragraph.slice(0, 48)}>{paragraph}</p>
								))}
							</blockquote>
						</section>
					)
				})}
			</div>

			<p css={footCss}>
				<SiteLink href={routes.home.href()} css={backLinkCss}>
					← Home
				</SiteLink>
			</p>
		</article>
	)
}

const pageCss: CSSObject = {
	maxWidth: articleMeasure,
	marginInline: 'auto',
	padding: `clamp(2.5rem, 6vw, 4rem) ${pageGutter} clamp(4rem, 8vw, 6.5rem)`,
}

const headCss: CSSObject = {
	...pageHeadCss,
	'& h1': {
		margin: 0,
		fontSize: 'clamp(2.1rem, 5vw, 3rem)',
		fontWeight: 760,
		letterSpacing: '-0.028em',
		lineHeight: 1.06,
		textWrap: 'balance' as const,
	},
	'& > p': {
		margin: '0.85rem 0 0',
		maxWidth: '36rem',
		fontSize: '1.05rem',
		lineHeight: 1.55,
		color: colors.textMuted,
		'& a': {
			color: colors.primaryText,
			textDecoration: 'none',
			fontWeight: 550,
			'&:hover': {
				color: colors.text,
			},
		},
	},
}

const listCss: CSSObject = {
	marginTop: 'clamp(2.5rem, 6vw, 3.5rem)',
	display: 'grid',
	gap: 'clamp(2.5rem, 5vw, 3.5rem)',
}

const studyCss: CSSObject = {
	margin: 0,
}

const studyTitleCss: CSSObject = {
	margin: '0 0 0.35rem',
	fontSize: '1.55rem',
	fontWeight: 700,
	letterSpacing: '-0.02em',
	lineHeight: 1.2,
	scrollMarginTop: '5rem',
}

const nameLinkCss: CSSObject = {
	color: 'inherit',
	textDecoration: 'none',
	'&:hover': {
		color: colors.primaryText,
	},
}

const attributionCss: CSSObject = {
	margin: '0 0 1rem',
	fontSize: '1rem',
	lineHeight: 1.5,
	color: colors.textMuted,
}

const quoteCss: CSSObject = {
	margin: 0,
	padding: 0,
	border: 'none',
	'& > p': {
		margin: 0,
		fontSize: '1.05rem',
		lineHeight: 1.65,
		color: colors.text,
	},
	'& > p + p': {
		marginTop: '1rem',
	},
}

const footCss: CSSObject = {
	marginTop: 'clamp(2.5rem, 6vw, 3.5rem)',
}

const backLinkCss: CSSObject = {
	fontSize: '0.95rem',
	fontWeight: 550,
	color: colors.primaryText,
	textDecoration: 'none',
	'&:hover': {
		color: colors.text,
	},
}
