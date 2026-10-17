/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { type CSSProperties } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { type CommunityIndexLoaderData } from '#universal/loader-data.ts'
import { landingArtAttrs } from '../public-assets.ts'
import { routes } from '#universal/routes.ts'
import { colors, transitions, typography } from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
import { mergeCss } from '../components/merge-css.ts'
import { EntityExplainer, resolveEntityExplainer } from './entity-explainer.tsx'
import { CommunityListingsContent } from '../components/community-listings-content.tsx'
import { SiteLink } from '../components/site-link.tsx'
export function CommunityRoute({ data }: { data: CommunityIndexLoaderData }) {
	const { query: searchQuery, sort, category } = data
	const explainer = resolveEntityExplainer('community')
	const navigate = useNavigate()
	return (
		<section css={communityPageCss}>
			<header css={communityHeadCss}>
				<div>
					<div css={communityTitleRowCss}>
						<h1
							data-rise
							style={{ '--rise': '0' } as CSSProperties}
							css={headTitleCss}
						>
							Take what others
							<br />
							built. <em>Make it yours.</em>
						</h1>
						{explainer ? <EntityExplainer copy={explainer} /> : null}
					</div>
					<p
						data-rise
						style={{ '--rise': '1' } as CSSProperties}
						css={headSubCss}
					>
						Browse packages shared by Kody users. Fork with your agent and adapt
						them to your goals.
					</p>
					<form
						data-rise
						data-focus-container
						style={{ '--rise': '2' } as CSSProperties}
						role="search"
						method="get"
						action={routes.community.href()}
						onSubmit={(event) => {
							event.preventDefault()
							const values = new FormData(event.currentTarget)
							const query = new URLSearchParams()
							for (const [key, value] of values)
								if (typeof value === 'string') query.append(key, value)
							void navigate({ to: `/community?${query}` })
						}}
						css={searchPillCss}
					>
						<label htmlFor="pkg-q" css={visuallyHiddenCss}>
							Search public packages
						</label>
						<input
							id="pkg-q"
							key={`${searchQuery}:${sort}:${category ?? ''}`}
							type="search"
							name="q"
							defaultValue={searchQuery ?? ''}
							placeholder="Search by name, description, or tags"
							css={searchInputCss}
						/>
						{sort === 'newest' ? (
							<input type="hidden" name="sort" value="newest" />
						) : null}
						{category ? (
							<input type="hidden" name="category" value={category} />
						) : null}
						<button type="submit" css={getPillButtonCss()}>
							Search
						</button>
					</form>
				</div>
				<img
					data-rise
					style={{ '--rise': '2' } as CSSProperties}
					{...landingArtAttrs('kody-community-packages')}
					width={480}
					height={480}
					alt="Kody handing a wrapped package across a counter of neatly sorted parcels"
					css={communityArtCss}
				/>
			</header>

			<CommunityListingsContent {...data} />

			<div css={communityCloseCss}>
				<p>
					Built something useful? Ask your agent to publish it back — every fork
					keeps its own history, and ratings come only from people who actually
					ran it.
				</p>
				<SiteLink href={routes.onboarding.href()} css={closeButtonCss}>
					Connect your agent
				</SiteLink>
			</div>
		</section>
	)
}

/* The route owns its gutters — the app shell leaves redesigned marketing
   paths unpadded. 72rem browse measure. */
const communityPageCss = {
	maxWidth: '72rem',
	marginInline: 'auto',
	width: '100%',
	boxSizing: 'border-box' as const,
	padding:
		'clamp(3rem, 7vw, 5rem) clamp(1.25rem, 4vw, 2.5rem) clamp(4rem, 8vw, 6.5rem)',
} satisfies CSSObject

/* Split head: browse pages earn Kody at their side, not overhead. The
   shirt-pattern whisper drifts toward the mascot. */
