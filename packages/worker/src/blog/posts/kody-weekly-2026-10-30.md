---
title: Kody weekly: Apps run as their publisher, and more for teams
date: 2026-10-30
description: Apps run as their publisher, public team org pages, org-wide grants, and 11 more features, plus 5 breaking changes.
order: 1
category: updates
---

Here is what shipped in Kody from October 24 to October 30, 2026. This week
package apps run as the person who published them, team orgs get public pages
and org-wide grants, and credentials and sign-in got safer and simpler. Five
changes need action: see Breaking changes below.

## Package apps run as their publisher

### What shipped

A hosted package app now runs as its publisher. The publisher pays for the app,
and the publisher's credentials fill the app's needs. Visitors bring only a
verified identity, and Sign in with Kody lets an app use a visitor's own data
with one consent scope per need, including optional scopes, "ask later," and
per-scope revoke. Each app gets its own cookies, its own rate limits, and a
per-visitor spend view, and app owners get a **Connected people** tab that shows
who connected to the app and lets them sign one person out.

### Why it matters

You can share an app with people outside your org without asking each of them to
connect the same accounts first. You stay in control of what it costs, and
visitors choose what of their own data the app can use.

### Example

Publish a package app that calls an integration you have connected, open it in a
private window as a visitor, then check the per-visitor spend and the Connected
people tab on the package page.

