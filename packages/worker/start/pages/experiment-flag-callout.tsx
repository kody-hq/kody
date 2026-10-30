/** @jsxImportSource @emotion/react */
import { type ReactNode } from 'react'
import { ExperimentOptIn } from '../components/experiment-opt-in.tsx'
import { SiteLink } from '../components/site-link.tsx'
import { buildAuthLink } from '#client/auth-links.ts'
import { type selfServeExperiments } from '#universal/feature-flags/experiments.ts'
import { routes } from '#universal/routes.ts'
import {
	getAccentCalloutCss,
	getPillButtonCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'
import { colors } from '#universal/styles/tokens.ts'

/**
 * Callout on an experiment's docs page: says it is an experiment and, while
 * it is off, offers the opt-in (or a login link).
 */
export function renderExperimentFlagCallout(input: {
	experiment: (typeof selfServeExperiments)[number]
	loggedIn: boolean
	enabled: boolean
}): ReactNode {
	const { experiment } = input
	const docsHref = routes.docDetail.href({ slug: experiment.docsSlug })
	const loginHref = buildAuthLink(routes.login.href(), docsHref)
	return (
		<aside
			data-testid={`${experiment.id}-flag-callout`}
			data-flag={experiment.flagKey}
			css={calloutCss}
		>
			<p>
				{input.enabled
					? `${experiment.title}: this experiment is on for your account. It may change or go away.`
					: `${experiment.title}: this experiment is off for your account until you turn it on. It may change or go away.`}
			</p>
			<p css={noteCss}>
				{experiment.stage} Manage every experiment on{' '}
				<SiteLink href={routes.accountExperiments.href()} css={primaryLinkCss}>
					Experiments
				</SiteLink>
				.
			</p>
			{input.enabled ? null : input.loggedIn ? (
				<ExperimentOptIn experiment={experiment.id}>
					{`Try ${experiment.title}`}
				</ExperimentOptIn>
			) : (
				<p css={actionCss}>
					<SiteLink
						href={loginHref}
						data-testid={`${experiment.id}-flag-login`}
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

const noteCss = {
	marginTop: '0.4rem !important',
	color: `${colors.textMuted} !important`,
	fontSize: '0.9rem',
}

const actionCss = {
	margin: '0.75rem 0 0',
}
