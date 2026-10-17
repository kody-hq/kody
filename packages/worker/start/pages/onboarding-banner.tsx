/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'
import { SiteLink } from '../components/site-link.tsx'
import { type OnboardingChecklistLoaderData } from '#universal/loader-data.ts'
import { getPillButtonCss } from '#universal/styles/style-primitives.ts'
import { noticeCardCss } from './account-management-components.tsx'
import { colors } from '#universal/styles/tokens.ts'
import { onboardingPath } from '#client/routes/onboarding-redirect.ts'
import {
	getFirstUndoneChecklistItemLabel,
	shouldShowOnboardingChecklist,
} from '#universal/onboarding-checklist.ts'

type OnboardingBannerOptions = {
	checklist?: OnboardingChecklistLoaderData | null
}

/**
 * Callout shown when the signed-in verified user still needs MCP host setup.
 * Ported from the prototype's `.onboard-callout`: a quiet horizontal surface
 * banner — mascot cutout standing on the bottom edge, copy in the middle, the
 * green pill CTA on the right. Green lives in the CTA, never in the chrome.
 */
export function renderOnboardingBanner(options?: OnboardingBannerOptions) {
	const checklist = options?.checklist
	const showChecklistProgress = shouldShowOnboardingChecklist(checklist)
	const nextLabel =
		showChecklistProgress && checklist
			? getFirstUndoneChecklistItemLabel(checklist)
			: null

	return (
		<section
			aria-label="Get started with Kody"
			css={{
				...noticeCardCss,
				display: 'flex',
				alignItems: 'center',
				flexWrap: 'wrap',
				gap: '1.2rem',
				padding: '0.9rem 1.2rem',
			}}
		>
			<img
				src={publicAsset('/images/kody-connect-callout.webp')}
				alt=""
				width={88}
				height={88}
				css={{
					width: '88px',
					height: '88px',
					objectFit: 'contain',
					objectPosition: 'bottom',
					flex: 'none',
					alignSelf: 'flex-end',
					// The mascot is a cutout: it stands on the banner's bottom
					// edge rather than floating inside it.
					marginBottom: '-0.9rem',
				}}
			/>
			<div css={{ flex: 1, minWidth: 0 }}>
				<h2
					css={{
						margin: 0,
						fontSize: '1.08rem',
						fontWeight: 700,
						letterSpacing: '-0.01em',
						lineHeight: 1.3,
					}}
				>
					Connect your AI agent
				</h2>
				<p
					css={{
						margin: '0.2rem 0 0',
						color: colors.textMuted,
						fontSize: '0.95rem',
						lineHeight: 1.5,
					}}
				>
					{showChecklistProgress && nextLabel
						? `Next up: ${nextLabel}`
						: 'Kody works through MCP. Add this deployment as an MCP server in Cursor, Claude, Copilot, or any MCP-capable agent, then ask your agent to help you get set up.'}
				</p>
			</div>
			<SiteLink
				href={onboardingPath}
				css={{
					...getPillButtonCss(),
					flex: 'none',
					fontSize: '0.95rem',
					padding: '0.8rem 1.35rem',
				}}
			>
				{showChecklistProgress ? 'Continue onboarding' : 'Connect your agent'}
			</SiteLink>
		</section>
	)
}
