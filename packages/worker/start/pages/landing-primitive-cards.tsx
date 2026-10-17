/** @jsxImportSource @emotion/react */
import { PrimitiveWidgetFrame } from '../components/primitive-widget-parts.tsx'
import { type CSSProperties } from 'react'
import { SiteLink } from '../components/site-link.tsx'
import { primitiveRestScene } from '../components/primitive-widgets.tsx'
import {
	primitiveCards,
	primitiveFeatureHref,
} from '#universal/primitive-cards.ts'
import { routes } from '#universal/routes.ts'

/**
 * Homepage cards: a small copy of each `/features` widget beside the
 * primitive's name and one line. The widget is decorative (the card is one
 * link); `/features` has the interactive versions. Narrow screens turn the
 * grid into a swipe row so the cards do not become five screens of scroll.
 */
export function LandingPrimitiveCards() {
	return (
		<section aria-labelledby="primitive-cards-title" className="landing-pcards">
			<h2 id="primitive-cards-title" className="landing-section-heading">
				<em>Primitives</em> for your agents
			</h2>
			<ul className="landing-pcards-list">
				{primitiveCards.map((card) => (
					<li key={card.id} className="landing-pcard-item">
						<SiteLink
							href={primitiveFeatureHref(card.id)}
							className="landing-pcard"
							style={
								{
									'--pw-accent': `var(--primitive-${card.id})`,
								} as CSSProperties
							}
						>
							<PrimitiveWidgetFrame id={card.id} size="mini">
								{primitiveRestScene(card.id)}
							</PrimitiveWidgetFrame>
							<span className="landing-pcard-name">{card.name}</span>
							<span className="landing-pcard-title">{card.title}</span>
						</SiteLink>
					</li>
				))}
			</ul>
			<p className="landing-pcards-more">
				<SiteLink href={routes.features.href()} className="landing-inline-link">
					Explore all features <span aria-hidden="true">↗</span>
				</SiteLink>
			</p>
		</section>
	)
}
