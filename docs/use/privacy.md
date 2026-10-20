# Privacy

How Kody stores your data, how connected accounts work, and what a deployment
admin can see. The hosted legal policy is `/privacy`.

## Who is responsible for your data

Kent C. Dodds, operator of Kody at kody.codes, is the data controller for the
hosted service (`support@kody.codes`). A separately operated Kody deployment has
its own operator and data controller.

Kody processes personal data to perform the contract for account and assistant
features, on legitimate interests for security, abuse prevention, and analytics,
and with consent for product email. Data is processed in the United States on
Cloudflare's network. If you use Kody from outside the United States, you
consent to that transfer.

## What Kody stores per account

Each signed-in account holds isolated data for that person or team org. Kody
stores account profile information (email, username, optional display name and
bio, profile visibility, the experiments opt-in preference at
`/account/experiments`, and extra email destinations, including pending
unverified extras until you confirm or remove them), first-touch marketing
attribution captured on public-site visits when UTM or landing context is
present and associated with the account at signup (`utm_source` / `utm_medium` /
`utm_campaign` / `utm_content` / `utm_term`, landing path, and referrer),
referral attribution when a signup used a `kody_ref` cookie from
`?ref=<username>` (the referred and referring stable user ids, reward status,
and the Stripe invoice id after a paid reward), first-seen activation timestamps
(email verified, first MCP connection, first execute, first saved package, first
secret, first integration, first job), MCP client name when known, last-active
day stamps used for return metrics, credentials, memories, packages and their
source, jobs, email inboxes and messages, durable storage, MCP server
configuration, OAuth grants, short-lived execution history (see
[Activity](./activity.md)), stored community activity events, and any platform
feedback you approve for submission. All of this remains scoped to your account
except for content you deliberately make public (public packages published to
Community and a public profile), the narrow admin review of approved platform
feedback, and the community activity metadata described below.

