/** @jsxImportSource @emotion/react */
import { SiteLink } from '../../components/site-link.tsx'
export type FeatureRelatedLink = {
	href: string
	label: string
}
export function FeatureRelated(props: { links: Array<FeatureRelatedLink> }) {
	const { links } = props
	if (links.length === 0) return null
	return (
		<section
			className="feature-related story-section"
			aria-labelledby="feature-related"
		>
			<h2 id="feature-related">Related</h2>
			<ul className="feature-related-list">
				{links.map((link) => (
					<li key={link.href}>
						<SiteLink href={link.href}>{link.label}</SiteLink>
					</li>
				))}
			</ul>
		</section>
	)
}
