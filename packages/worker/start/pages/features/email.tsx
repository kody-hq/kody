import { publicAsset } from '../../public-assets.ts'
import { SiteLink } from '../../components/site-link.tsx'
import { Textarea } from '../../components/input.tsx'
import { FeatureRelated } from './feature-related.tsx'
import { FeatureCtaActions, FeatureCtaLink } from './feature-cta.tsx'
import { FeatureExample } from './feature-example.tsx'

const addresses = `you@inbox.kody.codes
  Your inbox. Nothing to create.

you+invoices@inbox.kody.codes
you+todo@inbox.kody.codes
  The same inbox, with a tag your
  package can branch on.`

const subscribe = `{
  "name": "@you/inbox-router",
  "kody": {
    "subscriptions": {
      "email.message.received": {
        "handler": "./src/on-email-message-received.ts",
        "description": "Route stored inbound mail by plus-tag."
      }
    }
  }
}`

const handler = `export default async function onEmailMessageReceived(event) {
  const to = event.message.to_addresses.join(',')
  if (!to.includes('+invoices@')) return { handled: false }
  // Fetch the body only when this tag should act.
  return { handled: true, messageId: event.message.id }
}`

export function EmailFeature() {
	return (
		<div className="study email">
			<div className="split">
				<div>
					<img
						className="feature-orb"
						src={publicAsset('/images/features/email.svg')}
						alt=""
						width="80"
						height="80"
					/>
					<h1>
						An inbox your agents
						<br />
						<em>can work from.</em>
					</h1>
					<p className="lead">
						Every Kody account has an email address. Mail that arrives is
						stored, can start a package you own, and your agent can search it,
						read it, and reply.
					</p>
					<FeatureCtaLink href="/onboarding">Connect your agent</FeatureCtaLink>
				</div>
				<div>
					<span className="example">Example inbox for the username you</span>
					<FeatureExample
						title="Agent inbox"
						tabsLabel="Email example"
						tabs={[
							{
								id: 'address',
								label: 'Address',
								summary:
									'Your inbox address, and plus-tagged addresses that reach the same inbox.',
								code: addresses,
							},
							{
								id: 'subscribe',
								label: 'Subscribe',
								summary:
									'A package subscribes to stored inbound mail in its package.json.',
								code: subscribe,
							},
							{
								id: 'handler',
								label: 'Handler',
								summary:
									'The handler checks the plus-tag and only acts on mail meant for it.',
								code: handler,
							},
						]}
					/>
				</div>
			</div>
			<section className="story-section">
				<div className="story-split">
					<div>
						<h2>
							Forward it to Kody.
							<br />
							Work starts.
						</h2>
						<p>
							Forward a thread, point a form at a plus-tag, or copy the inbox
							from a system that already sends email. Kody stores the message,
							then the packages you subscribed can run. No model has to read
							your mailbox first.
						</p>
						<p>
							Handlers get the message details first: who sent it, which address
							it reached, and the subject. They fetch the body or an attachment
							only when the message is theirs to handle.
						</p>
						<SiteLink href="/docs/agent-inbox">
							How the agent inbox works
						</SiteLink>
					</div>
					<div>
						<h3>Only senders you chose start work</h3>
						<p>
							A package runs for a message only when the sender authenticated
							and matches a sender rule you turned on: a member of your org, an
							exact address, or a domain. Mail that fails those checks is stored
							and runs nothing.
						</p>
						<p>
							Suspect mail is quarantined. You can allow, block, or quarantine
							senders, mark spam, and archive from the Email page in your
							workspace.
						</p>
					</div>
				</div>
			</section>
			<section className="story-section">
				<div className="story-split">
					<div>
						<h2>
							It can reply.
							<br />
							It can't mail the world.
						</h2>
						<p>
							Kody is not an open relay. Mail goes out from your own
							inbox.kody.codes address, never from someone else's.
						</p>
						<ul className="fx-points">
							<li>
								<strong>Send</strong> delivers only to addresses you verified as
								yours.
							</li>
							<li>
								<strong>Reply</strong> goes only to people on a message Kody
								already stored, and never to quarantined mail.
							</li>
							<li>
								<strong>Reply-all</strong> works only on threads you put the
								inbox on from one of your verified addresses.
							</li>
						</ul>
					</div>
					<div>
						<h3>Threads stay together</h3>
						<p>
							A reply comes from the exact address the original reached, tag
							included, and keeps the thread headers. A bot reached at{' '}
							<code>you+support@</code> stays on that address for the whole
							conversation.
						</p>
						<p>
							Sent mail records its delivery status, including bounces. Email
							needs a verified account email, and daily send and receive limits
							depend on your <SiteLink href="/pricing">plan</SiteLink>.
						</p>
					</div>
				</div>
				<div className="ms-next-agent">
					<h3>Try it with your agent.</h3>
					<div className="ms-prompt-pair">
						<div>
							<label htmlFor="email-build-prompt">Build an inbox handler</label>
							<Textarea
								id="email-build-prompt"
								readOnly
								value="Build a Kody package that watches my Kody inbox and only handles mail sent to my +todo address. On a match, store a one-line summary and email me a note. Ignore everything else."
							/>
						</div>
						<div>
							<label htmlFor="email-search-prompt">Ask about your mail</label>
							<Textarea
								id="email-search-prompt"
								readOnly
								value="Search my Kody inbox for the latest receipt and tell me the total."
							/>
						</div>
					</div>
				</div>
			</section>
			<FeatureRelated
				links={[
					{ href: '/features/triggers', label: 'Triggers and automation' },
					{ href: '/features/packages', label: 'Packages' },
					{ href: '/docs/wake-your-agent', label: 'Wake your agent' },
				]}
			/>
			<div className="feature-start">
				<div>
					<h2>Give people and systems an address that starts work.</h2>
					<p>
						<SiteLink href="/docs/agent-inbox">
							Read the agent inbox guide
						</SiteLink>
					</p>
				</div>
				<FeatureCtaActions href="/onboarding" label="Connect your agent" />
			</div>
		</div>
	)
}
