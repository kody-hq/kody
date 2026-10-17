/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'
import { useState } from 'react'
import { SiteLink } from '../components/site-link.tsx'
import { BuildWithAgentButton } from '../components/build-with-agent-button.tsx'
import { businessOnboardingHref } from '#universal/business-onboarding.ts'
import { businessCss } from './business-styles.ts'
import { businessExamples, type BusinessExample } from './business-examples.ts'
import { BusinessHero } from './business-hero.tsx'
export function BusinessRoute() {
	const [current, setCurrent] = useState<BusinessExample>('invoices')
	const [mode, setMode] = useState<'app' | 'agent'>('app')
	const example = businessExamples[current]
	return (
		<div css={businessCss}>
			<div className="wrap">
				<nav className="nav" aria-label="Main navigation">
					<SiteLink className="brand" href="/">
						<img
							src={publicAsset('/logo-64.webp')}
							alt=""
							width={36}
							height={36}
						/>
						kody<span>for business</span>
					</SiteLink>
					<div className="navlinks">
						<SiteLink href="#in-action">See it in action</SiteLink>
						<SiteLink href="#client-spaces">Client ownership</SiteLink>
						<SiteLink className="button" href={businessOnboardingHref}>
							Get started{' '}
							<span className="arrow" aria-hidden="true">
								↗
							</span>
						</SiteLink>
					</div>
				</nav>
				<div>
					<section className="hero">
						<h1>
							The agent cloud
							<br />
							<span>for your business.</span>
						</h1>
						<BusinessHero />
						<div className="hero-copy">
							<p>
								Give your teams and their AI agents a shared home for tools,
								data, and automations. Run work across departments or client
								organizations, with clear ownership and control over who can use
								or change it.
							</p>
							<div className="hero-actions">
								<SiteLink className="button" href={businessOnboardingHref}>
									Get started
									<span className="arrow" aria-hidden="true">
										↗
									</span>
								</SiteLink>
								<BuildWithAgentButton business />
							</div>
							<SiteLink href="#in-action" className="text-link">
								Explore a client workflow ↓
							</SiteLink>
						</div>
					</section>
					<section
						className="showcase"
						id="in-action"
						aria-label="Interactive client workflow examples"
					>
						<div
							className="example-tabs"
							role="group"
							aria-label="Choose a workflow"
						>
							<button
								data-example="invoices"
								type="button"
								aria-pressed={current === 'invoices' ? 'true' : 'false'}
								onClick={() => {
									setCurrent('invoices')
								}}
							>
								Monthly invoicing
							</button>
							<button
								data-example="audit"
								type="button"
								aria-pressed={current === 'audit' ? 'true' : 'false'}
								onClick={() => {
									setCurrent('audit')
								}}
							>
								Nightly audits
							</button>
							<button
								data-example="onboarding"
								type="button"
								aria-pressed={current === 'onboarding' ? 'true' : 'false'}
								onClick={() => {
									setCurrent('onboarding')
								}}
							>
								Client onboarding
							</button>
						</div>
						<div className="app">
							<aside className="studio">
								<div className="studio-brand">
									<span className="studio-icon" aria-hidden="true">
										N
									</span>
									Northline Studio
								</div>
								<small>Client organizations</small>
								<div className="space active">◈ &nbsp; Acme Construction</div>
								<div className="space">◈ &nbsp; Fieldwork Co.</div>
								<div className="space">◈ &nbsp; Studio operations</div>
								<small>Your library</small>
								<div className="space">▧ &nbsp; Shared packages</div>
								<div className="studio-bottom">
									Maintained by<strong>Northline delivery team</strong>
								</div>
							</aside>
							<div className="workspace">
								<div className="appbar">
									<span>
										Acme Construction &nbsp; / &nbsp;
										<strong>{example.title}</strong>
									</span>
									<span className="live">Active</span>
								</div>
								<div className="workbody">
									<div>
										<p className="request-label">The client’s request</p>
										<p className="request">{example.request}</p>
										<div className="pipeline">
											{example.steps.map((step) => (
												<div key={step}>
													<span className="check" aria-hidden="true">
														✓
													</span>
													{step}
												</div>
											))}
										</div>
										<p className="trigger">{example.trigger}</p>
									</div>
									<div className="output">
										<div className="output-bar">
											<span>Client view</span>
											<div
												className="mode-tabs"
												role="group"
												aria-label="Client interface"
											>
												<button
													data-mode="app"
													type="button"
													aria-pressed={mode === 'app' ? 'true' : 'false'}
													onClick={() => {
														setMode('app')
													}}
												>
													App
												</button>
												<button
													data-mode="agent"
													type="button"
													aria-pressed={mode === 'agent' ? 'true' : 'false'}
													onClick={() => {
														setMode('agent')
													}}
												>
													AI agent
												</button>
											</div>
										</div>
										<div
											className="output-content"
											aria-live="polite"
											aria-atomic="true"
										>
											{mode === 'app' ? (
												<>
													<h2>{example.heading}</h2>
													<p className="output-sub">{example.sub}</p>
													{example.rows.map(([name, status]) => (
														<div className="data-row" key={name}>
															<span>{name}</span>
															<span>{status}</span>
														</div>
													))}
													<p className="output-foot">{example.foot}</p>
												</>
											) : (
												<>
													<p className="agent-prompt">{example.prompt}</p>
													<p className="agent-tool">{example.tool}</p>
													<p className="agent-result">{example.answer}</p>
													<p className="output-foot">
														Using Acme’s shared workflow and permissions
													</p>
												</>
											)}
										</div>
									</div>
								</div>
							</div>
						</div>
						<p className="demo-caption">
							Illustrative workflow and client data
						</p>
					</section>
					<div className="capabilities">
						<span>
							<b aria-hidden="true">↗</b>Bring your preferred agent
						</span>
						<span>
							<b aria-hidden="true">◷</b>Run on schedules or webhooks
						</span>
						<span>
							<b aria-hidden="true">▧</b>Keep tools and data between runs
						</span>
						<span>
							<b aria-hidden="true">◈</b>Manage client access
						</span>
					</div>
					<section className="reuse">
						<div className="section-copy">
							<h2>
								Built by your people.
								<br />
								Shared across your business.
							</h2>
							<p>
								Your agent builds the tools. Kody keeps the code, connections,
								and data together, and runs the work on a schedule or when
								something happens, even after the chat closes.
							</p>
							<p>
								Share tools across your teams, or reuse them for the next
								client. Keep each organization’s connections and data separate
								while your people work with their preferred agents.
							</p>
							<SiteLink href="#client-spaces" className="text-link">
								Keep each client’s work separate ↓
							</SiteLink>
						</div>
						<div
							className="library"
							aria-label="A shared package used in separate client organizations"
						>
							<div className="package">
								<span className="package-icon" aria-hidden="true">
									▧
								</span>
								<div>
									<strong>Invoice reconciliation</strong>
									<small>Northline Studio / shared package</small>
								</div>
							</div>
							<div className="branches">
								<div className="client">
									<strong>Acme Construction</strong>
									<p>Acme accounting connection</p>
									<p>Job codes + progress billing</p>
									<span className="tag">Acme owns the data</span>
								</div>
								<div className="client">
									<strong>Fieldwork Co.</strong>
									<p>Fieldwork accounting connection</p>
									<p>Retainers + monthly billing</p>
									<span className="tag">Fieldwork owns the data</span>
								</div>
							</div>
							<p className="library-note">
								Shared logic. Separate connections and records.
							</p>
						</div>
					</section>
				</div>
			</div>
			<section className="ownership" id="client-spaces">
				<div className="wrap ownership-grid">
					<div className="section-copy">
						<h2>
							Your agency runs it.
							<br />
							Your client owns it.
						</h2>
						<p>
							Give each client an organization for their workflows, connections,
							and data. Keep your team involved for ongoing work, or hand it
							over when the engagement ends.
						</p>
					</div>
					<div>
						<div className="access">
							<div className="access-title">
								Acme Construction <span>People & access</span>
							</div>
							<div className="person">
								<span className="avatar">AL</span>
								<div>
									Alex Lee<small>Acme Construction</small>
								</div>
								<span className="role">Owner</span>
							</div>
							<div className="person">
								<span className="avatar">NS</span>
								<div>
									Northline Studio<small>Agency delivery team</small>
								</div>
								<span className="role">Can maintain</span>
							</div>
							<div className="person">
								<span className="avatar">JT</span>
								<div>
									Jordan Taylor<small>Acme operations</small>
								</div>
								<span className="role">Can run</span>
							</div>
						</div>
						<div className="ownership-notes">
							<div>
								<h3>Share the right access</h3>
								<p>
									Let people run a workflow without giving them its credentials
									or permission to change it.
								</p>
							</div>
							<div>
								<h3>Leave a clear history</h3>
								<p>
									See who ran or changed the work. Remove a teammate without
									removing the client’s tools.
								</p>
							</div>
						</div>
					</div>
				</div>
			</section>
			<div className="wrap">
				<section className="offer">
					<div>
						<h2>
							Put your agents to work
							<br />
							across your business.
						</h2>
						<p>
							Start with one business process. Bring the team that owns it,
							connect the systems it depends on, and decide who can run,
							maintain, and share the work.
						</p>
					</div>
					<div className="offer-card">
						<h3>Start with one workflow.</h3>
						<ul>
							<li>Connect your AI agent</li>
							<li>Connect the tools you use</li>
							<li>Build something useful</li>
						</ul>
						<SiteLink className="button" href={businessOnboardingHref}>
							Get started{' '}
							<span className="arrow" aria-hidden="true">
								↗
							</span>
						</SiteLink>
					</div>
				</section>
			</div>
		</div>
	)
}