const communityHeadCss = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1fr) clamp(150px, 22vw, 230px)',
	gap: 'clamp(1.5rem, 4vw, 3.5rem)',
	alignItems: 'center',
	position: 'relative' as const,
	// See `pageHeadCss`: the fabric is a backdrop, so it paints under the head.
	isolation: 'isolate' as const,
	'&::before': {
		content: '""',
		position: 'absolute' as const,
		zIndex: -1,
		inset: '-55% -14% -35%',
		background: `radial-gradient(ellipse 40% 65% at 82% 45%, oklch(from ${colors.text} l c h / 0.055), transparent 72%)`,
		maskImage: 'var(--kody-pattern)',
		maskPosition: 'center',
		maskSize: '340px',
		maskRepeat: 'repeat',
		WebkitMaskImage: 'var(--kody-pattern)',
		WebkitMaskPosition: 'center',
		WebkitMaskSize: '340px',
		WebkitMaskRepeat: 'repeat',
		pointerEvents: 'none' as const,
	},
	'@media (max-width: 720px)': {
		gridTemplateColumns: '1fr',
		textAlign: 'center' as const,
	},
} satisfies CSSObject

const communityTitleRowCss = {
	display: 'flex',
	alignItems: 'center',
	gap: '0.15rem',
	minWidth: 0,
	'@media (max-width: 720px)': {
		justifyContent: 'center',
	},
} satisfies CSSObject

const headTitleCss = {
	margin: 0,
	fontSize: 'clamp(2.4rem, 5vw, 3.4rem)',
	fontWeight: 760,
	letterSpacing: '-0.028em',
	lineHeight: 1.04,
	'& em': {
		fontStyle: 'normal',
		color: colors.primaryText,
	},
} satisfies CSSObject

const headSubCss = {
	margin: '1rem 0 0',
	color: colors.textMuted,
	fontSize: '1.08rem',
	maxWidth: '46ch',
	textWrap: 'balance' as const,
	'@media (max-width: 720px)': {
		marginInline: 'auto',
	},
} satisfies CSSObject

/* Search: connected-pill grammar, one field + one verb. */
const searchPillCss = {
	marginTop: '1.8rem',
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1fr) auto',
	alignItems: 'stretch',
	width: 'min(100%, 34rem)',
	backgroundColor: colors.surface,
	border: `1.5px solid ${colors.border}`,
	borderRadius: '999px',
	padding: '0.3rem',
	transition: `border-color 160ms ${transitions.easeOut}, box-shadow 160ms ${transitions.easeOut}`,
	'&:focus-within': {
		borderColor: colors.primary,
		boxShadow: `0 0 0 3px oklch(from ${colors.primary} l c h / 0.25)`,
	},
	'@media (max-width: 720px)': {
		marginInline: 'auto',
	},
} satisfies CSSObject

const searchInputCss = {
	font: `400 1rem/1.2 ${typography.fontFamilyBody}`,
	color: colors.text,
	backgroundColor: 'transparent',
	border: 'none',
	borderRadius: '999px',
	padding: '0.7rem 1.1rem',
	minWidth: 0,
	'&::placeholder': { color: colors.textMuted, opacity: 1 },
	'&:focus': { outline: 'none' },
	'&::-webkit-search-cancel-button': { WebkitAppearance: 'none' },
} satisfies CSSObject

const communityArtCss = {
	width: '100%',
	height: 'auto',
	'@media (max-width: 720px)': {
		width: 'min(52%, 210px)',
		marginInline: 'auto',
		order: -1,
	},
} satisfies CSSObject

/* Publish close: the community runs on forks coming back. */
const communityCloseCss = {
	marginTop: 'clamp(3rem, 7vw, 4.5rem)',
	paddingTop: 'clamp(1.8rem, 4vw, 2.5rem)',
	borderTop: `1px solid ${colors.border}`,
	display: 'flex',
	alignItems: 'center',
	gap: '1.2rem',
	flexWrap: 'wrap' as const,
	'& > p': {
		flex: 1,
		minWidth: 0,
		margin: 0,
		color: colors.textMuted,
		fontSize: '0.98rem',
	},
} satisfies CSSObject

const closeButtonCss = mergeCss(getGhostButtonCss(), {
	fontSize: '0.95rem',
	padding: '0.8rem 1.35rem',
})
