/** @jsxImportSource @emotion/react */
import { publicAsset } from '../../public-assets.ts'
import { SiteLink } from '../../components/site-link.tsx'
import { BuildWithAgentButton } from '../../components/build-with-agent-button.tsx'
import {
	primitiveCards,
	primitiveFeatureHref,
} from '#universal/primitive-cards.ts'
import { type LandingPrimitiveId } from '#universal/landing-lantern.ts'
import { LandingPrimitives } from '../../components/landing-primitives.tsx'
import { OverviewWidget } from './overview-widgets.tsx'

/** Card accent hues; `feature-pages.css` derives `--accent` from `--hue`. */
const cardHues = {
	memory: '29',
	packages: '255',
	triggers: '96',
	integrations: '148',
	apps: '300',
} as const satisfies Record<LandingPrimitiveId, string>

export function FeaturesOverview() {
	return (
		<div className="overview-content">
			<div className="intro">
				<h1>
					Your agents’ work,
					<br />
					<em>all in one place.</em>
				</h1>
				<p>
					Give your agents a place to remember what matters, connect to your
					tools, and build software you can keep using.
				</p>
			</div>
			<LandingPrimitives />
			<div className="features">
				{primitiveCards.map((card) => (
					<article
						key={card.id}
						className="feature"
						data-primitive={card.id}
						css={{
							'--hue': cardHues[card.id],
							'--pw-accent': `var(--primitive-${card.id})`,
						}}
					>
						<OverviewWidget id={card.id} />
						<div className="pitch">
							<div className="feature-name">
								<img
									src={publicAsset(card.orb)}
									width="38"
									height="38"
									alt=""
								/>
								<h2>{card.name}</h2>
							</div>
							<h3>{card.title}</h3>
							<p>{card.body}</p>
							<SiteLink href={primitiveFeatureHref(card.id)}>
								Explore {card.name.toLowerCase()}{' '}
								<span aria-hidden="true">↗</span>
							</SiteLink>
						</div>
					</article>
				))}
			</div>
			<section className="together">
				<h2>
					Useful on their own.
					<br />
					Better in the same place.
				</h2>
				<p>
					A purchase could start a package, use a connected account to prepare a
					draft, and save it in an app for review. Build each part around the
					work you need.
				</p>
				<div className="flow">
					<SiteLink href="/features/triggers">Purchase webhook</SiteLink>
					<span aria-hidden="true">→</span>
					<SiteLink href="/features/packages">Run your package</SiteLink>
					<span aria-hidden="true">→</span>
					<SiteLink href="/features/credentials">Use your account</SiteLink>
					<span aria-hidden="true">→</span>
					<SiteLink href="/features/apps">Review in your app</SiteLink>
				</div>
				<div className="actions">
					<SiteLink className="cta" href="/onboarding">
						Connect your agent
					</SiteLink>
					<BuildWithAgentButton />
				</div>
			</section>
		</div>
	)
}
