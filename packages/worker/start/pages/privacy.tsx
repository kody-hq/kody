/** @jsxImportSource @emotion/react */
import { SiteLink } from '../components/site-link.tsx'
import { type CSSObject } from '@emotion/react'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	sectionTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'
import { privacyRetentionPeriods } from '#universal/privacy-retention.ts'
import { privacyLastUpdated } from '#client/routes/legal-last-updated.ts'

export function PrivacyRoute() {
	return (
		<section css={pageCss}>
			<header css={pageHeaderCss}>
				<h1 css={pageTitleCss}>Privacy</h1>
				<p css={pageDescriptionCss}>
					What Kody collects, why it is needed, and the choices you have.
				</p>
				<p css={lastUpdatedCss}>
					Last updated:{' '}
					<time dateTime={privacyLastUpdated}>{privacyLastUpdated}</time>
				</p>
			</header>

			<section css={cardCss}>
				<h2 css={cardTitleCss}>Who is responsible for your data</h2>
				<p css={descriptionCss}>
					Kent C. Dodds, operator of Kody at kody.codes, is the data controller
					for the hosted service. You can reach the operator at{' '}
					<SiteLink href="mailto:support@kody.codes" css={mutedLinkCss}>
						support@kody.codes
					</SiteLink>
					. A separately operated Kody deployment has its own operator and data
					controller.
				</p>
				<p css={descriptionCss}>
					Kody processes personal data to perform the contract for account and
					assistant features, on legitimate interests for security, abuse
					prevention, and analytics, and with consent for product email.
				</p>
				<p css={descriptionCss}>
					Data is processed in the United States on Cloudflare&apos;s network.
					If you use Kody from outside the United States, you consent to that
					transfer.
				</p>
			</section>

			<section css={cardCss}>
				<h2 css={cardTitleCss}>What Kody stores per account</h2>
				<p css={descriptionCss}>
					Each signed-in user gets a fully isolated assistant. Kody stores
					account profile information (email, username, optional display name
					and bio, profile visibility, and the experiments opt-in preference at{' '}
					<code>/account/experiments</code>), first-touch marketing attribution
					captured on public-site visits when UTM or landing context is present
					and associated with the account at signup, first-seen activation
					timestamps (email verified, first MCP connection, first execute, first
					saved package, first secret, first integration, first job), MCP client
					name when known, last-active day stamps used for return metrics,
					secrets, memories, packages and their source, jobs, email inboxes and
					messages, durable storage, MCP server configuration, OAuth grants,
					package invocation tokens, short-lived execution history, stored
					community activity events, and any platform feedback you approve for
					submission. All of this remains scoped to your account except for
					content you deliberately make public (public packages published to
					Community and a public profile), the narrow admin review of approved
					platform feedback, and the community activity metadata described
					below.
				</p>
				<p css={descriptionCss}>
					When profile visibility is <strong>public</strong>, display name, bio,
					public package metadata, and public activity are visible on{' '}
					<code>/@username</code>. When visibility is <strong>private</strong>,
					the public profile is not found.
				</p>
			</section>

			<section css={cardCss}>
				<h2 css={cardTitleCss}>Connected accounts</h2>
				<p css={descriptionCss}>
					When you connect a third-party service — an OAuth app or API key you
					register yourself — Kody stores that connection in your account only:
					tokens, the scopes you granted, and host allowlists. OAuth access and
					refresh tokens, and a user-lane app client secret, are stored
					encrypted on that connection or app. Standalone credentials (PATs and
					API keys) stay in the encrypted secret store. Your agent and package
					code refer to them by name; Kody substitutes them at the network
					boundary and never returns the raw value to chat, search, or
					capability output.
				</p>
				<p css={descriptionCss}>
					Kody fetches data from a connected service only to fulfill a request
					you, or a job you saved, just made. Content a package or job persists
					(for example a saved summary) stays in your account under the same
					isolation rules. Kody does not sell that data, use it for advertising,
					share it with other Kody users, or use it to train a Kody model. Kody
					does not run its own chat-model agent loop and does not bill for chat
					tokens. Search and indexing call Cloudflare Workers AI for embeddings:
					the search query, plus indexed text for builtin capabilities, saved
					packages (manifest search fields, not full source), memories (subject,
					summary, details, and tags), jobs (name, description, and schedule),
					and public packages published to Community (name, description, tags,
					and a short readme snippet). Ranked search can send that query plus
					candidate cards (type, id, title, and summary) to Workers AI for
					scoring. Secret values and OAuth tokens are never sent to those
					models. Connected-account provider content is embedded or scored only
					if it was first saved as one of those indexed records or appears on a
					search candidate card.
				</p>
				<p css={descriptionCss}>
					<strong>Share, transfer, and disclose.</strong> Provider data leaves
					your isolated account only to Cloudflare, which hosts the application,
					database, object storage, network, and Workers AI embeddings and
					ranked-search scoring; the MCP host you connected (for example
					ChatGPT, Claude, or Cursor), when that host asks Kody to act and
					receives the result; the provider itself, when Kody calls its API with
					your token; and disclosure required by law. Kody does not hand
					connected-account data to other customers or advertisers.
				</p>
				<p css={descriptionCss}>
					<strong>Protection.</strong> Tokens and OAuth grants are encrypted at
					rest, isolated per user, and sent only to hosts you approved. The
					admin role cannot read secret values, secret metadata, or OAuth
					grants. You can disconnect a connection in Kody and revoke it at the
					provider.
				</p>
				<h3 css={subsectionTitleCss}>Google user data</h3>
				<p css={descriptionCss}>
					When you connect Google, the rules above apply to Google user data —
					Calendar, Docs, Sheets, Gmail send, Contacts, Tasks, YouTube, and any
					other Google scopes you grant. Kody uses Google user data only to
					fulfill your request or saved job. Kody stores Google OAuth tokens
					encrypted on that Google connection and does not use Google user data
					for advertising. Kody shares, transfers, or discloses Google user data
					only with Cloudflare (hosting, including Workers AI embeddings and
					ranked-search scoring for content first saved as an indexed record or
					shown on a search candidate card), the MCP host you connected when it
					asks Kody to act, Google when Kody calls Google APIs on your behalf,
					and when required by law.
				</p>
			</section>

			<section css={cardCss}>
				<h2 css={cardTitleCss}>What a deployment admin can see</h2>
				<p css={descriptionCss}>
					On shared deployments, operators can grant an admin role for account
					administration. Admins see account metadata: user id, username, email,
					email-verification state (including the latest verification-mail
					delivery outcome), entitlement plan, created and updated timestamps,
					role assignments, first-touch marketing attribution fields when
					present, activation first-seen timestamps, MCP client name, and
					last-active stamps. The account-administration UI lists users and
					roles; it does not expose account content. Platform feedback you
					explicitly approve for admin review is a narrow user-content
					exception.
				</p>
				<p css={descriptionCss}>
					Admins also moderate public packages in the Community catalog and
					community reports. Reporting a listing requires a signed-in user;
					reports are not anonymous — the reporter identity is attached. Admins
					can see who forked or rated a public listing, when, and the rating
					scores. One-click installs appear as forks because both use the same
					activity record. This activity view never includes private package
					source, rating notes, email, stable user ids, private profiles,
					secrets, or unrelated account content. Admin-configured notification
					packages may receive the same community metadata, and a metadata-only{' '}
					<code>user.created</code> or <code>user.deleted</code> event when a
					person account is created or self-deleted (stable user id, username,
					email, the create source and <code>created_at</code> or delete
					timestamp, and first-touch marketing attribution fields when present).
					Those lifecycle events omit passwords, roles, plan, secrets, and
					unrelated account content. Admin-configured notification packages may
					also receive a metadata-only{' '}
					<code>user.email_verification.failed</code> event when signup/verify
					mail first hits a terminal delivery failure (stable user id, username,
					email, status, <code>class</code> (<code>sender_block</code> /{' '}
					<code>other</code> / <code>null</code>), an admin user URL, and{' '}
					<code>occurred_at</code>). That event omits SMTP transcripts, tokens,
					and unrelated account content. Admin-configured notification packages
					may also receive a metadata-only{' '}
					<code>user.email_verification.stalled</code> event when signup/verify
					mail stays <code>accepted</code> for an hour with no Cloudflare
					lifecycle event (stable user id, username, email,{' '}
					<code>accepted_at</code>, stall threshold, an admin user URL, and{' '}
					<code>occurred_at</code>). That event omits SMTP transcripts, tokens,
					and unrelated account content. Admin-configured notification packages
					may also receive a metadata-only{' '}
					<code>user.email_outbound.paused</code> event when outbound sending is
					paused after a spam complaint or repeated bounces (stable user id,
					username, email, reason, bounce threshold when the reason is{' '}
					<code>bounced</code>, an admin user URL, and <code>occurred_at</code>
					). That event omits SMTP transcripts, message bodies, and unrelated
					account content. Admin-configured notification packages may also
					receive <code>email.system-message.sent</code> when operator
					correspondence leaves a reserved system sender (<code>kody@</code>,{' '}
					<code>support@</code>, and the other system locals). That event
					includes the recipients, subject, and sent text/HTML because outbound
					system mail is not stored on the inbound system-email graph; it is
					admin-only and omits unrelated account content. Admin-configured
					notification packages may also receive metadata-only{' '}
					<code>auth.denial.burst</code> or <code>email.delivery.burst</code>{' '}
					events when hourly MCP auth denials or shared-domain bounce/complaint
					counts cross their thresholds (count, threshold, window, insights URL,
					and <code>observed_at</code>
					). Those events omit user identities, tokens, recipients, and message
					content. Admin-configured notification packages may also receive a
					metadata-only <code>fleet.package_error_rate.elevated</code> event
					when package-runtime error rates rise (window bounds, per-metric
					counts and rates, public status URL, insights URL, and — when one
					account or a few accounts own the recent-window errors — those
					usernames and package name leaves). That event omits user ids, package
					UUIDs, emails, error strings, logs, and unrelated account content.
					Admin-configured notification packages may also receive a
					metadata-only <code>fleet.entitlement.crossed</code> event when a
					swept account first crosses 80% or 100% of a plan-limit resource, when
					a non-admin account first exceeds the monthly runtime-duration
					threshold, when a non-admin account first reaches a plan-aware unique
					Dynamic Worker cost threshold, or when a non-admin account first hits
					the execute cap on three of the last seven UTC days. Entitlement
					events include stable user id, username, resource counts, and admin
					dashboard URLs; runtime-duration events include stable user id,
					username, <code>total_duration_ms</code>, <code>threshold_ms</code>,
					and admin dashboard URLs; unique-worker-cost and repeated-execute
					events include the counts that tripped the threshold and admin
					dashboard URLs. These event kinds omit emails, plans, secrets, package
					source, and unrelated account content.
				</p>
			</section>

			<section css={cardCss}>
				<h2 css={cardTitleCss}>Platform feedback</h2>
				<p css={descriptionCss}>
					An agent may briefly describe Kody friction and ask whether you want
					it submitted. Nothing is submitted unless you explicitly approve.
					Feedback is attributed to your account and is not anonymous. Once you
					approve, the exact approved summary and details and your account user
					id, username, and email may be delivered immediately to admin review
					tools and admin-configured notifications such as Discord. No unrelated
					account content is delivered. Notifications can deep-link an admin to
					the read-only platform-feedback review surface. Admins can read and
					triage only the approved submission, and agents must omit secrets and
					unrelated private content.
				</p>
				<p css={descriptionCss}>
					Each account can create at most 10 feedback submissions in a rolling
					24-hour period and have at most 100 active submissions (open or
					triaged). Open and triaged feedback remains until it is resolved,
					dismissed, or your account is deleted. Resolved and dismissed feedback
					is removed 365 days after its last update. Your account export
					includes your submissions and their status, but not internal reviewer
					identity, notes, or timestamps. Account deletion removes any remaining
					submissions.
				</p>
				<p css={descriptionCss}>
					When a notification is still queued, Kody rechecks that the feedback
					exists immediately before delivery and cancels it after account
					deletion when possible. Kody cannot recall a copy already delivered
					outside Kody. Admin notification copies, including Discord messages,
					may remain after Kody account deletion under the deployment
					operator&apos;s retention and deletion controls. Those copies contain
					only the exact approved feedback and its attribution, never unrelated
					account content.
				</p>
			</section>

			<section css={cardCss}>
				<h2 css={cardTitleCss}>What an admin can never see</h2>
				<p css={descriptionCss}>
					The admin role is not a general data-access role. Approving platform
					feedback does not let admins browse:
				</p>
				<ul css={listCss}>
					<li>Secret values or secret metadata (names, scopes, allowlists)</li>
					<li>Package invocation tokens</li>
					<li>Memories</li>
					<li>Private packages and their source</li>
					<li>Jobs</li>
					<li>Email inboxes and messages</li>
					<li>Inbound webhook endpoints and delivery logs</li>
					<li>Durable storage contents</li>
					<li>Connected MCP server configuration and OAuth grants</li>
				</ul>
				<p css={descriptionCss}>
					None of this appears in any admin endpoint, page, or API payload — not
					even in redacted or count form — with one qualified exception:
					platform maintenance codemods, described next, surface package
					identity, affected file paths, and fixed migration messages (never
					file contents).
				</p>
			</section>

			<section css={cardCss}>
				<h2 css={cardTitleCss}>Platform maintenance (package codemods)</h2>
				<p css={descriptionCss}>
					When the platform&apos;s package API changes, Kody migrates published
					package source with package codemods: versioned, deterministic
					transforms that live in the open-source repository and ship through
					code review like any other platform change. Nobody can author an ad
					hoc transform through the admin surface — admins only choose when a
					published, reviewed codemod runs, and can scope it to a dry run first.
				</p>
				<p css={descriptionCss}>
					A codemod apply rewrites only what the reviewed transform matches,
					runs the same checks as a normal publish, records a{' '}
					<code>codemod(&lt;id&gt;): ...</code> commit in the package&apos;s own
					git history, keeps a revert snapshot, and dispatches a{' '}
					<code>package.codemod.applied</code> (or <code>.reverted</code>) event
					your packages can subscribe to. Unlocked packages also advance{' '}
					<code>published_commit</code>. Locked packages still get that commit
					on HEAD so the owner can review and promote it later; fleet apply does
					not skip them. Fleet runs are audit-logged.
				</p>
				<p css={descriptionCss}>
					Running a codemod never shows an admin your source. Scan and run
					results expose only package identity (ids), affected file paths, and
					the codemod&apos;s own fixed finding messages — codemods are forbidden
					from embedding file contents in their findings. Ambiguous matches are
					skipped and reported for the owner rather than rewritten.
				</p>
			</section>

			<section css={cardCss}>
				<h2 css={cardTitleCss}>How long Kody keeps data</h2>
				<p css={descriptionCss}>
					Account content such as packages, secrets, memories, jobs, and durable
					storage remains available while your account and that content exist.
					You can delete individual content or the whole account. Some
					operational records have fixed cleanup periods:
				</p>
				<ul css={listCss}>
					{privacyRetentionPeriods.map((period) => (
						<li key={period}>{period}</li>
					))}
				</ul>
				<p css={descriptionCss}>
					Deletion from a subprocessor&apos;s backups or logs follows that
					subprocessor&apos;s own retention cycle. Records may be kept longer
					when required by law, needed to resolve a dispute, or necessary to
					protect the service from abuse.
				</p>
			</section>

			<section css={cardCss}>
				<h2 css={cardTitleCss}>Service providers</h2>
				<p css={descriptionCss}>
					Kody uses these subprocessors to run the hosted service. They process
					only the data needed for their role:
				</p>
				<ul css={listCss}>
					<li>
						Cloudflare — application hosting, database, object storage, email
						delivery, security, network infrastructure, and Workers AI
						embeddings and ranked-search scoring
					</li>
					<li>Stripe — paid subscriptions, billing, and payment records</li>
					<li>
						Kit — product email subscriptions when you submit your email for
						those purposes
					</li>
					<li>
						Sentry — application error reporting and operational diagnostics
					</li>
					<li>Fathom — privacy-focused website traffic analytics</li>
				</ul>
				<p css={descriptionCss}>
					The only cookies are the session cookie (<code>kody_session</code>),
					the one-week last-wins referral cookie (<code>kody_ref</code>) set by{' '}
					<code>/signup?ref=&lt;username&gt;</code> share links, and the
					package-app session cookie on <code>kody.run</code> (
					<code>__Host-kody_pkg_session_&lt;hash&gt;</code> on HTTPS,{' '}
					<code>kody_pkg_session_&lt;hash&gt;</code> on HTTP; one cookie per
					package app on shared hosts). Short-lived cookies support two-factor
					verification, passkey challenges, and OAuth login. Analytics (Fathom)
					is cookieless. The browser uses sessionStorage for first-touch signup
					attribution and scroll restoration, not tracking cookies.
				</p>
			</section>

			<section css={cardCss}>
				<h2 css={cardTitleCss}>Your choices and rights</h2>
				<p css={descriptionCss}>
					Use Account settings to export a copy of your Kody data or delete your
					account. Deletion asks you to type GOODBYE KODY in a confirmation
					modal, and to re-enter your password when the account has one. You can
					also ask to access, correct, delete, restrict, or receive your
					personal data, or object to its processing, by emailing{' '}
					<SiteLink href="mailto:support@kody.codes" css={mutedLinkCss}>
						support@kody.codes
					</SiteLink>
					. Which rights apply depends on where you live. We may need to verify
					your identity before acting on a request.
				</p>
				<p css={descriptionCss}>
					You also have the right to lodge a complaint with a supervisory
					authority where you live, including in the EEA or the United Kingdom.
				</p>
				<p css={descriptionCss}>
					We do not sell or share personal information as defined by the
					CCPA/CPRA.
				</p>
			</section>

			<section css={cardCss}>
				<h2 css={cardTitleCss}>Deployment operator access</h2>
				<p css={descriptionCss}>
					Role-based access controls the application surface. Whoever operates
					the deployment — holding the Cloudflare account, D1 database access,
					and <code>SECRET_STORE_KEY</code> — sits outside any application-level
					control. The admin role grants no infrastructure access, and
					infrastructure access requires no admin role.
				</p>
			</section>

			<p css={{ margin: 0 }}>
				<SiteLink href="/pricing" css={mutedLinkCss}>
					Pricing
				</SiteLink>
				{' · '}
				<SiteLink href="/terms" css={mutedLinkCss}>
					Terms
				</SiteLink>
				{' · '}
				<SiteLink href="/" css={mutedLinkCss}>
					Back home
				</SiteLink>
			</p>
		</section>
	)
}

const pageCss: CSSObject = {
	...stackedPageCss,
	maxWidth: '42rem',
	margin: '0 auto',
}

const lastUpdatedCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const listCss: CSSObject = {
	margin: `${spacing.sm} 0 0`,
	paddingLeft: spacing.lg,
	color: colors.text,
	display: 'grid',
	gap: spacing.xs,
	fontSize: typography.fontSize.sm,
	lineHeight: 1.6,
}

const subsectionTitleCss: CSSObject = {
	...sectionTitleCss,
	marginTop: spacing.md,
}
