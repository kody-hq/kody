/** @jsxImportSource @emotion/react */
import { SiteLink } from '../components/site-link.tsx'
import {
	cardCss,
	getPrimaryButtonCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { type TipsUnsubscribeOutcome } from '#universal/token-outcomes.ts'

export function UnsubscribeTipsRoute({
	data,
}: {
	data: TipsUnsubscribeOutcome
}) {
	return (
		<section css={pageCss}>
			<header css={pageHeaderCss}>
				<h1 css={pageTitleCss}>
					{data.ok ? 'Unsubscribed from tips' : 'Unsubscribe from tips'}
				</h1>
				<p css={pageDescriptionCss}>
					{data.ok
						? 'Kody tips are the usage-state campaign nudges. Verification, billing, and error-rate mail is unchanged.'
						: 'We could not unsubscribe this address from Kody tips.'}
				</p>
			</header>
			<div css={cardCss}>
				<p
					role={data.ok ? 'status' : 'alert'}
					css={{
						color: data.ok ? colors.text : colors.error,
						fontSize: typography.fontSize.base,
						margin: 0,
					}}
				>
					{data.ok ? data.message : data.error}
				</p>
				{data.ok ? (
					<SiteLink href="/account" css={ctaButtonCss}>
						Go to account
					</SiteLink>
				) : (
					<SiteLink href="/account" css={mutedLinkCss}>
						Go to account
					</SiteLink>
				)}
			</div>
		</section>
	)
}

const pageCss = {
	...stackedPageCss,
	maxWidth: '36rem',
	margin: '0 auto',
	gap: spacing.lg,
}

const ctaButtonCss = {
	...getPrimaryButtonCss({ size: 'lg', weight: 'semibold' }),
	display: 'inline-flex',
	textDecoration: 'none',
}
