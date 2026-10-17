/** @jsxImportSource @emotion/react */
import { useState, type CSSProperties } from 'react'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { revealRef } from '../components/reveal.ts'
import { SiteLink } from '../components/site-link.tsx'
import { BuildWithAgentButton } from '../components/build-with-agent-button.tsx'
import { landingArtAttrs } from '../public-assets.ts'
import { docHref } from '#universal/docs-nav.ts'
import { routes } from '#universal/routes.ts'
import { type WalkthroughHostPick } from '#universal/walkthrough-hosts.ts'
import { LandingAgentMarquee } from '../components/landing-agent-marquee.tsx'
import { LandingHeroAgents } from '../components/landing-hero-agents.tsx'
import { LandingHeroVideo } from '../components/landing-hero-video.tsx'
import { LandingPrimitiveCards } from './landing-primitive-cards.tsx'
import { LandingTestimonialsCarousel } from '../components/landing-testimonials-carousel.tsx'
import { LandingLoopPlayer } from '../components/landing-loop-player.tsx'
import { WalkthroughHostIntro } from './walkthrough-host-intro.tsx'
import {
	landingClosingBelieveLink,
	landingClosingHeadingEmphasis,
	landingClosingHeadingLead,
	landingClosingLead,
	landingCompareCaption,
	landingCompareWithItems,
	landingCompareWithoutItems,
	landingCompareWithTitle,
	landingCompareWithoutTitle,
	landingHeroHeadlineEmphasis,
	landingHeroHeadlineLead,
	landingHeroHeadlineTail,
	landingHeroPlugLine,
	landingHeroPrimaryCta,
	landingHeroSubhead,
	landingIsHeadingIs,
	landingIsHeadingIsNot,
	landingIsHeadingJoin,
	landingIsHeadingLead,
	landingIsItem,
	landingIsNotItems,
} from '#universal/landing-home-copy.ts'
import {
	accountDeletedConfirmationMessage,
	isAccountDeletedHome,
} from '#universal/account-deletion-confirmation.ts'
import {
	landingHeroChooserLabelEmphasis,
	landingHeroChooserLabelLead,
	type LandingHeroVideo as LandingHeroVideoItem,
} from '#universal/landing-hero-copy.ts'
const ecosystemPathSteps = [
	{
		kicker: 'Repos',
		title: 'Team git',
		note: 'Shared repos your agents write.',
	},
	{
		kicker: 'Registry',
		title: 'Team npm',
		note: 'Packages anyone can run.',
	},
	{
		kicker: 'Share',
		title: 'Community',
		note: 'Fork public, publish yours.',
	},
] as const

const ecosystemTriggers = ['Webhook', 'Cron', 'HTTP', 'App'] as const

const believeHref = routes.believe.href()
const connectYourAgentDocHref = docHref('connect-your-agent')