When profile visibility is **public**, display name, bio, public package
metadata, and public activity are visible on `/@username`. When visibility is
**private**, the public profile is not found. See
[Public packages](./community-packages.md#public-profiles).

The only cookies are the session cookie (`kody_session`), the one-week last-wins
referral cookie (`kody_ref`) set by `/signup?ref=<username>` share links, and
the package-app session cookie on `kody.run` (`__Host-kody_pkg_session_<hash>`
on HTTPS, `kody_pkg_session_<hash>` on HTTP; one cookie per package app on
shared hosts). Short-lived cookies support two-factor verification, passkey
challenges, and OAuth login. Analytics (Fathom and Scarf) are cookieless. The
browser uses sessionStorage for first-touch signup attribution and scroll
restoration, not tracking cookies.

Account export includes your profile columns and activity you authored. The
browser download is a bounded metadata manifest; use its `accountExportSection`
instructions to retrieve every D1, Durable Object, and R2 page for a complete
portable export. Account settings can delete the account after you type
`GOODBYE KODY` in a confirmation modal (and re-enter your password when the
account has one), and can change a password or set one on an account that
currently signs in only with a connected provider or passkey. Account deletion
removes those same user-owned rows and objects.

## Connected accounts

When you connect a third-party service — an OAuth app or API key you register
yourself — Kody stores that connection in your account only: tokens, the scopes
you granted, and host allowlists. OAuth access and refresh tokens, and a
user-lane app client secret, are stored encrypted on that connection or app.
Standalone credentials (PATs and API keys) stay in the encrypted secret store.
Your agent and package code refer to them by name (or by opaque `{{secret:…}}`
refs from `packageSecrets.get`); Kody substitutes them at the network boundary
and never returns the raw value to chat, search, package JS, or capability
output.

Kody fetches data from a connected service only to fulfill a request you, or a
job you saved, just made. Content a package or job persists (for example a saved
summary) stays in your account under the same isolation rules. Kody does not
sell that data, use it for advertising, share it with other Kody users, or use
it to train a Kody model. Kody does not run its own chat-model agent loop and
does not bill for chat tokens. Search and indexing call Cloudflare Workers AI
for embeddings: the search query, plus indexed text for builtin capabilities,
saved packages (manifest search fields, not full source), memories (subject,
summary, details, and tags), jobs (name, description, and schedule), and public
packages published to Community (name, description, tags, and a short readme
snippet). Ranked search can send that query plus candidate cards (type, id,
title, and summary) to Workers AI for scoring. Secret values and OAuth tokens
are never sent to those models. Connected-account provider content is embedded
or scored only if it was first saved as one of those indexed records or appears
on a search candidate card.

**Share, transfer, and disclose.** Provider data leaves your isolated account
only to Cloudflare, which hosts the application, database, object storage,
network, and Workers AI embeddings and ranked-search scoring; the MCP host you
connected (for example ChatGPT, Claude, or Cursor), when that host asks Kody to
act and receives the result; the provider itself, when Kody calls its API with
your token; and disclosure required by law. Kody does not hand connected-account
data to other customers or advertisers.

**Protection.** Tokens and OAuth grants are encrypted at rest, isolated per
user, and sent only to hosts you approved. The admin role cannot read secret
values, secret metadata, or OAuth grants. You can disconnect a connection in
Kody and revoke it at the provider.

### Google user data

When you connect Google, the rules above apply to Google user data — Calendar,
Docs, Sheets, Gmail send, Contacts, Tasks, YouTube, and any other Google scopes
you grant. Kody uses Google user data only to fulfill your request or saved job.
Kody stores Google OAuth tokens encrypted on that Google connection and does not
use Google user data for advertising. Kody shares, transfers, or discloses
Google user data only with Cloudflare (hosting, including Workers AI embeddings
and ranked-search scoring for content first saved as an indexed record or shown
on a search candidate card), the MCP host you connected when it asks Kody to
act, Google when Kody calls Google APIs on your behalf, and when required by
law.

## What a deployment admin can see

On shared deployments, operators can grant an admin role for account
administration. Admins see account metadata: user id, username, email,
email-verification state (including the latest verification-mail delivery
outcome), entitlement plan, created and updated timestamps, role assignments,
first-touch marketing attribution fields when present, activation first-seen
timestamps, MCP client name, and last-active stamps. The account-administration
UI lists users and roles; it does not expose account content.

Platform feedback you explicitly approve for admin review is a narrow
user-content exception.

Admins also moderate public packages in the Community catalog and community
reports. Reporting a listing requires a signed-in user; reports are **not**
anonymous — the reporter identity is attached. Admins can see who forked or
rated a public listing, when, and the rating scores. One-click installs appear
as forks because both use the same activity record. This activity view never
includes private package source, rating notes, email, stable user ids, private
profiles, secrets, or unrelated account content. Admin-configured notification
packages may receive the same community metadata, and a metadata-only
`user.created` or `user.deleted` event when a person account is created or
self-deleted (stable user id, username, email, the create source and
`created_at` or delete timestamp, and first-touch marketing attribution fields
when present). Referral rows are account data (export and deletion) and are not
included on those lifecycle events. Those lifecycle events omit passwords,
roles, plan, secrets, and unrelated account content. Admin-configured
notification packages may also receive a metadata-only
`user.email_verification.failed` event when signup/verify mail first hits a
terminal delivery failure (stable user id, username, email, status, `class`
(`sender_block` / `other` / `null`), an admin user URL, and `occurred_at`). That
event omits SMTP transcripts, tokens, and unrelated account content.
Admin-configured notification packages may also receive a metadata-only
`user.email_verification.stalled` event when signup/verify mail stays `accepted`
for an hour with no Cloudflare lifecycle event (stable user id, username, email,
`accepted_at`, stall threshold, an admin user URL, and `occurred_at`). That
event omits SMTP transcripts, tokens, and unrelated account content.
Admin-configured notification packages may also receive a metadata-only
`user.email_outbound.paused` event when outbound sending is paused after a spam
complaint or repeated bounces (stable user id, username, email, reason, bounce
threshold when the reason is `bounced`, an admin user URL, and `occurred_at`).
That event omits SMTP transcripts, message bodies, and unrelated account
content. Admin-configured notification packages may also receive
`email.system-message.sent` when operator correspondence leaves a reserved
system sender (`kody@`, `support@`, and the other system locals). That event
includes the recipients, subject, and sent text/HTML because outbound system
mail is not stored on the inbound system-email graph; it is admin-only and omits
unrelated account content. Admin-configured notification packages may also
receive metadata-only `auth.denial.burst` or `email.delivery.burst` events when
hourly MCP auth denials or shared-domain bounce/complaint counts cross their
thresholds (count, threshold, window, insights URL, and `observed_at`). Those
events omit user identities, tokens, recipients, and message content.
Admin-configured notification packages may also receive a metadata-only
`fleet.package_error_rate.elevated` event when package-runtime error rates rise
(window bounds, per-metric counts and rates, public status URL, insights URL,
and — when one account or a few accounts own the recent-window errors — those
usernames and package name leaves). That event omits user ids, package UUIDs,
emails, error strings, logs, and unrelated account content. Admin-configured
notification packages may also receive a metadata-only
`fleet.entitlement.crossed` event when a swept account first crosses 80% or 100%
of a plan-limit resource, when a non-admin account first exceeds the monthly
runtime-duration threshold, when a non-admin account first reaches a plan-aware
unique Dynamic Worker cost threshold, or when a non-admin account first hits the
execute cap on three of the last seven UTC days. Entitlement events include
stable user id, username, resource counts, and admin dashboard URLs;
runtime-duration events include stable user id, username, `total_duration_ms`,
`threshold_ms`, and admin dashboard URLs; unique-worker-cost and
repeated-execute events include the counts that tripped the threshold and admin
dashboard URLs. These event kinds omit emails, plans, secrets, package source,
and unrelated account content.

## Platform feedback

When an agent encounters meaningful Kody friction, a Kody bug, a poor
experience, or a suggestion, it may briefly explain the issue and ask whether
you want it submitted. The agent submits nothing unless you explicitly approve.
Normal third-party or authentication failures do not automatically become
platform feedback, though you can ask to submit any Kody-related issue.

Feedback is attributed to your authenticated account and is not anonymous. Admin
list results intentionally omit the full submission. Once you approve, the exact
approved summary and details and your account user id, username, and email may
be delivered immediately to admin review tools and admin-configured
notifications such as Discord. No unrelated account content is delivered.
Notifications can deep-link an admin to the read-only platform-feedback review
surface. An admin can open the approved submission to read and triage it, but
that does not grant access to your packages, memories, email, secrets, or other
account content. Agents must omit secrets and unrelated private content from the
feedback they prepare.

Each account can create at most 20 feedback submissions in a rolling 24-hour
period and have at most 100 active submissions (open or triaged). Agents can
read remaining quota from `metaPlatformFeedbackList` (`submissions_remaining`
and `next_slot_at`). Open and triaged feedback remains until it is resolved,
dismissed, or your account is deleted. Resolved and dismissed feedback is
removed 365 days after its last update. Account deletion removes any remaining
submissions. When an admin resolves or dismisses your feedback, Kody may email
you from the platform sender with the decision, thanks, and a way to send more
feedback through your agent. That mail can include a short outcome note and
related PR links when the admin provides them; the same values are stored on
your feedback as `resolution_note` and `resolution_pr_urls` so your agent can
read them later. That mail is skipped if your account has no email, outbound
email is paused, or the account is suspended. Internal admin notes are not
included.

When a notification is still queued, Kody rechecks that the feedback exists
immediately before delivery and cancels it after account deletion when possible.
Kody cannot recall a notification copy that was already delivered outside Kody.
Admin notification copies, including Discord messages, may remain after Kody
account deletion under the deployment operator's retention and deletion
controls. Those copies contain only the exact approved feedback and its
attribution described above, never unrelated account content.

Your account export includes your own submissions, their status, and any
submitter-visible resolution fields. Internal reviewer identity, notes, and
timestamps are not included. If an admin who reviewed your feedback deletes
their account, Kody clears that reviewer's attribution while retaining your
submission for the lifecycle described above.

Community ratings, stored activity events, forks, and reports appear only in the
participating user's account export. Owning the related listing does not expose
another user's event timestamps or types, identity, rating or adoption notes,
report reasons, or moderation details.

## What an admin can never see

The admin role is not a general data-access role. Approving platform feedback
does not let admins browse:

- Secret values or secret metadata (names, scopes, allowlists)
- Memories
- Private packages and their source
- Jobs
- Email inboxes and messages
- Inbound webhook endpoints and delivery logs
- Durable storage contents
- Connected MCP server configuration and OAuth grants

None of these stores appears in an admin endpoint, page, or API payload — not
even in redacted or count form — with one qualified exception: platform
maintenance codemods, described next, surface package identity, affected file
paths, and fixed migration messages (never file contents).

## Platform maintenance (package codemods)

When the platform's package API changes, Kody migrates published package source
with **package codemods**: versioned, deterministic transforms that live in the
open-source repository and ship through code review like any other platform
change. Nobody can author an ad hoc transform through the admin surface — admins
only choose when a published, reviewed codemod runs, and can scope it to a dry
run first.

A codemod apply rewrites only what the reviewed transform matches, runs the same
checks as a normal publish, records a `codemod(<id>): ...` commit in the
package's own git history, keeps a revert snapshot, and dispatches a
`package.codemod.applied` (or `.reverted`) event your packages can subscribe to.
Unlocked packages also advance `published_commit`. Locked packages still get
that commit on HEAD so the owner can review and promote it later; fleet apply
does not skip them. Fleet runs are audit-logged.

Running a codemod never shows an admin your source. Scan and run results expose
only package identity (ids), affected file paths, and the codemod's own fixed
finding messages — codemods are forbidden from embedding file contents in their
findings. Ambiguous matches are skipped and reported for the owner rather than
rewritten.

## How long Kody keeps data

Account content such as packages, secrets, memories, jobs, and durable storage
remains available while your account and that content exist. You can delete
individual content or the whole account. Some operational records have fixed
cleanup periods:

- Email delivery events: 90 days
- Email messages and their attachments: 365 days
- Completed workflow runs and conversation-suppression records: 90 days
- Resolved or dismissed platform feedback: 365 days after its last update; open
  or triaged feedback remains until it is resolved, dismissed, or the account is
  deleted
- Audit events: 180 days
- Feature-flag exposure records: 90 days
- Daily entitlement counters: 400 days
- Monthly usage rollups: 24 months
- Durable Object duration attribution: until account deletion
- Stripe webhook event records: 30 days
- Non-current published bundle artifacts: at least 30 days, then eligible for
  removal when no active source or repo session needs them
- Unverified person accounts: seven days after signup when the email is still
  unverified and no sign-in provider is linked

Deletion from a subprocessor's backups or logs follows that subprocessor's own
retention cycle. Records may be kept longer when required by law, needed to
resolve a dispute, or necessary to protect the service from abuse.

## Service providers

Kody uses these subprocessors to run the hosted service. They process only the
data needed for their role:

- Cloudflare — application hosting, database, object storage, email delivery,
  security, network infrastructure, and Workers AI embeddings and ranked-search
  scoring
- Stripe — paid subscriptions, billing, and payment records
- Kit — product email subscriptions when you submit your email for those
  purposes
- Sentry — application error reporting and operational diagnostics
- Fathom — privacy-focused website traffic analytics
- Scarf — company-level analytics on public marketing pages and docs. We send
  the public page path, without query strings or fragments. Scarf uses the
  request IP address to identify companies, discards the raw IP address, and
  does not set cookies. We skip these requests when your browser sends Global
  Privacy Control or Do Not Track.

## Your choices and rights

Use Account settings to export a copy of your Kody data or delete your account.
Deletion asks you to type `GOODBYE KODY` in a confirmation modal, and to
re-enter your password when the account has one. You can also ask to access,
correct, delete, restrict, or receive your personal data, or object to its
processing, by emailing `support@kody.codes`. Which rights apply depends on
where you live. We may need to verify your identity before acting on a request.

You also have the right to lodge a complaint with a supervisory authority where
you live, including in the EEA or the United Kingdom.

We do not sell or share personal information as defined by the CCPA/CPRA.

## Deployment operator access

Role-based access controls the application surface. Whoever operates the
deployment — holding the Cloudflare account, D1 database access, and
`SECRET_STORE_KEY` — sits outside any application-level control. The admin role
grants no infrastructure access, and infrastructure access requires no admin
role.
