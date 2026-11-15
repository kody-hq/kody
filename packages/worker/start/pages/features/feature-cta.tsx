/** @jsxImportSource @emotion/react */
import { Button } from '../../components/button.tsx'
import type { ReactNode } from 'react'
import { BuildWithAgentButton } from '../../components/build-with-agent-button.tsx'

/**
 * Primary call to action on the feature pages: the site's shared pill, so it
 * matches the homepage and the agent copy button beside it.
 */
export function FeatureCtaLink(props: { href: string; children: ReactNode }) {
	return (
		<Button className="feature-cta" href={props.href} variant="primary" size="lg">
			{props.children}
		</Button>
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
