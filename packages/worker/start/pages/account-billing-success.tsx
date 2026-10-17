/** @jsxImportSource @emotion/react */
import { SiteLink } from '../components/site-link.tsx'
import { kodyDiscordInviteUrl } from '#universal/community-links.ts'
import { type AccountBillingSuccessLoaderData } from '#universal/loader-data.ts'
import {
	cardCss,
	getGhostButtonCss,
	getPrimaryButtonCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

const onboardingPath = '/onboarding'
export function AccountBillingSuccessPage({
	data,
	billingPath,
}: {
	billingPath: string
	data: AccountBillingSuccessLoaderData
}) {
	return (
		<section css={pageCss}>
			<header css={pageHeaderCss}>
				<h1 css={pageTitleCss}>You&rsquo;re in</h1>
				<p css={pageDescriptionCss}>
					Your paid plan is active. Same factory, more room for jobs, workflows,
					and daily volume.
				</p>
			</header>
			<div css={cardCss}>
				<p css={statusCss} role="status">
					Thanks for paying for the volume you actually use.
				</p>
				<div css={ctaRowCss}>
					<SiteLink href={kodyDiscordInviteUrl} css={primaryCtaCss}>
						Join the Kody Discord
					</SiteLink>
					{data.needsOnboarding ? (
						<SiteLink href={onboardingPath} css={secondaryCtaCss}>
							Connect your agent
						</SiteLink>
					) : null}
					<SiteLink href={billingPath} css={mutedLinkCss}>
						Manage billing
					</SiteLink>
				</div>
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

const statusCss = {
	color: colors.text,
	fontSize: typography.fontSize.base,
	margin: 0,
}

const ctaRowCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.md,
	flexWrap: 'wrap' as const,
}

const primaryCtaCss = {
	...getPrimaryButtonCss({ size: 'lg', weight: 'semibold' }),
	display: 'inline-flex',
	textDecoration: 'none',
}

const secondaryCtaCss = {
	...getGhostButtonCss(),
	display: 'inline-flex',
	textDecoration: 'none',
}
