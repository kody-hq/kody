/** @jsxImportSource @emotion/react */
import { TextLink } from '../components/text-link.tsx'
import type { CSSObject } from '@emotion/react'

import { CopyCard } from './onboarding-mcp-client-cards.tsx'
import {
	onboardingCopyStep2PromptLabel,
	onboardingGuideHref,
	onboardingStep2Prompt,
} from '#universal/onboarding-process.ts'
import { colors, typography } from '#universal/styles/tokens.ts'

export function OnboardingStep2Prompt() {
	return (
		<div data-testid="onboarding-step-2-prompt" css={listCss}>
			<CopyCard
				label="Step 2 prompt"
				value={onboardingStep2Prompt}
				copyLabel={onboardingCopyStep2PromptLabel}
			/>
			<p css={guidePointerCss} data-testid="onboarding-guide-pointer">
				Depth lives in the{' '}
				<TextLink href={onboardingGuideHref} css={guideLinkCss}>
					onboarding guide
				</TextLink>
				. The prompt tells your agent to retrieve it.
			</p>
		</div>
	)
}

const listCss: CSSObject = {
	display: 'grid',
	gap: '0.85rem',
	width: '100%',
	maxWidth: '68ch',
	justifyItems: 'stretch',
}

const guidePointerCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const guideLinkCss: CSSObject = {
	fontWeight: 600,
}