export function HomeRoute({
	initialHosts,
	landingAgentOrder,
	landingHeroVideos,
}: {
	initialHosts: WalkthroughHostPick
	landingAgentOrder?: Array<string>
	landingHeroVideos: Array<LandingHeroVideoItem>
}) {
	const { pageLocation: location } = useMatchedPageScope()
	const [walkthroughHosts, setWalkthroughHosts] = useState(initialHosts)
	const showAccountDeleted = isAccountDeletedHome(location.searchStr)
	return (
		<div>
			{showAccountDeleted ? (
				<p
					role="status"
					data-testid="account-deleted-notice"
					className="landing-account-deleted"
				>
					{accountDeletedConfirmationMessage}
				</p>
			) : null}
			<section className="landing-hero">
				<div className="landing-hero-intro">
					<h1
						data-rise
						style={{ '--rise': '0' } as CSSProperties}
						className="landing-hero-title"
					>
						{landingHeroHeadlineLead}
						<em>{landingHeroHeadlineEmphasis}</em>
						{landingHeroHeadlineTail}
					</h1>
					<h2
						data-rise
						style={{ '--rise': '0.6' } as CSSProperties}
						className="landing-hero-subhead"
					>
						{landingHeroSubhead}
					</h2>
					<div
						data-rise
						style={{ '--rise': '0.8' } as CSSProperties}
						className="landing-agents-row"
					>
						<LandingAgentMarquee order={landingAgentOrder} />
					</div>
					<div
						data-rise
						style={{ '--rise': '1' } as CSSProperties}
						className="landing-hero-actions"
					>
						{renderConnectCta()}
					</div>
				</div>
				<p
					data-rise
					style={{ '--rise': '1.4' } as CSSProperties}
					className="landing-hero-plug"
				>
					{landingHeroPlugLine}
				</p>
				<div className="landing-compare">
					<div className="landing-compare-col">
						<h3 id="compare-without-title" className="landing-compare-title">
							{landingCompareWithoutTitle}
						</h3>
						<ul
							aria-labelledby="compare-without-title"
							className="landing-compare-list"
						>
							{landingCompareWithoutItems.map((item) => (
								<li key={item}>{item}</li>
							))}
						</ul>
					</div>
					<div className="landing-compare-col landing-compare-col-with">
						<h3 id="compare-with-title" className="landing-compare-title">
							{landingCompareWithTitle}
						</h3>
						<ul
							aria-labelledby="compare-with-title"
							className="landing-compare-list"
						>
							{landingCompareWithItems.map((item) => (
								<li key={item}>{item}</li>
							))}
						</ul>
					</div>
				</div>
				<p className="landing-compare-caption">{landingCompareCaption}</p>
			</section>

			<LandingPrimitiveCards />

			<section aria-labelledby="is-title" className="landing-vs">
				<h2 id="is-title" className="landing-section-heading">
					{landingIsHeadingLead}
					<em>{landingIsHeadingIs}</em>
					{landingIsHeadingJoin}
					<em>{landingIsHeadingIsNot}</em>
				</h2>
				<ul className="landing-vs-list">
					{landingIsNotItems.map((item) => (
						<li key={item.kicker} className="landing-vs-item" ref={revealRef()}>
							<p className="landing-vs-kicker">{item.kicker}</p>
							<p className="landing-vs-body">{item.body}</p>
						</li>
					))}
					<li className="landing-vs-item landing-vs-item-is" ref={revealRef()}>
						<p className="landing-vs-kicker">{landingIsItem.kicker}</p>
						<p className="landing-vs-body">{landingIsItem.body}</p>
					</li>
				</ul>
			</section>

			<section className="landing-proof">
				<div className="landing-proof-split">
					<LandingHeroAgents hosts={walkthroughHosts ?? undefined} />
					<div className="landing-walkthrough-story notranslate" translate="no">
						<div className="landing-walkthrough-intro">
							{walkthroughHosts ? (
								<WalkthroughHostIntro
									variant="picker"
									hosts={walkthroughHosts}
									onHostsChange={(next) => {
										setWalkthroughHosts(next)
									}}
								/>
							) : null}
						</div>
						<LandingLoopPlayer hosts={walkthroughHosts ?? undefined} />
					</div>
				</div>
			</section>

			<section
				aria-labelledby="testimonials-title"
				className="landing-testimonials"
			>
				<h2 id="testimonials-title" className="landing-section-heading">
					What early builders say
				</h2>
				<p className="landing-testimonials-lead">
					A few notes from people already putting Kody to work with the agents
					they use every day.
				</p>
				<LandingTestimonialsCarousel />
			</section>

			<section aria-labelledby="ecosystem-title" className="landing-ecosystem">
				<div>
					<h2 id="ecosystem-title" className="landing-section-heading">
						Your team&rsquo;s own <em>git</em> and <em>npm</em>.
					</h2>
					<p className="landing-split-copy">
						One workspace your whole team shares: repos any teammate&rsquo;s
						agent can build in, packages the team publishes once, and triggers
						that run them for everyone.
					</p>
					<div className="landing-path landing-path-split">
						{renderLandingPathSteps(
							ecosystemPathSteps,
							'From your team\u2019s git to the community',
						)}
						<div className="landing-path-stem" aria-hidden="true"></div>
						<ul
							className="landing-path-fan landing-path-fan-chips"
							aria-label="Ways to trigger a package"
						>
							{ecosystemTriggers.map((trigger, index) => (
								<li
									key={trigger}
									className="landing-chip"
									ref={revealRef(index * 40, 'reveal-pop')}
								>
									{trigger}
								</li>
							))}
						</ul>
					</div>
				</div>
				<img
					{...landingArtAttrs('kody-community-packages')}
					alt="Kody handing a wrapped package across a counter of neatly sorted parcels"
					className="landing-ecosystem-art"
					ref={revealRef()}
				/>
			</section>

			{landingHeroVideos.length > 0 ? (
				<section aria-labelledby="videos-title" className="landing-videos">
					<h2 id="videos-title" className="landing-section-heading">
						{landingHeroChooserLabelLead}
						<em>{landingHeroChooserLabelEmphasis}</em>
					</h2>
					<LandingHeroVideo videos={landingHeroVideos} />
				</section>
			) : null}

			<section
				id="invisible-software"
				aria-labelledby="closing-title"
				className="landing-invite"
			>
				<img
					{...landingArtAttrs('kody-greeting')}
					alt="Kody waving hello with an open hand"
					className="landing-invite-art"
				/>
				<h2
					id="closing-title"
					className="landing-section-heading landing-invite-title"
				>
					{landingClosingHeadingLead}
					<em>{landingClosingHeadingEmphasis}</em>
				</h2>
				<p className="landing-invite-lead">{landingClosingLead}</p>
				<p className="landing-invite-believe">
					<SiteLink href={believeHref} className="landing-inline-link">
						{landingClosingBelieveLink} <span aria-hidden="true">→</span>
					</SiteLink>
				</p>
				<div className="landing-invite-cta">{renderConnectCta()}</div>
			</section>
		</div>
	)
}
/**
 * The page's one call to action: copy an agent-led setup prompt. Copying
 * needs JavaScript, so without it the same label links to the connect docs.
 */
function renderConnectCta() {
	return (
		<>
			<span className="landing-connect-copy">
				<BuildWithAgentButton
					label={landingHeroPrimaryCta}
					variant="pill"
					onboardingPage={false}
					icons={false}
				/>
			</span>
			<SiteLink
				href={connectYourAgentDocHref}
				className="landing-connect-fallback landing-inline-link"
			>
				{landingHeroPrimaryCta}
			</SiteLink>
		</>
	)
}

type LandingPathStep = {
	kicker: string
	title: string
	note: string
}

function renderLandingPathSteps(
	steps: ReadonlyArray<LandingPathStep>,
	label: string,
) {
	return (
		<ol className="landing-path-rail" aria-label={label}>
			{steps.map((step, index) => (
				<li
					key={step.title}
					className="landing-path-step"
					ref={revealRef(index * 80)}
				>
					<span className="landing-path-node" aria-hidden="true">
						{index + 1}
					</span>
					<p className="landing-path-kicker">{step.kicker}</p>
					<h3 className="landing-path-label">{step.title}</h3>
					<p className="landing-path-note">{step.note}</p>
				</li>
			))}
		</ol>
	)
}
