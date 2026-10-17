/** @jsxImportSource @emotion/react */
import { ExperimentOptIn } from '../components/experiment-opt-in.tsx'
import { type ReactNode } from 'react'
import { SiteLink } from '../components/site-link.tsx'
import { buildAuthLink } from '#client/auth-links.ts'
import { mcpSkillsExtensionFlagKey } from '#universal/feature-flags/registry.ts'
import { routes } from '#universal/routes.ts'
import {
	getAccentCalloutCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors } from '#universal/styles/tokens.ts'

const packageSkillsDocsHref = routes.docDetail.href({
	slug: 'package-skills',
})

export function renderPackageSkillsFlagCallout(input: {
	loggedIn: boolean
	enabled: boolean
}): ReactNode {
	const loginHref = buildAuthLink(routes.login.href(), packageSkillsDocsHref)

	return (
		<aside
			data-testid="package-skills-flag-callout"
			data-flag={mcpSkillsExtensionFlagKey}
			css={calloutCss}
		>
			<p>
				{input.enabled
					? 'You are trying package skills over MCP. It is still behind a feature flag, so it may change or go away.'
					: 'Serving package skills over MCP is behind a feature flag because it may change or go away. Turn it on for your account if you want to try it.'}
			</p>
			{input.enabled ? null : input.loggedIn ? (
				<ExperimentOptIn experiment="package-skills">
					Try package skills
				</ExperimentOptIn>
			) : (
				<p css={actionCss}>
					<SiteLink
						href={loginHref}
						data-testid="package-skills-flag-login"
						css={getPillButtonCss({ size: 'sm' })}
					>
						Log in to try it
					</SiteLink>
				</p>
			)}
		</aside>
	)
}

const calloutCss = {
	...getAccentCalloutCss(),
	margin: '0 0 1.4rem',
	maxWidth: '62ch',
	'& p': {
		margin: 0,
		color: colors.text,
	},
}

const actionCss = {
	margin: '0.75rem 0 0',
}
