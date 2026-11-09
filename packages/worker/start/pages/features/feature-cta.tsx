/** @jsxImportSource @emotion/react */
import type { ReactNode } from 'react'
import { BuildWithAgentButton } from '../../components/build-with-agent-button.tsx'
import { SiteLink } from '../../components/site-link.tsx'
import { getPillButtonCss } from '#universal/styles/style-primitives.ts'

const featureCtaCss = getPillButtonCss()

/**
 * Primary call to action on the feature pages: the site's shared pill, so it
 * matches the homepage and the agent copy button beside it.
 */
export function FeatureCtaLink(props: { href: string; children: ReactNode }) {
	return (
		<SiteLink className="feature-cta" href={props.href} css={featureCtaCss}>
			{props.children}
		</SiteLink>
	)
}

/** Primary pill plus the "Build with your agent" ghost pill, sized as a pair. */
export function FeatureCtaActions(props: { href: string; label: string }) {
	return (
		<div className="feature-cta-actions">
			<FeatureCtaLink href={props.href}>{props.label}</FeatureCtaLink>
			<BuildWithAgentButton />
		</div>
	)
}
