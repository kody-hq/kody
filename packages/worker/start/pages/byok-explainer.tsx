/** @jsxImportSource @emotion/react */
import {
	landingArtAttrs,
	publicAsset,
	publicAssetSrcSet,
} from '../public-assets.ts'
import { type CSSObject } from '@emotion/react'
import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
} from '#universal/styles/style-primitives.ts'

const kodyImages = {
	keys: {
		...landingArtAttrs('kody-keys'),
		alt: 'Kody the koala proudly holding a set of golden keys',
	},
	handoff: {
		src: '/images/kody-hands-you-the-key.webp',
		alt: 'Kody the koala handing a golden key to you',
	},
} as const

const chipCss: CSSObject = {
	padding: `${spacing.xs} ${spacing.sm}`,
	borderRadius: radius.full,
	border: `1px solid ${colors.border}`,
	fontSize: typography.fontSize.sm,
	whiteSpace: 'nowrap' as const,
}

const diagramRowCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.xs,
	flexWrap: 'wrap' as const,
	margin: 0,
}

const diagramLabelCss: CSSObject = {
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.medium,
	color: colors.textMuted,
	minWidth: '6.5rem',
}

const diagramArrowCss: CSSObject = {
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

function renderDiagramChip(
	label: string,
	tone: 'plain' | 'their' | 'yours' = 'plain',
) {
	return (
		<span
			css={{
				...chipCss,
				...(tone === 'their'
					? {
							textDecoration: 'line-through',
							color: colors.textMuted,
							borderStyle: 'dashed',
						}
					: {}),
				...(tone === 'yours'
					? {
							borderColor: colors.primary,
							backgroundColor: colors.primarySoftest,
							color: colors.primaryText,
							fontWeight: typography.fontWeight.medium,
						}
					: {}),
			}}
		>
			{label}
		</span>
	)
}

/**
 * "Bring your own keys" pitch. Shared with the integrations page so the
 * story stays consistent with onboarding.
 */
export function renderByokExplainer(options?: {
	image?: keyof typeof kodyImages
}) {
	const image = kodyImages[options?.image ?? 'keys']

	return (
		<section aria-label="Bring your own keys" css={cardCss}>
			<div
				css={{
					display: 'grid',
					gridTemplateColumns: 'minmax(8rem, 11rem) minmax(0, 1fr)',
					gap: spacing.lg,
					alignItems: 'start',
					[mq.mobile]: {
						gridTemplateColumns: '1fr',
						justifyItems: 'center',
					},
				}}
			>
				<img
					src={publicAsset(image.src)}
					srcSet={
						'srcSet' in image ? publicAssetSrcSet(image.srcSet) : undefined
					}
					sizes={'sizes' in image ? image.sizes : undefined}
					loading={'loading' in image ? image.loading : 'lazy'}
					decoding="async"
					alt={image.alt}
					width={640}
					height={640}
					css={{
						width: '100%',
						maxWidth: '11rem',
						height: 'auto',
						borderRadius: radius.lg,
						border: `1px solid ${colors.border}`,
					}}
				/>
				<div css={{ display: 'grid', gap: spacing.md }}>
					<div css={{ display: 'grid', gap: spacing.xs }}>
						<h2 css={cardTitleCss}>Bring your own keys</h2>
						<p css={descriptionCss}>
							You create the connection yourself, and your agent walks you
							through it, so it is completely yours: your app, your scopes, no
							middleman.
						</p>
					</div>
					<div css={{ display: 'grid', gap: spacing.xs }}>
						<p css={diagramRowCss}>
							<span css={diagramLabelCss}>Typical apps</span>
							{renderDiagramChip('You')}
							<span aria-hidden="true" css={diagramArrowCss}>
								→
							</span>
							{renderDiagramChip('Their shared app', 'their')}
							<span aria-hidden="true" css={diagramArrowCss}>
								→
							</span>
							{renderDiagramChip('GitHub')}
						</p>
						<p css={diagramRowCss}>
							<span css={diagramLabelCss}>Kody (BYO)</span>
							{renderDiagramChip('You')}
							<span aria-hidden="true" css={diagramArrowCss}>
								→
							</span>
							{renderDiagramChip('Your own app', 'yours')}
							<span aria-hidden="true" css={diagramArrowCss}>
								→
							</span>
							{renderDiagramChip('GitHub')}
						</p>
					</div>
					<ul
						css={{
							margin: 0,
							paddingLeft: spacing.lg,
							display: 'grid',
							gap: spacing.xs,
							color: colors.text,
						}}
					>
						<li>
							<strong>Your keys, your scopes.</strong> You decide exactly what
							Kody can touch, and you can revoke it anytime.
						</li>
						<li>
							<strong>Full control when you want it.</strong> Bring-your-own
							keeps nothing between you and the provider — your app, your
							scopes.
						</li>
						<li>
							<strong>No fixed list.</strong> If it has an API, your Kody can
							learn to use it.
						</li>
					</ul>
					<p css={descriptionCss}>
						Bring-your-own takes a few minutes of setup; your agent does the
						tedious parts.
					</p>
				</div>
			</div>
		</section>
	)
}
