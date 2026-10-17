import { publicAsset } from '../../public-assets.ts'
import { useState } from 'react'
import { SiteLink } from '../../components/site-link.tsx'
import { SecretsVault } from './secrets-vault.tsx'
import { FeatureRelated } from './feature-related.tsx'
import {
	SecretsAccessScene,
	SecretsTripScene,
	tripResultCopy,
	type SecretApproval,
	type SecretHost,
} from './secrets-scenes.tsx'
import {
	integrationAccountStatus,
	IntegrationsHeroScene,
	IntegrationsReuseScene,
	type IntegrationAccountId,
	type IntegrationEventId,
	type IntegrationPackageId,
} from './integrations-scenes.tsx'
import { IntegrationsSetup } from './integrations-setup.tsx'
import { BuildWithAgentButton } from '../../components/build-with-agent-button.tsx'

const approvals = {
	host: 'An approved destination can receive the credential. An empty host allowlist blocks requests that use secret references.',
	package:
		'Your authored packages and reviewed, adopted forks get use automatically. Other packages need an explicit grant.',
	expiry:
		'An expired secret stays listed, but Kody stops resolving it. This does not revoke the token at the service that issued it.',
}

/**
 * `/features/credentials`: API keys and OAuth connections are one primitive.
 * The safety story reuses the secrets scenes (wrapped in `.secrets`) and the
 * OAuth story reuses the integrations scenes (wrapped in `.integrations`),
 * so each keeps its scene-scoped CSS from `public/feature-scenes/`.
 */
