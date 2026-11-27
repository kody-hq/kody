/** @jsxImportSource @emotion/react */
import { useRouter } from '@tanstack/react-router'
import { Button } from '../../components/button.tsx'
import { renderIcon } from '../../components/icon.tsx'
import { useShellData } from '../../routes/__root.tsx'
import { orgBillingPath } from '#universal/org-pages.ts'
import {
	layoutMaxWidths,
	pageGutter,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { dismissBlackFriday, useBlackFridayCountdown } from './countdown.ts'
import {
	blackFridayCopy,
	blackFridayCountdownAttribute,
	blackFridayHiddenAttribute,
	blackFridayPrePaintScript,
	type BlackFridayAudience,
} from './offer.ts'

/** Full-bleed bar above the site header, for signed-out visitors. */
export function BlackFridaySiteBar() {
	const { blackFridayBanner } = useShellData()
	if (blackFridayBanner?.audience !== 'signed-out') return null
	return <Banner audience="signed-out" href="/signup" />
}

/**
 * Card at the top of the workspace main column, for eligible Free orgs.
 * `orgSlug` is the workspace the rail shows (null for the personal one); the
 * card stays out of a workspace the shell data was not loaded for.
 */
export function BlackFridayWorkspaceCard(props: { orgSlug: string | null }) {
	const { blackFridayBanner } = useShellData()
	if (blackFridayBanner?.audience !== 'free') return null
	if (props.orgSlug && props.orgSlug !== blackFridayBanner.orgSlug) return null
	return (
		<Banner audience="free" href={orgBillingPath(blackFridayBanner.orgSlug)} />
	)
}

function Banner(props: { audience: BlackFridayAudience; href: string }) {
	const nonce = useRouter().options.ssr?.nonce
	const countdown = useBlackFridayCountdown()
	if (countdown === null) return null
	const text = blackFridayCopy[props.audience]
	const site = props.audience === 'signed-out'
	const edge = `1px solid color-mix(in srgb, ${colors.primary} 32%, ${colors.border})`
	return (
		<>
			<section
				aria-label="Black Friday offer"
				css={{
					background: `color-mix(in srgb, ${colors.primary} 14%, ${colors.background})`,
					...(site
						? { borderBottom: edge }
						: {
								border: edge,
								borderRadius: radius.md,
								marginBottom: spacing.md,
							}),
					[`html[${blackFridayHiddenAttribute}] &`]: { display: 'none' },
				}}
			>
				<div
					css={{
						...(site
							? {
									maxWidth: layoutMaxWidths.extended,
									marginInline: 'auto',
									paddingInline: pageGutter,
								}
							: { paddingInline: spacing.md }),
						paddingBlock: spacing.sm,
						display: 'flex',
						alignItems: 'center',
						gap: `${spacing.sm} ${spacing.md}`,
						flexWrap: 'wrap',
						[mq.mobile]: { alignItems: 'flex-start' },
					}}
				>
					<div
						css={{ flex: '1 1 16rem', minWidth: 0, display: 'grid', gap: 2 }}
					>
						<p
							css={{
								margin: 0,
								fontFamily: typography.fontFamilyDisplay,
								fontWeight: typography.fontWeight.semibold,
								fontSize: typography.fontSize.sm,
								color: colors.primaryText,
								letterSpacing: '-0.01em',
							}}
						>
							{blackFridayCopy.kicker}
						</p>
						<p
							css={{
								margin: 0,
								fontSize: typography.fontSize.sm,
								lineHeight: 1.4,
								color: colors.text,
							}}
						>
							{text.body}
						</p>
						<p
							css={{
								margin: 0,
								fontSize: typography.fontSize.xs,
								color: colors.textMuted,
							}}
						>
							{text.meta}{' '}
							{/* Empty in server HTML; the script below fills it before paint.
							    Raw HTML children so hydration accepts the filled slot. */}
							<span
								{...{ [blackFridayCountdownAttribute]: '' }}
								suppressHydrationWarning
								dangerouslySetInnerHTML={{ __html: countdown }}
								css={{
									display: 'inline-block',
									minWidth: '14ch',
									whiteSpace: 'nowrap',
									fontVariantNumeric: 'tabular-nums',
								}}
							/>
						</p>
					</div>
					<div
						css={{
							display: 'flex',
							alignItems: 'center',
							gap: spacing.xs,
							marginLeft: 'auto',
							flex: 'none',
							[mq.mobile]: {
								width: '100%',
								marginLeft: 0,
								paddingBottom: spacing.xs,
							},
						}}
					>
						<Button
							href={props.href}
							variant="primary"
							size="sm"
							css={{ [mq.mobile]: { flex: 1 } }}
						>
							{text.cta}
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							iconOnly
							aria-label={blackFridayCopy.dismissLabel}
							onClick={dismissBlackFriday}
						>
							{renderIcon('close')}
						</Button>
					</div>
				</div>
			</section>
			{/* Server HTML and its hydration only: a banner mounted in the
			    browser already has the real countdown. The server and browser
			    builds minify the script text differently, so hydration must not
			    compare it. */}
			{countdown === '' ? (
				<script
					nonce={nonce}
					suppressHydrationWarning
					dangerouslySetInnerHTML={{ __html: blackFridayPrePaintScript() }}
				/>
			) : null}
		</>
	)
}
