---
title: Kody weekly: Team orgs, CLI sign-in, and shorter app URLs
date: 2026-10-23
description: Team orgs, CLI OAuth sign-in, shorter package app URLs, and 7 more features, plus smaller updates and fixes.
order: 1
category: updates
---

Here is what shipped in Kody from October 17 to October 23, 2026. This week your
org can grow from one person to a team, the CLI and sign-up flows got real
sign-in, and package apps, credentials, and publishing all became easier to
reason about.

## Turn your personal org into a team org

### What shipped

From Account settings you can now convert your personal org into a team org. The
team org keeps the current handle, packages, webhooks, email, and plan. Kody
creates a new free personal org with a new username for you and moves your
memories, secrets, integrations, and connected-agent grants there. The
conversion is one-way and asks for typed confirmation. Deleted orgs also get a
**Recently deleted** section with a **Restore** button during their restore
window, and recreating a handle you deleted offers a restore instead of "That
name is taken."

### Why it matters

Projects that start with one person often pick up collaborators. Converting
keeps the URLs and automations people already use, so you can invite a teammate
without moving packages by hand. And deleting an org by mistake is no longer
final.

### Example

1. Open Account settings and choose to convert your personal org.
2. Pick the username for your new personal org and type the confirmation.
3. Invite teammates to the team org from its Members page.