export function CredentialsFeature() {
	const [host, setHost] = useState<SecretHost>('approved')
	const [sent, setSent] = useState(false)
	const [tripShot, setTripShot] = useState(0)
	const [approval, setApproval] = useState<SecretApproval>('host')
	const [approvalShot, setApprovalShot] = useState(0)
	const [account, setAccount] = useState<IntegrationAccountId>('work')
	const [event, setEvent] = useState<IntegrationEventId | null>(null)
	const [heroShot, setHeroShot] = useState(0)
	const [selectedPackage, setSelectedPackage] =
		useState<IntegrationPackageId>('brief')
	const [packageShot, setPackageShot] = useState(0)
	return (
		<div className="study credentials">
			<div className="secrets">
				<div className="split">
					<div>
						<img
							className="feature-orb"
							src={publicAsset(
								'/images/lantern/kody-primitives-orb-integrations.webp',
							)}
							alt=""
							width="80"
							height="80"
						/>
						<h1>
							Your agent can use the key.
							<br />
							<em>It can't read it.</em>
						</h1>
						<p className="lead">
							API keys, OAuth connections, and MCP servers live in Kody. Kody
							adds the value to the outgoing request, only for hosts you
							approve. Agents, packages, and logs never see it.
						</p>
						<SiteLink className="action" href="/onboarding">
							Connect your agent
						</SiteLink>
					</div>
					<div className="ms-trip">
						<SecretsTripScene host={host} sent={sent} shot={tripShot} />
						<div className="controls" aria-label="Example request">
							<button
								type="button"
								aria-pressed={host === 'approved'}
								onClick={() => {
									setHost('approved')
									setSent(false)
									setTripShot((value) => value + 1)
								}}
							>
								Approved host
							</button>
							<button
								type="button"
								aria-pressed={host === 'blocked'}
								onClick={() => {
									setHost('blocked')
									setSent(false)
									setTripShot((value) => value + 1)
								}}
							>
								Unapproved host
							</button>
							<button
								type="button"
								className="run"
								id="send-request"
								onClick={() => {
									setSent(true)
									setTripShot((value) => value + 1)
								}}
							>
								Send example request
							</button>
						</div>
						<p id="secret-result" role="status">
							{tripResultCopy(host, sent)}
						</p>
						<p className="smallprint">
							Illustration only. The approved API receives the credential. The
							agent does not.
						</p>
					</div>
				</div>
				<section className="story-section">
					<div className="story-split ms-access-split">
						<div>
							<h2>
								Approve the destination.
								<br />
								Control the package.
							</h2>
							<p>
								Host approval decides where a credential may be sent. Package
								access decides which saved packages can use it.
							</p>
							<p>
								Packages you write and forks you adopt after reviewing the
								source get use automatically. Other packages need your approval.
							</p>
							<div
								className="controls"
								aria-label="Explore credential approvals"
							>
								<button
									type="button"
									aria-pressed={approval === 'host'}
									onClick={() => {
										setApproval('host')
										setApprovalShot((value) => value + 1)
									}}
								>
									Host approval
								</button>
								<button
									type="button"
									aria-pressed={approval === 'package'}
									onClick={() => {
										setApproval('package')
										setApprovalShot((value) => value + 1)
									}}
								>
									Package access
								</button>
								<button
									type="button"
									aria-pressed={approval === 'expiry'}
									onClick={() => {
										setApproval('expiry')
										setApprovalShot((value) => value + 1)
									}}
								>
									Expiry
								</button>
							</div>
							<p id="ms-approval-copy" role="status">
								{approvals[approval]}
							</p>
							<SiteLink href="/docs/credentials">
								How credentials stay safe
							</SiteLink>
						</div>
						<SecretsAccessScene approval={approval} shot={approvalShot} />
					</div>
				</section>
				<SecretsVault />
			</div>
			<div className="integrations">
				<section className="story-section">
					<div className="story-split">
						<div>
							<h2>
								If it speaks OAuth,
								<br />
								<em>it works with Kody.</em>
							</h2>
							<p>
								Gmail, Slack, GitHub, or the internal tool your team runs. Any
								service with an OAuth sign-in can connect, through a built-in
								app or one you register.
							</p>
							<p>
								Kody keeps the tokens and refreshes them on its side, so the
								connection stays out of every chat and keeps working.
							</p>
							<SiteLink href="/docs/oauth">See how OAuth setup works</SiteLink>
						</div>
						<div>
							<span className="example">
								Example connection, fictional data
							</span>
							<IntegrationsHeroScene
								account={account}
								event={event}
								shot={heroShot}
								onAccount={(next) => {
									setAccount(next)
									setEvent(null)
									setHeroShot((value) => value + 1)
								}}
								onEvent={(next) => {
									setEvent(next)
									setHeroShot((value) => value + 1)
								}}
							/>
							<p className="visually-hidden" aria-live="polite">
								{integrationAccountStatus(account, event)}
							</p>
						</div>
					</div>
				</section>
				<section className="story-section ia-reuse">
					<div className="story-split">
						<div>
							<h2>
								Sign in once.
								<br />
								Put the connection to work.
							</h2>
							<p>
								Your connection supplies the account and its permissions. A
								package supplies the action. Reuse the same saved connection in
								the tools you build.
							</p>
							<p className="ia-note">
								Connecting a service does not install its tools.
							</p>
							<SiteLink href="/features/packages">Explore packages ↗</SiteLink>
						</div>
						<div>
							<span className="example">
								Example connection, fictional data
							</span>
							<IntegrationsReuseScene
								selected={selectedPackage}
								shot={packageShot}
								onSelect={(next) => {
									setSelectedPackage(next)
									setPackageShot((value) => value + 1)
								}}
							/>
						</div>
					</div>
				</section>
				<IntegrationsSetup />
			</div>
			<FeatureRelated
				links={[
					{ href: '/integrations/gmail', label: 'Gmail integration' },
					{ href: '/integrations/slack', label: 'Slack integration' },
					{ href: '/integrations/claude', label: 'Claude integration' },
					{ href: '/features/packages', label: 'Reusable packages' },
				]}
			/>
			<div className="feature-start">
				<div>
					<h2>Give your agents access without handing over the keys.</h2>
					<p>
						Store a key or connect an account, approve where it may go, and
						choose which packages can use it.
					</p>
					<p>
						<SiteLink href="/docs/credentials">
							Read the credentials guide
						</SiteLink>
					</p>
				</div>
				<div className="controls">
					<SiteLink className="action" href="/onboarding">
						Connect your agent
					</SiteLink>
					<BuildWithAgentButton />
				</div>
			</div>
		</div>
	)
}
