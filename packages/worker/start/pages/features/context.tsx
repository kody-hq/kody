import { publicAsset } from '../../public-assets.ts'
import { SiteLink } from '../../components/site-link.tsx'
import { FeatureRelated } from './feature-related.tsx'
import { FeatureCtaActions, FeatureCtaLink } from './feature-cta.tsx'
import { FeatureAvailability, FeatureExample } from './feature-example.tsx'

const connect = `npm install -g @kodycodes/cli
kody login

# register this machine and keep it running
kody connect --name my-laptop

# send your runs here first
kody chain add my-laptop`

const choose = `// run on one machine, or fail
{ context: 'my-laptop' }

// run there, or fall back to your chain
{ context: 'my-laptop', fallback: 'chain' }

// this order, for this run
{ chain: ['my-laptop', 'build-box', 'cloud'] }

// only somewhere with host folders
{ requires: ['fs'] }`

const ranOn = `Ran on my-laptop (your machine), 0 worker units.

{
  "kind": "context",
  "name": "my-laptop",
  "attempts": [
    { "name": "build-box", "outcome": "busy" }
  ],
  "fellBackToCloud": false,
  "workerUnits": 0
}`

const command = `import { kody } from 'kody:runtime'

const result = await kody.command.run({
  command: 'git status --short && npm test',
  cwd: '/Users/me/code/app',
  timeoutMs: 120_000,
})
// { exitCode, stdout, stderr, durationMs, ... }`

export function ContextFeature() {
	return (
		<div className="study context">
			<div className="split">
				<div>
					<img
						className="feature-orb"
						src={publicAsset('/images/features/context.svg')}
						alt=""
						width="80"
						height="80"
					/>
					<h1>
						Run it on
						<br />
						<em>your own machine.</em>
					</h1>
					<p className="lead">
						An execution context is a machine you run code on: your laptop, a
						home server, or a build box. Your runs go there first, and Kody
						cloud is the fallback.
					</p>
					<FeatureCtaLink href="/onboarding">Connect your agent</FeatureCtaLink>
					<FeatureAvailability>
						Execution contexts are an early access experiment. Turn them on at{' '}
						<SiteLink href="/account/experiments">Experiments</SiteLink>.
					</FeatureAvailability>
				</div>
				<div>
					<span className="example">Example machine named my-laptop</span>
					<FeatureExample
						title="Execution contexts"
						state="Early access"
						tabsLabel="Execution context example"
						tabs={[
							{
								id: 'connect',
								label: 'Connect',
								summary:
									'Install the CLI, sign in, connect the machine, and add it to your chain.',
								code: connect,
							},
							{
								id: 'choose',
								label: 'Choose where',
								summary:
									'A run can name a context, a fallback, a chain, or what it requires.',
								code: choose,
							},
							{
								id: 'result',
								label: 'Result',
								summary:
									'Every result says where the run happened and which machines were skipped.',
								code: ranOn,
							},
						]}
					/>
				</div>
			</div>
			<section className="story-section">
				<div className="story-split">
					<div>
						<h2>
							Your machine does the work.
							<br />
							Your credentials stay put.
						</h2>
						<p>
							A run on your machine has the same permissions as the same run on
							Kody cloud. Credentials never reach the machine. When code there
							calls a service with a credential, the request leaves from Kody
							cloud, which adds the credential on the way out.
						</p>
						<p>The machine sees the response, not the credential.</p>
						<SiteLink href="/docs/execution-contexts">
							What changes on a machine
						</SiteLink>
					</div>
					<div>
						<h3>You decide what the machine adds</h3>
						<ul className="fx-points">
							<li>
								<strong>Host folders.</strong> Only folders you allow, read-only
								unless you say otherwise. Credential stores such as{' '}
								<code>~/.ssh</code> are never exposed.
							</li>
							<li>
								<strong>Local network.</strong> Off until you turn it on, so a
								run can reach devices on your network.
							</li>
							<li>
								<strong>Shell commands.</strong> Off until you turn them on at
								the machine itself.
							</li>
						</ul>
					</div>
				</div>
			</section>
			<section className="story-section">
				<div className="story-split">
					<div>
						<h3>Run a command on the machine</h3>
						<FeatureExample
							title="kody.command.run"
							tabs={[
								{
									id: 'command',
									label: 'Command',
									summary:
										'Code in a run calls kody.command.run with a command and a working folder.',
									code: command,
								},
							]}
						/>
					</div>
					<div>
						<h2>
							Offline or busy?
							<br />
							The run moves on.
						</h2>
						<p>
							Your chain is the ordered list of places Kody tries: up to three
							machines, with Kody cloud last. A machine that is offline or busy
							is skipped. A run that names one machine with no fallback fails
							instead.
						</p>
						<p>
							Jobs, webhooks, and subscriptions can choose where they run too.
							Runs on your machine do not use your Worker compute allowance.
						</p>
						<SiteLink href="/docs/execution-contexts#the-chain-and-cloud-fallback">
							The chain and cloud fallback
						</SiteLink>
					</div>
				</div>
			</section>
			<section className="story-section">
				<div className="story-split">
					<div>
						<h2>
							Set it up once.
							<br />
							It keeps running.
						</h2>
						<p>
							<code>kody connect</code> installs a background service on Linux,
							macOS, or Windows, so the machine reconnects after a restart. It
							does not run as root, and it updates itself by default.
						</p>
						<p>
							Pause a machine from anywhere, and see its status and runs in your
							workspace.
						</p>
					</div>
					<div>
						<h3>Share a machine with your team</h3>
						<p>
							Share a context with people or teams in your org. Each person opts
							in before their runs go there. Their runs never get your host
							folders or shell commands.
						</p>
						<SiteLink href="/docs/execution-contexts#sharing-a-context">
							Sharing a context
						</SiteLink>
					</div>
				</div>
			</section>
			<FeatureRelated
				links={[
					{ href: '/features/credentials', label: 'Credentials' },
					{ href: '/features/triggers', label: 'Triggers and automation' },
					{ href: '/features/agent-profiles', label: 'Agent profiles' },
				]}
			/>
			<div className="feature-start">
				<div>
					<h2>
						Use the folder, the device, or the tool that only lives there.
					</h2>
					<p>
						<SiteLink href="/docs/execution-contexts">
							Read the execution contexts guide
						</SiteLink>
					</p>
				</div>
				<FeatureCtaActions href="/onboarding" label="Connect your agent" />
			</div>
		</div>
	)
}
