/** @jsxImportSource @emotion/react */
import { ExperimentOptIn } from '../components/experiment-opt-in.tsx'
import { type ReactNode } from 'react'
import { SiteLink } from '../components/site-link.tsx'
import { buildAuthLink } from '#client/auth-links.ts'
import { mcpEventsExtensionFlagKey } from '#universal/feature-flags/registry.ts'
import { routes } from '#universal/routes.ts'
import {
	getAccentCalloutCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors } from '#universal/styles/tokens.ts'

const mcpEventsDocsHref = routes.docDetail.href({
	slug: 'mcp-events',
})

export function renderMcpEventsFlagCallout(input: {
	loggedIn: boolean
	enabled: boolean
}): ReactNode {
	const loginHref = buildAuthLink(routes.login.href(), mcpEventsDocsHref)

	return (
		<aside
			data-testid="mcp-events-flag-callout"
			data-flag={mcpEventsExtensionFlagKey}
			css={calloutCss}
		>
			<p>
				{input.enabled
					? 'You are trying MCP Events. It is still behind a feature flag, so it may change or go away.'
					: 'MCP Events is behind a feature flag because the extension is still a draft. Turn it on for your account if you want to try it.'}
			</p>
			{input.enabled ? null : input.loggedIn ? (
				<ExperimentOptIn experiment="mcp-events">
					Try MCP Events
				</ExperimentOptIn>
			) : (
				<p css={actionCss}>
					<SiteLink
						href={loginHref}
						data-testid="mcp-events-flag-login"
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
