# Privacy

Kody handles account data, content you save, and requests to services you
connect. Use **Account settings** to export your data or delete your account.
For the hosted legal policy, see `/privacy`.

- [Account data and cookies](#what-kody-stores-per-account)
- [Connected services and Google data](#connected-accounts)
- [Session analytics](#session-analytics-opt-in)
- [Admin access](#what-a-deployment-admin-can-see) and
  [deployment operator access](#deployment-operator-access)
- [Retention](#how-long-kody-keeps-data),
  [service providers](#service-providers), and
  [your rights](#your-choices-and-rights)

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

Kody stores the following kinds of account data:

- **Profile:** email, username, optional display name and bio, profile
  visibility, the experiments opt-in at `/account/experiments`, and extra email
  destinations (including pending addresses until you confirm or remove them).
- **Attribution:** when present, first-touch UTM fields (`utm_source`,
  `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`), landing path, and
  referrer. If you sign up with a referral or add one from personal billing, the
  referral record holds your stable user ID, the credited personal or team org
  ID, reward status, and the Stripe invoice ID for a held or granted reward.
- **Usage:** first-seen activation timestamps (email verification, MCP
  connection, execute, saved package, secret, integration, and job), MCP client
  name when known, and last-active day stamps for return metrics.
- **Content and configuration:** credentials, memories, packages and their
  source, jobs, email inboxes and messages, durable storage, MCP server
  configuration, and OAuth grants.
- **Activity and submissions:** short-lived [execution history](./activity.md),
  stored community activity events, and platform feedback you approve for
  submission.

For visibility details, see
[public profiles](./community-packages.md#public-profiles),
[deployment admin access](#what-a-deployment-admin-can-see), and
[platform feedback](#platform-feedback).

If an org refers you, its
[billing summary](../../packages/worker/start/pages/account-billing.tsx) can
show your username, whether the referral is pending or rewarded, and the reward
date when recorded.

When you sign in to someone's package app with Sign in with Kody, people who
manage that app can see your username, display name, avatar, when you first
connected, when you last used the app, and what you allowed it to do. They never
see your credentials or their values. Revoking the app on **Account > Connected
apps** removes you from that list.

When profile visibility is **public**, display name, bio, public package
metadata, and public activity are visible on `/@username`. When visibility is
**private**, the public profile is not found. See
[Public packages](./community-packages.md#public-profiles).

### Browser cookies

Kody uses the session cookie (`kody_session`), the one-week last-wins referral
cookie (`kody_ref`) set by share links with `?ref=<username>` or
`?ref=<org slug>`, the one-week first-party first-touch cookie
(`kody_first_touch`) that keeps the UTMs, landing path, and referrer of your
first visit until signup reads and clears it, and the package-app session cookie
on `kody.run` (`__Host-kody_pkg_session_<hash>` on HTTPS,
`kody_pkg_session_<hash>` on HTTP; one cookie per package app on shared hosts).
Short-lived cookies support two-factor verification, passkey challenges, and
OAuth login. Analytics (Fathom and Scarf) are cookieless. The browser uses
sessionStorage for scroll restoration, not tracking cookies.

### Export and deletion

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
Your agent and package code use declared needs mapped to stable credential IDs.
Kody supplies the credential at the network boundary and never returns the raw
value to chat, search, package JS, or capability output.

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
deleted (stable user id, username, email, the create source, the signup
`created_at` on both events, the delete timestamp, and first-touch marketing
attribution fields when present). Referral rows are account data (export and
deletion) and are not included on those lifecycle events. Those lifecycle events
omit passwords, roles, plan, secrets, and unrelated account content. When a
guest account is claimed they may also receive a `user.guest_claimed` event with
the resulting account and guest identity, the claim method, the guest
timestamps, and how many items of each kind the guest had (counts only, never
their content, claim codes, or secret values). Admin-configured notification
packages may also receive a metadata-only `user.email_verification.failed` event
when signup/verify mail first hits a terminal delivery failure (stable user id,
username, email, status, `class` (`sender_block` / `other` / `null`), an admin
user URL, and `occurred_at`). That event omits SMTP transcripts, tokens, and
unrelated account content. Admin-configured notification packages may also
receive a metadata-only `user.email_verification.stalled` event when
signup/verify mail stays `accepted` for an hour with no Cloudflare lifecycle
event (stable user id, username, email, `accepted_at`, stall threshold, an admin
user URL, and `occurred_at`). That event omits SMTP transcripts, tokens, and
unrelated account content. Admin-configured notification packages may also
receive a metadata-only `user.email_outbound.paused` event when outbound sending
is paused after a spam complaint or repeated bounces (stable user id, username,
email, reason, bounce threshold when the reason is `bounced`, an admin user URL,
and `occurred_at`). That event omits SMTP transcripts, message bodies, and
unrelated account content. Admin-configured notification packages may also
receive `email.system-message.sent` when operator correspondence leaves a
reserved system sender (`kody@`, `support@`, and the other system locals). That
event includes the recipients, subject, and sent text/HTML because outbound
system mail is not stored on the inbound system-email graph; it is admin-only
and omits unrelated account content. Admin-configured notification packages may
also receive metadata-only `auth.denial.burst` or `email.delivery.burst` events
when hourly MCP auth denials or shared-domain bounce/complaint counts cross
their thresholds (count, threshold, window, insights URL, and `observed_at`).
Those events omit user identities, tokens, recipients, and message content.
Admin-configured notification packages may also receive a metadata-only
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

## Session analytics (opt-in)

Session analytics summarizes how agent sessions go: what kind of work they do,
how they end, and where they get stuck. It
[records calls only after your organization opts in](../../packages/worker/src/session-analytics/session-analytics.node.test.ts).
Manage the choice in **Organization settings** with
[`org:write` permission](../../packages/worker/src/app/handlers/org-settings.ts).

- [What Kody records](#what-kody-records-for-session-analytics)
- [How to view and delete counts](#view-and-delete-session-counts)
- [What staff and package publishers see](#cross-organization-session-insights)

### What Kody records for session analytics

Kody
[observes search and execute calls](../../packages/worker/src/session-analytics/record.ts)
and records the agent client, call and error counts, outcome, and the error kind
and tool where a session got stuck. A repeated failure can get one fixed hint.
The [open-session record](../../packages/worker/src/session-analytics/store.ts)
holds session links, counters, and public package IDs rather than package names
or source code.

Cloudflare Workers AI picks a work category such as “connect service” from the
short memory task description or, if it is missing, a task label derived from
search. The recorder
[does not persist the memory task description](../../packages/worker/src/session-analytics/session-analytics.node.test.ts);
the derived search label can be retained in the open-session record. The
[category labeler](../../packages/worker/src/session-analytics/labeler.ts)
checks the format of a new category name, then asks a second model that sees
only the proposed name to judge whether it contains user data. If neither an
existing category nor a new name passes selection, the session can remain
uncategorized.

### View and delete session counts

The [session store](../../packages/worker/src/session-analytics/store.ts) rolls
open sessions into daily counts after 30 minutes of inactivity or four hours
total, on the next matching call or the hourly sweep. The sweep prunes daily
counts past 400 days (about 13 months).

On the organization's **Session insights** page, view or delete one entry or all
entries. The
[insights handler](../../packages/worker/src/app/handlers/session-insights.ts)
scopes your personal view and deletes to your own counts in that organization
and requires `org:write` for the organization-wide scope.
[Turning analytics off](../../packages/worker/src/session-analytics/consent.ts)
deletes the organization's open sessions, session links, and daily counts in the
same batch as the settings change. Deleting an
[account](../../packages/worker/src/account/data-targets.ts) or
[organization](../../packages/worker/src/orgs/data-targets.ts) also removes its
counts.

### Cross-organization session insights

[Publisher totals and stuck-kind counts](../../packages/worker/src/session-analytics/session-analytics.node.test.ts)
appear when they cover at least 10 sessions from at least 5 organizations and
include no organization, person, or session IDs. The
[staff dashboard](https://kody.codes/admin/insights/sessions) shows 30-day
cross-organization insights. Its
[loader](../../packages/worker/src/session-analytics/insights.ts) applies the
same minimum to session totals, per-client and per-category counts, and stuck
patterns. It also shows the opt-in organization count, category names and
statuses, and combined label-check statistics outside that minimum.

Staff can mark a stuck pattern fixed to compare 14-day windows on each side of
the mark, or
[retire a category](../../packages/worker/src/session-analytics/session-analytics.node.test.ts)
to replace its name and remove its daily counts, including counts from
categories merged into it. See
[admin session analytics events](../guides/admin-events.md#session.stuck_pattern.crossed-session.category.merged-admins)
for the separate notification payloads and delivery schedule.

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
period. New submissions are refused while it has 100 or more active submissions
(open or triaged). Agents can read remaining quota from
`metaPlatformFeedbackList` (`submissions_remaining` and `next_slot_at`). Open
and triaged feedback remains until it is resolved, dismissed, or your account is
deleted. Resolved and dismissed feedback becomes eligible for pruning 365 days
after its last update and is removed by a later scheduled prune. Account
deletion removes any remaining submissions. When an admin resolves or dismisses
your feedback, Kody may email you from the platform sender with the decision,
thanks, and a way to send more feedback through your agent. That mail can
include a short outcome note and related PR links when the admin provides them;
the same values are stored on your feedback as `resolution_note` and
`resolution_pr_urls` so your agent can read them later. That mail is skipped if
your account has no email, outbound email is paused, or the account is
suspended. Internal admin notes are not included.

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
  removal when no active source, catalog listing, or repo session needs them
- Unverified person accounts: seven days after signup when the email is still
  unverified and no sign-in provider is linked

Deletion from a subprocessor's backups or logs follows that subprocessor's own
retention cycle. Records may be kept longer when required by law, needed to
resolve a dispute, or necessary to protect the service from abuse.

## Service providers

Kody uses these subprocessors to run the hosted service. They process only the
data needed for their role:

- Cloudflare — application hosting, database, object storage, email delivery,
  security, network infrastructure, and Workers AI embeddings, ranked-search
  scoring, and session analytics categories for organizations that turned
  session analytics on
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
