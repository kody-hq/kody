---
title:
  Whose credentials does this app use? How to audit an app before you share it
date: 2026-11-07
description:
  Before you share an AI-built app, check five things. Which org owns it, who it
  runs as, which credentials fill it, who can open it, and who pays.
order: 2
category: how-to
---

Someone on your team built a useful app with an agent. Now three people want it,
one of them is a contractor, and someone asks the obvious question: "Is this
going to run on your API key?"

You can't answer that by looking at the app. You answer it by checking a few
separate facts that people tend to blur together. Signing in, running as
someone, holding a credential, having permission, and paying for the work are
five different things in Kody. This guide is a checklist for finding each one on
an app that already exists, and then picking the sharing route that surprises
nobody.

If you want the longer version with a worked example, the
[Sharing apps with your team](/blog/series/sharing-apps-with-your-team) series
covers the choices in parts. This page is the audit.

## 1. Which org owns the app?

Everything else hangs off this. The org that owns a package owns its storage,
its default credential mappings, and its bill.

Look at the package page URL. `kody.codes/@your-name/...` is your personal org.
A team slug in that spot is a team org. A personal org and a team org are
separate: nothing moves between them on its own, and
[the organizations guide](https://kody.codes/docs/organizations#personal-vs-team)
explains why.

If a work app lives in someone's personal org, that is usually the first thing
to fix, before anyone is granted access.

## 2. Who does it run as?

A hosted package app runs as one person in the owning org. By default that is
whoever published it last. An Owner can choose someone else.

Ask your agent to call `packageAppRunsAsGet`. It returns a username and a
source: whether an Owner chose that person or it is just the last publisher. The
check is live on every call, so if that person leaves the org or their account
is suspended, the app stops acting as them and says why. It doesn't fall back to
someone else.

Signing in does not change this. A visitor who signs in with Kody brings their
identity, so the app knows who is visiting. They do not get the runs-as person's
permissions, and the app does not start using their data. See
[who the app runs as](https://kody.codes/docs/package-apps#who-the-app-runs-as).

## 3. Which credentials fill each need?

A package declares the credentials it needs, such as "a GitHub token" or "a
Slack OAuth connection." `packageGet` lists those needs and, for each one, how
it resolves for you right now:

- `status` tells you whether the need is `ready`, `ambiguous`, `unbound`, or
  `expired`.
- `source` tells you where the answer came from: `mine` (your own default
  mapping), `org` (the org default), or `auto` (matched by provider).
- `autoPick` names the credential that would be used. It never shows a value.

That answers "whose key" for you. It does not answer it for every teammate,
because each person's own mappings can differ. When it matters, have each person
run the same read-only check.

Two rules that catch people:

- A personal credential you granted to a team org only works in your own runs in
  that org. Nobody else can use it, including Owners.
- Giving someone Use on a package does not give them use of your credentials.
  Credential access is a separate grant. See
  [credentials](https://kody.codes/docs/credentials).

## 4. Who can open it, and with what access?

`packageCollaboratorList` lists who has access to the package, with their
preset: Read, Use, Contribute, or Manage. Read covers source and forking. Use
adds running it. Contribute adds changes. Manage adds publishing, deleting, and
managing access. No preset includes billing or reveals secret values.

Check the hosted app separately. Package access and app access are different
resources. A Use grant on the package doesn't open the app. Owners can always
open it; Members and outside collaborators need a grant on the app itself. The
[package sharing guide](https://kody.codes/docs/package-sharing) has the
details.

## 5. Who pays when someone uses it?

For app visits, the
[billing table](https://kody.codes/docs/package-apps#who-pays-for-visits) is
short:

- A member of the owning org: the owning org pays.
- Someone outside the org with a grant, on an internal app: their own personal
  org pays for metered work, and the owning org pays for Worker compute.
- Anyone on an internet-visible app, signed in or not: the owning org pays.

Stored data stays in the owning org either way. There is no platform per-visitor
limit, so a public app with expensive calls needs its own rate limit.

## What's available today, and what's conditional

Kody's design includes a mode where each visitor connects their own credential
and the app uses that, with no fallback to the publisher's. That depends on a
feature that is off by default. `packageGet` reports it as
`credentials.suppliersEnabled`. When that is `false`, the supplier settings in a
package's manifest are ignored. When I checked packages in two orgs I use, it
was `false` in both.

So I'm not going to walk you through visitor credentials here. If your audit
shows `suppliersEnabled: false`, treat the app as running on the owning org's
credentials, as above.

## Pick the least surprising route

Once you have the five answers, the choice usually makes itself:

- **They should use their own keys, data, and bill:** have them fork it. A fork
  is their copy in their org, with their mappings.
- **They should use the original, on the org's credentials:** grant them Use on
  the package or the app, chosen on purpose, and make sure the runs-as person is
  someone who will still be there next quarter.
- **They just need to sign in to an app you host:** grant app access and let
  them sign in with Kody. Their identity comes along. Your credentials and your
  bill still apply, unless they are an outside collaborator on an internal app.

If any answer surprised you, fix that first. Moving the app to a team org or
changing who it runs as is easier before five people depend on it.

## A read-only audit prompt

```text
Audit my Kody package [package name] before I share it. Read only. Do not
change grants, credentials, runs-as, visibility, or billing.
1. Which org owns it, and is that a personal or team org?
2. Who does its app run as (packageAppRunsAsGet), and is that source explicit
   or the last publisher?
3. For each credential need in packageGet, give the key, status, source, and
   autoPick name. Report credentials.suppliersEnabled.
4. Who has access (packageCollaboratorList), with presets, and does anyone have
   a separate grant on the app?
5. Based on the visit billing rules, who pays when a member, an outside
   collaborator, or an anonymous visitor uses it?
Then recommend fork, grant, or sign-in for these people: [names and roles].
Show any change as a proposal and wait for my approval. Never print credential
values.
```
