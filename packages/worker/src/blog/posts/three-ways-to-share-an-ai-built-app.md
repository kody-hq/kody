---
title: Three ways to share an AI-built app, and whose keys each one uses
date: 2026-12-11
description:
  Fork it, grant it, or let people sign in. How to share an AI-built app by
  deciding whose credentials it runs on and who pays for the work.
order: 1
category: essays
series: sharing-apps-with-your-team
---

You had your agent build one useful app. Now five people want it: two teammates,
your manager, a contractor, and someone at a client. The easy question is how to
send it. The question that matters when you share an AI-built app is different:
**whose credentials should it run on?**

Answer that first and the other choices get easier. Skip it and you end up with
an app that quietly uses your GitHub token for everyone, or a copy that breaks
the first time someone else opens it.

This series uses one made-up example throughout. It is for teaching only, not a
customer story.

## The example: a release checklist app

Picture a small app in [Kody](https://kody.codes) called `release-checklist`. It
reads merged pull requests from GitHub and open issues from Linear, then shows a
checklist for the next release. It is a package with a hosted app, and it needs
two credentials: one for GitHub and one for Linear.

## Four questions that look like one

"Share the app" hides several separate decisions:

- **Credentials.** When the app calls GitHub, whose account does it use?
- **Org.** Which organization owns the app, its data, and its bill?
- **Runs as.** Which person's access does the app act with?
- **Permissions.** Can someone run it, read the source, change it, or decide who
  else gets it?

Storage and billing follow from those answers, but they are not permissions.
Kody keeps these apart on purpose. There are three ways to share, and each one
answers the credentials question differently.

## 1. Fork: their copy, their credentials

Give the person **Read** on the package. Read lets them view, clone, and fork
the source. It does not let them run your package or open your app.

When they fork, they get a new package in their own org. From then on:

- It runs with **their** credentials. They connect their own GitHub and Linear.
- It runs and bills in **their** org.
- Its storage is theirs, and it starts empty.
- The fork records where it came from, so they can see when your source moves
  ahead. They choose when to pull changes in.

Forking fits the client and often the contractor. You never lend them your keys,
and they never depend on how your org is set up.

The tradeoff is drift. A fork is a copy, so your next fix does not reach them by
itself. And if your package imports other packages from your org, their copy
needs those too: a package can only import packages from its own org.

What failure looks like: someone with Read who tries to run your original is
refused, because Read has no execute permission. Someone with no access at all
gets a not-found page and cannot fork.

## 2. Grant: your app, authority you chose on purpose

For teammates, a copy each is usually wrong. You want one app and one place to
fix bugs. That is a **grant**.

A Use grant on the package lets someone read and run your live package. Opening
the hosted app is a separate grant on the app itself, so check both rather than
assuming one covers the other.

Whose credentials it uses depends on how they use it:

- **When they open the app**, it runs as one person in your org: by default the
  person who last published it, or someone an Owner picked. The app uses that
  person's credentials, capped by the capabilities the app declares. Your
  teammate brings their identity, not their keys.
- **When they run the package directly** from their agent, the run acts as them.
  Credentials come from your org, but each one still needs its own Use grant for
  that person. A Use grant on the package does not include credential use.

Who pays depends on who is visiting. For members of your org, your org pays. For
an outside collaborator visiting an internal app, their own personal org pays
for the metered work their visits cause, and your org keeps paying for the app's
compute. If the app is internet-visible, your org pays for every visitor. Stored
data stays in your org either way.

What failure looks like: a teammate without credential access is refused. If the
person the app runs as leaves the org, the app stops acting as them, with an
error that says so, until an Owner picks someone else or someone publishes
again. It never falls back to another person.

## 3. Sign in with Kody: the visitor's identity

The third option is for an internet-visible app, where people should open it
without a grant in your org. With Sign in with Kody, the visitor signs in and
the app learns who they are: a verified user id and username. People who
connected show on the package's **Connected people** tab. On a private app,
signing in is only the front door: without app access they see a no-access page.

Identity is all sign-in gives them. It does not hand them your permissions or
your app their data. The app still runs as its runs-as person, and your org pays
for those visits.

There is a further design for apps to use the **visitor's own** credentials,
chosen by the visitor on the consent screen, with no fallback to the publisher's
keys. It is gated behind a feature. Before planning around it, check
`packageGet` on one of your packages: when `credentials.suppliersEnabled` is
`false`, the supplier settings are ignored and none of this applies. Where it is
not available, the working way for someone to use their own keys is the first
option: fork.

## Choosing between them

| Who                         | Usually            | Runs on                      |
| --------------------------- | ------------------ | ---------------------------- |
| A client or another company | Fork               | Their credentials, their org |
| A teammate who runs it      | Grant (Use)        | Your org, chosen authority   |
| A teammate who improves it  | Grant (Contribute) | Your org, chosen authority   |
| A visitor you only identify | Sign in with Kody  | The app's runs-as person     |

None of these is safe or unsafe on its own. A grant to the wrong person is worse
than a fork. The point is to choose on purpose.

## A prompt for your agent

Paste this into an agent connected to Kody. It inspects and proposes; it does
not change anything until you approve.

```text
Look at my package release-checklist in Kody. Do not change anything yet.
1. List its credential needs and check credentials.suppliersEnabled.
2. Tell me who its app runs as and why.
3. List who currently has access, with their preset.
For each of these people, recommend fork, grant, or Sign in with Kody, and
say whose credentials and whose bill each choice would use: [names and roles]
Then show the exact calls you would make and wait for my approval.
Never print credential values.
```

Next in this series: setting up a team org to hold the shared version. For the
details behind this post, see [package sharing](/docs/package-sharing),
[who the app runs as](/docs/package-apps#who-the-app-runs-as), and
[who pays for visits](/docs/package-apps#who-pays-for-visits).
