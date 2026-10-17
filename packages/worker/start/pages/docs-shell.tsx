/** @jsxImportSource @emotion/react */
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { SiteLink } from '../components/site-link.tsx'
import { type CSSObject } from '@emotion/react'
import { mergeCss } from '../components/merge-css.ts'
import { type ReactNode, type CSSProperties, useEffect, useRef } from 'react'
import { type DocSummaryLoaderData } from '#universal/loader-data.ts'
import {
	docHref,
	docsCurrentPageLabel,
	findDocsNavNeighbors,
	resolveDocsNavSection,
	visibleDocsNav,
	type DocsNavSection,
} from '#universal/docs-nav.ts'
import { renderIcon } from '../components/icon.tsx'
import { routes } from '#universal/routes.ts'
import { colors, mq, transitions } from '#universal/styles/tokens.ts'
import {
	hoverMq,
	layoutMaxWidths,
	pageGutter,
} from '#universal/styles/style-primitives.ts'

/**
 * Two-column docs shell: a sticky sidebar with the whole reading order
 * (`#universal/docs-nav.ts`) and the article column. Below the tablet
 * breakpoint the sidebar collapses into a native `<details>` menu above the
 * article so the page needs no JS to browse.
 *
 * `current` is the doc slug being read, or `'connect'` on the provider
 * index. Sidebar labels are the short nav labels; page titles stay in the
 * article.
 */
export function renderDocsShell(input: {
	current: string
	children: ReactNode
	isAdmin?: boolean
}) {
	return <DocsShell {...input} />
}
function DocsShell(input: {
	current: string
	children: ReactNode
	isAdmin?: boolean
}) {
	const menuRef = useRef<HTMLDetailsElement>(null)
	const href = useMatchedPageScope().pageLocation.href
	useEffect(() => {
		if (menuRef.current) menuRef.current.open = false
	}, [href])
	const { current, children } = input
	const isAdmin = input.isAdmin === true
	const currentSection = resolveDocsNavSection(current)
	return (
		<div data-docs-shell css={docsLayoutCss}>
			<aside data-docs-nav css={docsSidebarCss}>
				<nav aria-label="Docs" css={docsSidebarNavCss}>
					{renderDocsNavSections(current, currentSection, isAdmin)}
				</nav>
			</aside>
			<details css={docsMobileMenuCss} ref={menuRef}>
				<summary>
					{renderIcon('menu', { size: '1.05em' })}
					<span>Docs</span>
					<span css={docsMobileMenuCurrentCss}>
						{docsCurrentPageLabel(current)}
					</span>
				</summary>
				<nav aria-label="Docs" css={docsSidebarNavCss}>
					{renderDocsNavSections(current, currentSection, isAdmin)}
				</nav>
			</details>
			<div css={docsMainCss}>{children}</div>
		</div>
	)
}

function renderDocsNavSections(
	current: string,
	currentSection: DocsNavSection | null,
	isAdmin: boolean,
) {
	return visibleDocsNav(isAdmin).map((section) => (
		<section
			key={section.id}
			css={docsNavSectionCss}
			data-docs-admin-nav={section.adminOnly ? 'true' : undefined}
		>
			<h2>
				{section.id === 'providers' ? (
					<SiteLink
						preload="render"
						href={routes.docsConnect.href()}
						aria-current={current === 'connect' ? 'page' : undefined}
					>
						{section.label}
					</SiteLink>
				) : (
					section.label
				)}
			</h2>
			<ul>
				{section.items.map((item) => (
					<li key={item.slug}>
						<SiteLink
							preload="render"
							href={docHref(item.slug)}
							aria-current={item.slug === current ? 'page' : undefined}
							data-section-current={
								currentSection?.id === section.id ? 'true' : undefined
							}
						>
							{item.label}
						</SiteLink>
					</li>
				))}
			</ul>
		</section>
	))
}

/** Previous / next links in reading order for the foot of an article. */
export function renderDocsPager(slug: string, isAdmin = false) {
	const { prev, next } = findDocsNavNeighbors(slug, { includeAdmin: isAdmin })
	if (!prev && !next) return null
	return (
		<nav aria-label="Docs order" css={docsPagerCss}>
			{prev ? (
				<SiteLink
					preload="render"
					href={docHref(prev.slug)}
					css={docsPagerLinkCss}
				>
					<span>Previous</span>
					<strong>{prev.label}</strong>
				</SiteLink>
			) : null}
			{next ? (
				<SiteLink
					preload="render"
					href={docHref(next.slug)}
					css={docsPagerNextLinkCss}
				>
					<span>Next</span>
					<strong>{next.label}</strong>
				</SiteLink>
			) : null}
		</nav>
	)
}

