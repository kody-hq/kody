/** @jsxImportSource @emotion/react */
import { type ReactNode } from 'react'
import { Global, type CSSObject } from '@emotion/react'
import { colors } from '#universal/styles/tokens.ts'
import { trackAcquisitionOnboardingClick } from '#client/acquisition-analytics.ts'
export function AcquisitionPage({
	pageKey,
	children,
}: {
	pageKey: string
	children: ReactNode
}) {
	return (
		<div
			style={{ display: 'contents' }}
			data-acquisition-page={pageKey}
			onClick={(event) => {
				const target = event.target instanceof Element ? event.target : null
				if (target?.closest('a')?.getAttribute('href') === '/onboarding')
					trackAcquisitionOnboardingClick(pageKey)
			}}
		>
			{acquisitionResetStyles[pageKey] ? (
				<Global styles={acquisitionResetStyles[pageKey]} />
			) : null}
			{children}
		</div>
	)
}

// Emotion's nested-selector compatibility pass prefixes :where(&) with the
// parent class. Emit these base rules globally with a zero-specificity scope
// so the page's links cannot override a pill button's own text color.
const acquisitionResetStyles: Record<string, CSSObject> = {
	automation: {
		':where([data-acquisition-page="automation"]) a': {
			color: 'inherit',
			textUnderlineOffset: '0.25em',
		},
	},
	claudeIntegrations: {
		':where([data-acquisition-page="claudeIntegrations"]) a': {
			color: colors.primaryText,
			textUnderlineOffset: '4px',
		},
	},
	composioAlternatives: {
		':where([data-acquisition-page="composioAlternatives"]) a': {
			color: colors.primaryText,
			textUnderlineOffset: '0.2em',
		},
	},
	customTools: {
		':where([data-acquisition-page="customTools"]) a': {
			color: 'inherit',
			textUnderlineOffset: '5px',
		},
	},
	gmail: {
		':where([data-acquisition-page="gmail"]) a': {
			color: colors.primaryText,
			textUnderlineOffset: '0.22em',
		},
	},
	mcpGateway: {
		':where([data-acquisition-page="mcpGateway"]) a': {
			color: 'inherit',
			textUnderlineOffset: '4px',
		},
	},
	n8nAlternatives: {
		':where([data-acquisition-page="n8nAlternatives"]) a': {
			color: colors.primaryText,
			textUnderlineOffset: '0.25em',
		},
	},
	scheduledWorkflows: {
		':where([data-acquisition-page="scheduledWorkflows"]) a': {
			color: colors.primaryText,
			textUnderlineOffset: '0.2em',
		},
		':where([data-acquisition-page="scheduledWorkflows"]) button': {
			cursor: 'pointer',
			font: 'inherit',
			color: 'inherit',
		},
	},
	sharedMemory: {
		':where([data-acquisition-page="sharedMemory"]) a': {
			color: 'inherit',
			textUnderlineOffset: '5px',
		},
	},
	slack: {
		':where([data-acquisition-page="slack"]) a': {
			color: 'inherit',
			textUnderlineOffset: '4px',
		},
	},
}
