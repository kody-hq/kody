import { publicAsset } from '../../public-assets.ts'
import { SiteLink } from '../../components/site-link.tsx'
import { Textarea } from '../../components/input.tsx'
import { FeatureRelated } from './feature-related.tsx'
import { FeatureCtaActions, FeatureCtaLink } from './feature-cta.tsx'
import { FeatureAvailability, FeatureExample } from './feature-example.tsx'

const createProfile = `profileCreate({
  name: 'release-bot',
  expires_at: '2026-12-31T00:00:00Z',
  grants: [
    {
      resource_type: 'package',
      resource_id: '<package id>',
      permissions: ['package:read', 'package:execute'],
    },
  ],
})`

const handoff = `POST /v1/profiles/handoff

{
  "name": "helper",
  "grants": [ ...only what the sub-agent needs ],
  "scopes": [ ...token scopes ]
}

-> { profile, token }`

const denial = `403 profile_grant

Profile "helper" was not granted package:execute
on package @acme/tools`

export function AgentProfilesFeature() {
	return (
		<div className="study agent-profiles">
			<div className="split">
				<div>
					<img
						className="feature-orb"
						src={publicAsset('/images/features/agent-profiles.svg')}
						alt=""
						width="80"
						height="80"
					/>
					<h1>
						Give each agent
						<br />
						<em>its own identity.</em>
					</h1>
					<p className="lead">
						A profile is an identity an agent or bot acts as, instead of acting
						as you. You choose the access it starts with, and it never holds
						more than you do.
					</p>
					<FeatureCtaLink href="/onboarding">Connect your agent</FeatureCtaLink>
					<FeatureAvailability>
						Profiles are an early access experiment. Turn them on at{' '}
						<SiteLink href="/account/experiments">Experiments</SiteLink>.
					</FeatureAvailability>
				</div>
				<div>
					<span className="example">Example profile for a release bot</span>
					<FeatureExample
						title="Agent profiles"
						state="Early access"
						tabsLabel="Profile example"
						tabs={[
							{
								id: 'create',
								label: 'Create',
								summary:
									'Create a profile with a name, an expiry, and the grants it starts with.',
								code: createProfile,
							},
							{
								id: 'handoff',
								label: 'Hand off',
								summary:
									'One call creates a sub-profile and returns a token for a sub-agent.',
								code: handoff,
							},
							{
								id: 'denial',
								label: 'Denied',
								summary:
									'A denial names the profile and the permission it was not granted.',
								code: denial,
							},
						]}
					/>
				</div>
			</div>
			<section className="story-section">
				<div className="story-split">
					<div>
						<h2>
							Access that
							<br />
							only narrows.
						</h2>
						<p>
							A profile starts with the grants you pick. It gets more only when
							someone shares something with it, or when it creates something
							itself.
						</p>
						<ul className="fx-points">
							<li>
								You can hand over only permissions you hold on that resource
								right now.
							</li>
							<li>
								Grants are a snapshot. When you gain access later, the profile
								does not.
							</li>
							<li>
								Expiry only moves earlier. For more time, create a new profile.
							</li>
						</ul>
						<SiteLink href="/docs/profiles">How profiles work</SiteLink>
					</div>
					<div>
						<h3>Every layer has to agree</h3>
						<p>
							A request running as a profile reaches something only when your
							own live access, the profile's grants, every parent profile's
							grants, and the credential's scopes all allow it.
						</p>
						<p>
							Being an org Owner does not skip a profile's limits. When a
							request is denied, the message names the layer that blocked it.
						</p>
					</div>
				</div>
			</section>
			<section className="story-section">
				<div className="story-split">
					<div>
						<h2>
							Sub-agents get less,
							<br />
							never more.
						</h2>
						<p>
							When your agent starts another agent, it can hand over a
							sub-profile with its own token. A sub-profile gets only what every
							parent holds, and it never outlives its parents.
						</p>
						<p>
							Profiles nest up to 5 levels deep. Profile tokens work with the
							Kody Open API and the CLI.
						</p>
						<SiteLink href="/docs/profiles#hand-a-sub-agent-its-own-token">
							Hand a sub-agent its own token
						</SiteLink>
					</div>
					<div>
						<h3>See which agent did it. End it in one step.</h3>
						<p>
							Runs record the profile and its parents, so activity shows which
							agent did the work. The Agent profiles page shows your profiles as
							a tree.
						</p>
						<p>
							Revoking a profile ends it and everything below it, and cannot be
							undone. Jobs and triggers it turned on pause. Anything it created
							stays manageable by you.
						</p>
					</div>
				</div>
				<div className="ms-next-agent">
					<h3>Ask your agent to make one for the job.</h3>
					<div className="ms-prompt-pair">
						<div>
							<label htmlFor="profiles-create-prompt">Create a profile</label>
							<Textarea
								id="profiles-create-prompt"
								readOnly
								value="Create a Kody profile named release-bot that can only read and run my release-notes package, and make it expire in 30 days."
							/>
						</div>
						<div>
							<label htmlFor="profiles-revoke-prompt">End it</label>
							<Textarea
								id="profiles-revoke-prompt"
								readOnly
								value="List my Kody profiles and revoke release-bot."
							/>
						</div>
					</div>
				</div>
			</section>
			<FeatureRelated
				links={[
					{ href: '/features/credentials', label: 'Credentials' },
					{ href: '/features/packages', label: 'Packages' },
					{ href: '/features/context', label: 'Execution contexts' },
				]}
			/>
			<div className="feature-start">
				<div>
					<h2>Not every agent needs everything you can reach.</h2>
					<p>
						<SiteLink href="/docs/profiles">Read the profiles guide</SiteLink>
					</p>
				</div>
				<FeatureCtaActions href="/onboarding" label="Connect your agent" />
			</div>
		</div>
	)
}