export function formatLastVerified(lastVerified: string): string {
	const [year, month] = lastVerified.split('-')
	const monthIndex = Number(month) - 1
	const monthNames = [
		'January',
		'February',
		'March',
		'April',
		'May',
		'June',
		'July',
		'August',
		'September',
		'October',
		'November',
		'December',
	]
	const name = monthNames[monthIndex]
	if (!name || !year) return lastVerified
	return `${name} ${year}`
}

export function renderDocListItem(doc: DocSummaryLoaderData, index: number) {
	return (
		<li
			key={doc.slug}
			data-rise
			style={{ '--rise': String(index + 2) } as CSSProperties}
		>
			<SiteLink preload="render" href={docHref(doc.slug)} css={docListLinkCss}>
				<strong>{doc.title}</strong>
				{doc.lastVerified ? (
					<span css={docListMetaCss}>
						Verified {formatLastVerified(doc.lastVerified)}
					</span>
				) : null}
				<span css={docListSummaryCss}>{doc.summary}</span>
			</SiteLink>
		</li>
	)
}

const sidebarWidth = '15.5rem'
/** Hang so nav-link pills sit left of the section heading text. */
const docsNavLinkHang = '0.6rem'
/**
 * Global `:focus-visible` is 2.5px outline + 3px offset. `overflow-y: auto`
 * on the sidebar computes overflow-x to auto, which would clip that ring and
 * the hanging pills. Keep this much extra padding on the scroller.
 */
const docsNavFocusGutter = '8px'
const docsNavScrollerInset = `calc(${docsNavLinkHang} + ${docsNavFocusGutter})`

const docsLayoutCss = {
	display: 'grid',
	gridTemplateColumns: `${sidebarWidth} minmax(0, 1fr)`,
	columnGap: 'clamp(2rem, 4vw, 3.5rem)',
	alignItems: 'start',
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	paddingInline: pageGutter,
	// Clicked sidebar links would otherwise become the scroll anchor; replacing
	// the article then fights scroll restoration and the rail/content bump.
	overflowAnchor: 'none' as const,
	[mq.tablet]: {
		display: 'block',
	},
} satisfies CSSObject

const docsSidebarCss = {
	position: 'sticky' as const,
	// The sticky site header is ~4rem tall; keep the sidebar just under it.
	top: '4.5rem',
	maxHeight: 'calc(100vh - 5.5rem)',
	overflowY: 'auto' as const,
	overflowAnchor: 'none' as const,
	paddingBlock: 'clamp(2.5rem, 6vw, 4rem) 2rem',
	paddingLeft: docsNavScrollerInset,
	paddingRight: '0.5rem',
	borderRight: `1px solid ${colors.border}`,
	scrollbarWidth: 'thin' as const,
	// Lift out of `<main>` / `page` if a view transition still starts.
	// Intra-docs clicks skip VT; leaving docs fades this name (styles.css).
	viewTransitionName: 'docs-nav',
	[mq.tablet]: {
		display: 'none',
	},
} satisfies CSSObject

const docsSidebarNavCss = {
	display: 'grid',
	gap: '1.35rem',
	fontSize: '0.92rem',
} satisfies CSSObject

const docsNavSectionCss = {
	'& h2': {
		margin: '0 0 0.4rem',
		fontSize: '0.74rem',
		fontWeight: 700,
		letterSpacing: '0.08em',
		textTransform: 'uppercase' as const,
		color: colors.textMuted,
	},
	'& h2 a': {
		color: 'inherit',
		textDecoration: 'none',
	},
	'& h2 a[aria-current="page"]': {
		color: colors.primaryText,
	},
	'&:has(a[data-section-current]) h2': {
		color: colors.text,
	},
	'& ul': {
		listStyle: 'none',
		margin: 0,
		padding: 0,
		display: 'grid',
		gap: '0.1rem',
	},
	'& li a': {
		display: 'block',
		padding: `0.32rem ${docsNavLinkHang}`,
		marginLeft: `-${docsNavLinkHang}`,
		borderRadius: '0.45rem',
		color: colors.textMuted,
		textDecoration: 'none',
		lineHeight: 1.35,
		// Same weight for every item so the active highlight cannot reflow
		// the rail when aria-current moves.
		fontWeight: 650,
		overflowAnchor: 'none' as const,
		transition: `color ${transitions.fast}, background ${transitions.fast}`,
	},
	'& li a[aria-current="page"]': {
		color: colors.primaryText,
		background: colors.primarySoftest,
	},
	[hoverMq]: {
		'& li a:hover': {
			color: colors.text,
			background: colors.primarySoftest,
		},
	},
} satisfies CSSObject