Docs: [Package apps](https://kody.codes/docs/package-apps) · PRs:
[#4278](https://github.com/kody-hq/kody/pull/4278),
[#4351](https://github.com/kody-hq/kody/pull/4351),
[#4329](https://github.com/kody-hq/kody/pull/4329),
[#4237](https://github.com/kody-hq/kody/pull/4237),
[#4473](https://github.com/kody-hq/kody/pull/4473),
[#4455](https://github.com/kody-hq/kody/pull/4455)

## Public pages for team orgs

### What shipped

A public team org now has a real page at its handle, `kody.codes/@your-org`,
that anyone can open, signed in or not. It shows the org's avatar, name, bio,
and public packages. You choose Public or Private when you create the org and
can change it later in Settings. Members still get their workspace one click
away.

### Why it matters

A team can point people at one URL for everything it publishes, the same way you
would link a GitHub organization.

### Example

1. Open your team org's Settings and set its profile to Public.
2. Sign out and visit `https://kody.codes/@your-org`.
3. Check that only your public packages are listed.

Docs: [Organizations](https://kody.codes/docs/organizations) · PR:
[#4525](https://github.com/kody-hq/kody/pull/4525)

## Grant access to everyone in your org at once

### What shipped

Org Owners can now grant a resource to everyone in the organization. The grant
covers current members and anyone who joins later, and someone who leaves loses
access on the next check. Owners can also grant read permissions org-wide, such
as `job:read`, `package:read`, and `app:read`, so a Member can see run history
or packages across the org without becoming an Owner. Write actions are never
included in org-wide read grants.

### Why it matters

You no longer hand out the same grant to every teammate, one by one, and again
for each new hire. Members can see what they need without getting more power
than they need.

### Example

1. On a private package's Collaborators tab, add **Everyone in this
   organization** with the Use preset.
2. On the org's Grants page, pick a Member and check **Jobs and run history**.
3. Click **Save read access**. That Member can now list runs across the org.

Docs: [Organizations](https://kody.codes/docs/organizations) · PRs:
[#4502](https://github.com/kody-hq/kody/pull/4502),
[#4491](https://github.com/kody-hq/kody/pull/4491)

## Custom domains for package apps on every paid org

### What shipped

Every paid org can now point a custom hostname at a package app, and paid
personal orgs can manage custom domains from their Settings page. The package
page shows each domain's DNS status and re-checks pending hostnames, notices for
add, sync, and remove appear right beside the form, and **Open app** opens a
fully active custom domain instead of the `kody.run` subdomain. Free orgs stay
blocked.

### Why it matters

Your app can live on your own domain, and you can see whether DNS is set up
without leaving the package page.

### Example

1. Open your package app's settings and add `app.example.com`.
2. Create the DNS records Kody shows you.
3. Watch the status turn active, then use **Open app**.

Docs: [Custom domains](https://kody.codes/docs/package-app-custom-domains) ·
PRs: [#4470](https://github.com/kody-hq/kody/pull/4470),
[#4594](https://github.com/kody-hq/kody/pull/4594),
[#4210](https://github.com/kody-hq/kody/pull/4210),
[#4359](https://github.com/kody-hq/kody/pull/4359),
[#4392](https://github.com/kody-hq/kody/pull/4392)

## Shareable org invite links

### What shipped

You can create reusable invite links from the Members page, give each one a
label and default teams, and see when each link was last used. Agents can
create, list, revoke, and accept invite links through MCP, the API, and the CLI.

### Why it matters

Inviting a whole team is one link instead of one invite per person, and you can
ask your agent "how do I invite my whole team" and get a working answer.

### Example

1. On your org's Members page, create an invite link labeled `Engineering`.
2. Pick the teams new members should join.
3. Share the link, and revoke it when you are done.

Docs: [Organizations](https://kody.codes/docs/organizations) · PR:
[#4385](https://github.com/kody-hq/kody/pull/4385)

## Sign the CLI in from any machine

### What shipped

`kody login --device` signs the CLI in from machines whose browser cannot reach
the CLI's local callback, such as remote VMs and SSH sessions. You open a URL on
any device, enter a short code, and approve. `kody install` also detects SSH and
machines with no display, and prints the OAuth steps for Codex and OpenCode
instead of starting a browser login that cannot finish.

### Why it matters

Setting up Kody on a remote box no longer needs port forwarding or a desktop.

### Example

```sh
ssh my-server
kody login --device
```

Docs: [Local execute](https://kody.codes/docs/local-execute) · PRs:
[#4434](https://github.com/kody-hq/kody/pull/4434),
[#4442](https://github.com/kody-hq/kody/pull/4442),
[#4490](https://github.com/kody-hq/kody/pull/4490)

## Credentials fill only where their owner allows

### What shipped

The gateway now enforces each credential's fill placement. A credential fills a
query string, URL path, or request body only when its owner opted in, and vault
credentials get the same placement controls. Changing a credential's placement
or how it is injected is website-only, so code running with the credential
cannot move its value. Agents can build a one-click approval link that asks the
owner to allow a placement, and refusal links open the exact credential that was
refused.

### Why it matters

Query strings end up in logs and bodies end up in stored records. Now a value
reaches only the parts of a request its owner approved, and code cannot change
that.

### Example

1. Run a package whose request puts a credential in the body.
2. Open the link in the refusal message.
3. Approve body placement for that credential, then run it again.

Docs: [Credentials](https://kody.codes/docs/credentials) · PRs:
[#4430](https://github.com/kody-hq/kody/pull/4430),
[#4514](https://github.com/kody-hq/kody/pull/4514),
[#4428](https://github.com/kody-hq/kody/pull/4428),
[#4492](https://github.com/kody-hq/kody/pull/4492)

## Login credentials that keep tokens out of your code

### What shipped

Kody now keeps login credential sessions encrypted at rest and shares one token
exchange across runs, so concurrent runs do not spend the same refresh token
twice. A 401 triggers a single retry with a fresh session, and rotated refresh
tokens are saved automatically. Sealed refresh tokens from an exchange in a run
can be saved as a `login` credential, and your code never holds either token.

### Why it matters

Integrations that sign in with a refresh token keep working across runs without
your package ever storing or seeing the token.

### Example

In a package run, exchange a provider login for a sealed refresh token, save it
as a `login` credential, and let later runs use that credential by name.

Docs: [Credentials](https://kody.codes/docs/credentials) · PRs:
[#4566](https://github.com/kody-hq/kody/pull/4566),
[#4567](https://github.com/kody-hq/kody/pull/4567),
[#4568](https://github.com/kody-hq/kody/pull/4568)

## Sign up from the OAuth screen and choose the org you connect

### What shipped

Someone without an account who lands on Kody's OAuth consent screen can now
create one right there and continue the same authorization. `kody login` waits
15 minutes to leave time for email verification. When you connect an integration
with OAuth, the `/connect/oauth` page shows and lets you pick which org it
writes to, and members can connect their own account through an org's OAuth app.

### Why it matters

New people can go from "connect your agent to Kody" to a working connection
without starting over, and integrations land in the org you meant.

### Example

1. Add Kody to your agent and start its sign-in.
2. On the consent screen, choose to sign up.
3. Verify your email and approve. The agent finishes connecting.

Docs: [OAuth](https://kody.codes/docs/oauth) · PRs:
[#4597](https://github.com/kody-hq/kody/pull/4597),
[#4526](https://github.com/kody-hq/kody/pull/4526),
[#4528](https://github.com/kody-hq/kody/pull/4528),
[#4527](https://github.com/kody-hq/kody/pull/4527)

## Skills dashboard with version history

### What shipped

A new Skills dashboard lists your published skills with read analytics: 30-day
activity, most-read skills, and recent reads. Each skill has a History view
where you can pick a published version, compare it line by line with another,
and restore an earlier version as a new publish.

### Why it matters

You can see which skills your agents actually read, and undo a bad skill edit
without touching the rest of the package.

### Example

Open the Skills dashboard, pick a skill, open History, compare the two latest
versions, and restore the older one.

Docs: [Package skills](https://kody.codes/docs/package-skills) · PRs:
[#4460](https://github.com/kody-hq/kody/pull/4460),
[#4519](https://github.com/kody-hq/kody/pull/4519)

## Spam and archive for every inbox

### What shipped

You can mark messages as spam or archive them in any Kody inbox, and both are
fully reversible: nothing is deleted. Default views hide spam and archived mail.
After marking spam you can choose to block the sender, and Kody never blocks
anyone automatically.

### Why it matters

Agent inboxes stay readable without risking a message you need.

### Example

Open an inbox, mark a message as spam, choose whether to block the sender, then
switch the view to Spam to restore it.

Docs: [Agent inbox](https://kody.codes/docs/agent-inbox) · PR:
[#4323](https://github.com/kody-hq/kody/pull/4323)

## See who started each run

### What shipped

Every run now records the user, client, and label that started it, and Activity
shows it.

### Why it matters

Team owners can tell which member or which agent triggered an `execute` error or
a scheduled call.

### Example

Open Activity in a team org and check the started-by column on a failed run.

PR: [#4309](https://github.com/kody-hq/kody/pull/4309)

## Packages declare their capabilities

### What shipped

A `kody.capabilities` field in `package.json` lets a package declare what it
needs. A warn-only publish check follows the full import closure and flags
capabilities that are used but not declared, naming both the app and the
imported package. A migration codemod with a dry-run report helps authors add
the declarations.

### Why it matters

You can see what a package can do from its manifest, and catch an undeclared
capability before it matters, without any publish being blocked this week.

### Example

```json
{
	"name": "@you/my-helper",
	"kody": {
		"capabilities": ["secretList", "secretSet"]
	}
}
```

Docs: [Package authoring](https://kody.codes/docs/package-authoring) · PRs:
[#4550](https://github.com/kody-hq/kody/pull/4550),
[#4554](https://github.com/kody-hq/kody/pull/4554),
[#4539](https://github.com/kody-hq/kody/pull/4539),
[#4545](https://github.com/kody-hq/kody/pull/4545),
[#4547](https://github.com/kody-hq/kody/pull/4547)

## Secret provider placeholders in published packages

### What shipped

A published package can now declare a `secret-provider` credential slot that
names another package as its vault provider, then reference vault items in its
code. Publish checks and runtime enforcement both honor the declaration.

### Why it matters

If you keep secrets in a vault such as 1Password, a published package can use
them without copying values into Kody.

### Example

Add a `secret-provider` slot to `kody.credentials` that names your vault
provider package, reference the vault item in a request, and publish.

Docs: [Secret providers](https://kody.codes/docs/secret-providers) · PR:
[#4426](https://github.com/kody-hq/kody/pull/4426)

## More updates

- **Community:** Adds a Forks page for every package that shows the forks you
  can open, and lets you choose an org for one-click installs.
  ([#4401](https://github.com/kody-hq/kody/pull/4401),
  [#4423](https://github.com/kody-hq/kody/pull/4423))
- **Packages:** Adds a New repository button to the Repositories page, with a
  copyable prompt for your agent.
  ([#4409](https://github.com/kody-hq/kody/pull/4409))
- **Credentials:** Opens the new credential page with a "Let your agent set it
  up" prompt, and adds a searchable package picker for org credentials.
  ([#4431](https://github.com/kody-hq/kody/pull/4431))
- **Orgs:** Emails your previous address when your account email changes.
  ([#4388](https://github.com/kody-hq/kody/pull/4388))
- **Email:** Replies from the plus alias a message was sent to, and accepts an
  optional `from` on `emailSend` and `emailReply`.
  ([#4517](https://github.com/kody-hq/kody/pull/4517))
- **Execute:** Says where every run happened with a `ranOn` field and a text
  line such as "Ran on Kody cloud."
  ([#4572](https://github.com/kody-hq/kody/pull/4572))
- **Automations:** Shows why a job is off, and records manual job runs in the
  org audit log. ([#4248](https://github.com/kody-hq/kody/pull/4248),
  [#4381](https://github.com/kody-hq/kody/pull/4381))
- Plus smaller changes, including `.kodyignore` support for publish
  ([#4548](https://github.com/kody-hq/kody/pull/4548)), unhandled follow events
  kept as Recent updates ([#4325](https://github.com/kody-hq/kody/pull/4325)),
  and faster Markdown and code highlighting
  ([#4516](https://github.com/kody-hq/kody/pull/4516)). See the
  [full release list](https://github.com/kody-hq/kody/releases).

## Fixes

- **Apps:** Tightens package app cookie handling.
  ([#4419](https://github.com/kody-hq/kody/pull/4419))
- **Automations:** Fixes scheduled jobs silently skipping a due run.
  ([#4378](https://github.com/kody-hq/kody/pull/4378))
- **Execute:** Fixes overlapping `execute` calls mixing their console output,
  and packages that cache an authenticated fetch crashing on repeat runs.
  ([#4417](https://github.com/kody-hq/kody/pull/4417),
  [#4512](https://github.com/kody-hq/kody/pull/4512))
- **Orgs:** Fixes permission denials showing a blank error page instead of a 403
  with a link to Grants. ([#4510](https://github.com/kody-hq/kody/pull/4510))
- **Packages:** Fixes publish retrying for a long time on memory-limit errors
  instead of failing fast with guidance.
  ([#4374](https://github.com/kody-hq/kody/pull/4374))
- **Packages:** Fixes app asset folders holding only images being reported as
  empty. ([#4495](https://github.com/kody-hq/kody/pull/4495))
- **Orgs:** Fixes signing up again with the email of a deleted account.
  ([#4458](https://github.com/kody-hq/kody/pull/4458))

## Breaking changes

- **Apps:** Package apps no longer run as their visitor. **Action:** check that
  your own credentials cover your app's needs, and use Sign in with Kody where
  the app needs a visitor's data.
  ([#4278](https://github.com/kody-hq/kody/pull/4278))
- **Credentials:** A credential fills a query string, URL path, or body only
  when its owner allows that placement. **Action:** if a request is refused,
  open the link in the error and approve the placement.
  ([docs](https://kody.codes/docs/credentials),
  [#4430](https://github.com/kody-hq/kody/pull/4430))
- **Execute:** The `invoke` shortcut is removed and `execute` requires `code`.
  **Action:** pass a short `code` module that imports and calls the export.
  ([docs](https://kody.codes/docs/search-and-execute),
  [#4481](https://github.com/kody-hq/kody/pull/4481))
- **Automations:** `once` job schedules are removed. **Action:** schedule
  delayed one-time work with `workflows.create` and `runAt` instead.
  ([#4310](https://github.com/kody-hq/kody/pull/4310))
- **Packages:** Package retrievers are removed, and search no longer runs
  package code. **Action:** delete `kody.retrievers` from your `package.json`.
  ([#4313](https://github.com/kody-hq/kody/pull/4313))

## Try it

- On a remote machine, run `kody login --device` and enter the code it prints in
  your browser.
- Make your team org Public and share its page, as described in the
  [organizations guide](https://kody.codes/docs/organizations).
- Point a domain at a package app with the
  [custom domains guide](https://kody.codes/docs/package-app-custom-domains).

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