Docs: [Organizations](https://kody.codes/docs/organizations) · PRs:
[#3953](https://github.com/kody-hq/kody/pull/3953),
[#3950](https://github.com/kody-hq/kody/pull/3950)

## Sign the CLI in with OAuth and a revocable device token

### What shipped

`kody login` now runs a proper OAuth flow in your browser and mints a revocable
device token for the CLI. Search, execute, whoami, and bootstrap call Kody's
versioned HTTP API instead of relying on MCP-only auth. Login also binds to the
org you grant.

### Why it matters

The CLI gets its own credential that you can revoke like any other token, and it
talks to the same documented API your scripts can use. Agents and humans sign in
the same way.

### Example

```sh
kody login
kody whoami
```

Docs: [Open API](https://kody.codes/docs/open-api) · PR:
[#3940](https://github.com/kody-hq/kody/pull/3940)

## Choose your permanent username before your account exists

### What shipped

First-time social sign-in no longer invents a username for you. After the
provider confirms who you are, Kody sends you to a username page with live
availability checks and suggestions, and creates your account only after you
confirm. Password and social sign-up share the same flow.

### Why it matters

Usernames are permanent and show up in your package and app URLs. Picking one
yourself means you never get stuck with a generated handle.

### Example

1. Choose **Sign up with Google** (or another provider) on kody.codes.
2. Type the username you want and pick one that shows as available.
3. Confirm, and Kody creates your account with that username.

PR: [#4151](https://github.com/kody-hq/kody/pull/4151)

## A workspace with persistent navigation and a usage overview

### What shipped

The signed-in workspace now has a persistent, responsive sidebar with org
switching, grouped navigation, and a Resources section. The overview page shows
recent repositories, activity, upcoming jobs, and three charts: daily execution
outcomes, activity by source, and monthly credits spent by package.

### Why it matters

You can move between orgs and sections without losing your place, and see at a
glance what ran, what failed, and which packages spend your credits.

### Example

Open your workspace, switch orgs from the sidebar, and check the overview's
credits chart to see which package spent the most this month.

PR: [#4153](https://github.com/kody-hq/kody/pull/4153)

## Shorter URLs for hosted package apps

### What shipped

Hosted package apps now live at `{user}.kody.run/{name}` instead of the longer
`/packages/{name}` path. Old URLs keep working: browser visits get a permanent
redirect, and other traffic is still served. The package page has a single
**Open app** button that goes through a `/open` handoff path, and every app host
serves a default `/robots.txt`.

### Why it matters

App links are shorter and easier to share, and you do not need to update any
link you already sent.

### Example

```text
Before: https://you.kody.run/packages/my-app
After:  https://you.kody.run/my-app
```

Docs: [Package apps](https://kody.codes/docs/package-apps) · PRs:
[#4096](https://github.com/kody-hq/kody/pull/4096),
[#4101](https://github.com/kody-hq/kody/pull/4101),
[#4103](https://github.com/kody-hq/kody/pull/4103),
[#4107](https://github.com/kody-hq/kody/pull/4107),
[#4092](https://github.com/kody-hq/kody/pull/4092)

## Choose where Kody fills each credential

### What shipped

When you create or edit a secret or connection, you can now choose where Kody
may inject it: headers only, body, or query string. New credentials default to
headers only. The credential page shows the current placement with an **Edit
fill placement** action, MCP and the CLI show the same setting, and publish and
`kody dev check` warn when they cannot prove a package only uses headers. This
week Kody records fills that a stricter placement would block, without refusing
them.

### Why it matters

Query strings end up in access logs and bodies can end up in saved records. A
placement setting lets you keep a credential where it belongs, and the observe
step shows you what would change before anything is enforced.

### Example

1. Create a new secret and leave the default **Headers** placement checked.
2. Open the credential's page to see its fill placement summary.
3. Use **Edit fill placement** if a provider needs the value in the body.

Docs: [Credentials](https://kody.codes/docs/credentials) · PRs:
[#4081](https://github.com/kody-hq/kody/pull/4081),
[#3994](https://github.com/kody-hq/kody/pull/3994)

## Connect integrations with OAuth device authorization

### What shipped

Integrations whose provider supports OAuth device authorization (RFC 8628) can
now connect without a browser redirect. Kody shows a user code, a verification
link, and an expiry countdown, polls the provider, and saves the tokens the same
way a regular OAuth connect does. The device code and client secret never leave
the server.

### Why it matters

Some providers and devices cannot complete a redirect back to Kody. Device
authorization lets you approve the connection from any browser, including on
your phone.

### Example

1. Configure an OAuth app with a device authorization URL and the device flow.
2. Start the connection and open the verification link Kody shows.
3. Enter the code there and approve. Kody finishes the connection on its own.

Docs: [OAuth](https://kody.codes/docs/oauth) · PRs:
[#3980](https://github.com/kody-hq/kody/pull/3980),
[#3995](https://github.com/kody-hq/kody/pull/3995)

## Catch publish problems before you push

### What shipped

`kody dev check` now runs the same publish checks the server runs, so a commit
that passes it no longer fails at publish on the credential gate. A read-only
`POST /v1/packages/check` endpoint backs it. When a package needs approval to
publish, Kody now lists the exact storage identifiers, mounts, jobs, or webhooks
that require it, and the approval page shows failures inline.
`kody package publish` exits with code 1 on refusals such as failed checks,
locks, approval required, or non-fast-forward, and network failures say whether
the request was sent.

### Why it matters

Scripts and CI stop on a refused publish instead of carrying on, and you find
out why a package cannot publish while you are still in your editor.

### Example

```sh
kody dev check
kody package publish || echo "publish refused, see the message above"
```

Docs: [Package lifecycle](https://kody.codes/docs/package-lifecycle) · PRs:
[#4127](https://github.com/kody-hq/kody/pull/4127),
[#4094](https://github.com/kody-hq/kody/pull/4094),
[#4079](https://github.com/kody-hq/kody/pull/4079),
[#4077](https://github.com/kody-hq/kody/pull/4077),
[#4146](https://github.com/kody-hq/kody/pull/4146)

## Error spike emails for package owners

### What shipped

When one of your packages hits at least 20 errors at a 25% or higher error rate
in an hour, Kody sends one email to your org's owners. You get no repeat emails
while the spike lasts, and the alert re-arms after two healthy hours or 24 hours
of quiet.

### Why it matters

You hear about a package that started failing without watching a dashboard, and
one email per episode keeps it from turning into noise.

### Example

Keep your org owner's email address current in Account settings. If a published
package starts failing, the owner gets a single spike email for that episode.

PR: [#4080](https://github.com/kody-hq/kody/pull/4080)

## More updates

- **Credentials:** Separates Disconnect, which clears a credential's value but
  keeps its setup, from Delete, which removes it.
  ([docs](https://kody.codes/docs/credentials),
  [#4098](https://github.com/kody-hq/kody/pull/4098))
- **Credentials:** Warns on publish and save when a package fills a user
  credential whose allowed-packages list does not include it, with a link to
  approve it. ([docs](https://kody.codes/docs/secrets),
  [#4009](https://github.com/kody-hq/kody/pull/4009))
- **Credentials:** Shows expired package Keys as Expired instead of missing, and
  names the credential when a value placed in a URL path causes upstream 4xx
  errors. ([#4131](https://github.com/kody-hq/kody/pull/4131),
  [#4148](https://github.com/kody-hq/kody/pull/4148))
- **Orgs:** Adds Hermes Agent as a supported agent.
  ([#3954](https://github.com/kody-hq/kody/pull/3954))
- **Dashboard:** Rolls out the new Kody koala mark across the web app, with a
  public `/brand-guide` page for every format.
  ([#4157](https://github.com/kody-hq/kody/pull/4157),
  [#4161](https://github.com/kody-hq/kody/pull/4161))
- **Dashboard:** Makes light mode lighter and the workspace type scale tighter.
  ([#4135](https://github.com/kody-hq/kody/pull/4135))
- **Platform:** Shows how many platform feedback submissions you have left (now
  20 a day), and returns resolution notes and linked PRs on your feedback.
  ([#4037](https://github.com/kody-hq/kody/pull/4037),
  [#4118](https://github.com/kody-hq/kody/pull/4118))
- **Platform:** Keeps open browser tabs working across Kody deploys.
  ([#4022](https://github.com/kody-hq/kody/pull/4022),
  [#4021](https://github.com/kody-hq/kody/pull/4021))

## Fixes

- **Automations:** Fixes Run now overwriting a package job's storage context,
  and webhook deliveries with an `Idempotency-Key` being dropped after a retry.
  ([#4147](https://github.com/kody-hq/kody/pull/4147),
  [#4144](https://github.com/kody-hq/kody/pull/4144))
- **Automations:** Fixes a job with an unresolved Promise hanging the scheduler
  and staying `running`. ([#4138](https://github.com/kody-hq/kody/pull/4138))
- **MCP:** Fixes connecting one OpenAI client, such as ChatGPT or Codex, signing
  out another. ([#4154](https://github.com/kody-hq/kody/pull/4154))
- **Packages:** Fixes `git fetch` and `git pull` failing with "bad pack header"
  on existing clones. ([#4060](https://github.com/kody-hq/kody/pull/4060))
- **Community:** Fixes profile package lists appearing empty for their own
  owner. ([#4095](https://github.com/kody-hq/kody/pull/4095))
- **Billing:** Fixes the credit attribution dashboard not updating.
  ([#4163](https://github.com/kody-hq/kody/pull/4163))
- **Dashboard:** Fixes the account sidebar rail jumping on short lists.
  ([#4010](https://github.com/kody-hq/kody/pull/4010))
- **CLI:** Tightens local dev server request checks.
  ([#3969](https://github.com/kody-hq/kody/pull/3969))

## Try it

- Run `kody login` and approve the sign-in in your browser to get a revocable
  device token.
- Open a package app at its new short URL, or read the
  [package apps guide](https://kody.codes/docs/package-apps).
- Set a fill placement on your next credential, as described in the
  [credentials guide](https://kody.codes/docs/credentials).

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