const docsMobileMenuCss = {
	display: 'none',
	margin: 'clamp(1.5rem, 4vw, 2rem) 0 0',
	border: `1px solid ${colors.border}`,
	borderRadius: '0.75rem',
	background: colors.surface,
	'& > summary': {
		display: 'flex',
		alignItems: 'center',
		gap: '0.6rem',
		minHeight: '44px',
		padding: '0.7rem 1rem',
		cursor: 'pointer',
		fontWeight: 650,
		color: colors.text,
		listStyle: 'none',
	},
	'& > summary::-webkit-details-marker': { display: 'none' },
	'& > summary::marker': { content: '""' },
	'& > summary [data-icon]': {
		flex: 'none',
		color: colors.textMuted,
	},
	overflow: 'visible' as const,
	'& > nav': {
		paddingBlock: '0.4rem 0.7rem',
		paddingRight: '0.6rem',
		paddingLeft: docsNavScrollerInset,
		borderTop: `1px solid ${colors.border}`,
	},
	'& h2 a': {
		display: 'inline-flex',
		alignItems: 'center',
		minHeight: '44px',
	},
	'& li a': {
		display: 'flex',
		alignItems: 'center',
		minHeight: '44px',
		paddingBlock: '0.55rem',
	},
	[mq.tablet]: {
		display: 'block',
	},
} satisfies CSSObject

const docsMobileMenuCurrentCss = {
	color: colors.textMuted,
	fontWeight: 500,
	fontSize: '0.9rem',
} satisfies CSSObject

const docsMainCss = {
	minWidth: 0,
	overflowAnchor: 'none' as const,
} satisfies CSSObject

const docsPagerCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	justifyContent: 'space-between',
	gap: '1rem',
	marginTop: 'clamp(2.5rem, 6vw, 3.5rem)',
	[mq.mobile]: {
		flexDirection: 'column' as const,
	},
} satisfies CSSObject

const docsPagerLinkCss = {
	display: 'grid',
	gap: '0.25rem',
	padding: '0.9rem 1.1rem',
	border: `1px solid ${colors.border}`,
	borderRadius: '0.75rem',
	textDecoration: 'none',
	color: colors.text,
	transition: `border-color ${transitions.fast}`,
	'& span': {
		fontSize: '0.78rem',
		letterSpacing: '0.06em',
		textTransform: 'uppercase' as const,
		color: colors.textMuted,
	},
	'& strong': {
		fontWeight: 650,
		color: colors.primaryText,
	},
	[hoverMq]: {
		'&:hover': { borderColor: colors.primary },
	},
} satisfies CSSObject

const docsPagerNextLinkCss = mergeCss(docsPagerLinkCss, {
	marginInlineStart: 'auto',
	textAlign: 'right' as const,
	[mq.mobile]: {
		marginInlineStart: 0,
		textAlign: 'left' as const,
	},
})

export const docListCss = {
	listStyle: 'none',
	margin: '0.6rem 0 0',
	padding: 0,
	'& li + li': {
		borderTop: `1px solid ${colors.border}`,
	},
} satisfies CSSObject

const docListLinkCss = {
	display: 'block',
	padding: '1.05rem 0',
	textDecoration: 'none',
	color: 'inherit',
	'& strong': {
		fontSize: '1.08rem',
		fontWeight: 700,
		letterSpacing: '-0.012em',
		transition: `color ${transitions.fast}`,
	},
	[hoverMq]: {
		'&:hover strong': {
			color: colors.primaryText,
		},
	},
} satisfies CSSObject

const docListMetaCss = {
	marginLeft: '0.6rem',
	color: colors.textMuted,
	fontSize: '0.82rem',
} satisfies CSSObject

const docListSummaryCss = {
	display: 'block',
	marginTop: '0.35rem',
	color: colors.textMuted,
	fontSize: '0.95rem',
	lineHeight: 1.5,
	maxWidth: '62ch',
} satisfies CSSObject

export const docsGroupHeadingCss = {
	margin: 'clamp(2.4rem, 5vw, 3.2rem) 0 0',
	fontSize: '1.05rem',
	fontWeight: 720,
	letterSpacing: '0.04em',
	textTransform: 'uppercase' as const,
	color: colors.textMuted,
} satisfies CSSObject
