/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'
import { dismissOpenPopoverPanel } from '#client/popover-open.ts'
import { type CSSObject } from '@emotion/react'
import { useEffect, useRef, useState } from 'react'
import { useLocation } from '@tanstack/react-router'
import { SiteLink } from './site-link.tsx'
import { renderIcon } from './icon.tsx'
import { colors, shadows, typography } from '#universal/styles/tokens.ts'
import {
	pageGutter,
	layoutMaxWidths,
} from '#universal/styles/style-primitives.ts'

const features = [
	{
		id: 'memory',
		orb: 'memory',
		name: 'Memory',
		description: 'Context that comes with you.',
	},
	{
		id: 'packages',
		orb: 'packages',
		name: 'Packages',
		description: 'Keep the software your agent builds.',
	},
	{
		id: 'triggers',
		orb: 'triggers',
		name: 'Triggers',
		description: 'Run work when something happens.',
	},
	{
		id: 'credentials',
		orb: 'integrations',
		name: 'Credentials',
		description: 'Keys and OAuth your agents use, never see.',
	},
	{
		id: 'apps',
		orb: 'apps',
		name: 'Apps',
		description: 'Give your work an interface.',
	},
] as const
const panelId = 'features-navigation'

type Props = { currentPathname: string; mobile?: boolean }

export function FeaturesMenu(props: Props) {
	const [open, setOpen] = useState(false)
	const panel = useRef<HTMLDivElement>(null)
	const mobile = useRef<HTMLDetailsElement>(null)
	const href = useLocation({ select: (location) => location.href })
	useEffect(() => {
		dismissOpenPopoverPanel(panel.current)
		if (mobile.current) mobile.current.open = false
	}, [href])

	function links() {
		return (
			<>
				<SiteLink
					href="/features"
					aria-current={
						props.currentPathname === '/features' ? 'page' : undefined
					}
					css={overviewCss}
				>
					<span>Explore all features</span>
					<span aria-hidden="true">↗</span>
				</SiteLink>
				<div css={gridCss}>
					{features.map((feature) => (
						<SiteLink
							key={feature.id}
							aria-label={feature.name}
							href={`/features/${feature.id}`}
							aria-current={
								props.currentPathname === `/features/${feature.id}`
									? 'page'
									: undefined
							}
							css={featureCss}
						>
							<img
								src={publicAsset(
									`/images/lantern/kody-primitives-orb-${feature.orb}.webp`,
								)}
								width="36"
								height="36"
								alt=""
							/>
							<span>
								<strong>{feature.name}</strong>
								<small>{feature.description}</small>
							</span>
						</SiteLink>
					))}
				</div>
			</>
		)
	}
	return props.mobile ? (
		<details ref={mobile} id="features-navigation-mobile" css={mobileCss}>
			<summary>
				Features{' '}
				<span aria-hidden="true">
					{renderIcon('chevron-down', { size: '1rem' })}
				</span>
			</summary>
			{links()}
		</details>
	) : (
		<div>
			<button
				type="button"
				popoverTarget={panelId}
				aria-expanded={open}
				aria-controls={panelId}
				data-current={
					props.currentPathname.startsWith('/features') ? '' : undefined
				}
				css={triggerCss}
			>
				Features{' '}
				<span
					aria-hidden="true"
					css={{
						display: 'inline-flex',
						rotate: open ? '180deg' : '0deg',
					}}
				>
					{renderIcon('chevron-down', { size: '0.85rem' })}
				</span>
			</button>
			<div
				id={panelId}
				ref={panel}
				popover="auto"
				aria-label="Features"
				css={panelCss}
				onToggle={(event) => setOpen(event.nativeEvent.newState === 'open')}
			>
				{links()}
			</div>
		</div>
	)
}

const triggerCss: CSSObject = {
	anchorName: '--features-navigation',
	display: 'inline-flex',
	alignItems: 'center',
	gap: '.4rem',
	padding: 0,
	minHeight: '44px',
	border: 0,
	background: 'none',
	cursor: 'pointer',
	font: `500 .98rem/1 ${typography.fontFamily}`,
	color: colors.textMuted,
	'&:hover, &[aria-expanded="true"], &[data-current]': { color: colors.text },
	'&:focus-visible': {
		outline: `2px solid ${colors.primaryText}`,
		outlineOffset: '5px',
		borderRadius: '.2rem',
	},
}
const panelCss: CSSObject = {
	position: 'fixed' as const,
	inset: 'auto',
	top: '4.5rem',
	left: `max(${pageGutter}, calc((100% - ${layoutMaxWidths.extended}) / 2 + ${pageGutter}))`,
	width: 'min(36rem, calc(100vw - 2.5rem))',
	maxHeight: 'calc(100dvh - 6rem)',
	overflowY: 'auto' as const,
	margin: 0,
	padding: '.6rem',
	boxSizing: 'border-box' as const,
	border: `1px solid ${colors.border}`,
	borderRadius: '1rem',
	background: colors.surface,
	color: colors.text,
	boxShadow: shadows.md,
	'@supports (anchor-name: --a)': {
		positionAnchor: '--features-navigation',
		top: 'anchor(bottom)',
		left: 'anchor(start)',
		marginTop: '.75rem',
		positionTryFallbacks: 'flip-inline',
	},
	'&:popover-open': { display: 'block' },
	'@media(max-width:820px)': {
		display: 'none',
		'&:popover-open': { display: 'none' },
	},
	'& a:focus-visible': {
		outline: `2px solid ${colors.primaryText}`,
		outlineOffset: '-2px',
	},
}
const overviewCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: '1rem',
	padding: '.85rem',
	textDecoration: 'none',
	color: colors.text,
	fontWeight: 600,
	borderRadius: '.6rem',
	'&:hover, &[aria-current]': {
		background: colors.primarySoftest,
		color: colors.primaryText,
	},
}
const gridCss: CSSObject = {
	display: 'grid',
	gridTemplateColumns: '1fr 1fr',
	gap: '.25rem',
	borderTop: `1px solid ${colors.border}`,
	paddingTop: '.5rem',
	marginTop: '.3rem',
}
const featureCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	gap: '.7rem',
	padding: '.85rem',
	borderRadius: '.6rem',
	textDecoration: 'none',
	color: colors.text,
	'& > span': { display: 'grid', gap: '.25rem' },
	'& img': { flexShrink: 0 },
	'& strong': { fontWeight: 600, fontSize: '.95rem' },
	'& small': { fontSize: '.8rem', lineHeight: 1.4, color: colors.textMuted },
	'&:hover, &[aria-current]': {
		background: colors.primarySoftest,
		color: colors.primaryText,
	},
}
const mobileCss: CSSObject = {
	'& summary': {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		minHeight: '44px',
		padding: '0 .85rem',
		fontWeight: 550,
		cursor: 'pointer',
		listStyle: 'none',
	},
	'& summary::-webkit-details-marker': { display: 'none' },
	'& summary > span': { display: 'inline-flex' },
	'&[open] summary > span': { rotate: '180deg' },
	'& small': { display: 'none' },
	'& img': { width: '26px', height: '26px' },
	'& a': { fontSize: '.9rem', minHeight: '44px' },
	'& summary:focus-visible': {
		outline: `2px solid ${colors.primaryText}`,
		outlineOffset: '-2px',
		borderRadius: '.5rem',
	},
}
