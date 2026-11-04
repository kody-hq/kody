---
title: Internal tools built with AI that reuse your team's credentials
date: 2026-10-29
description:
  Agents can build an internal dashboard in an afternoon. The hard part is auth,
  keys, and hosting. How to ship one on credentials you already have.
order: 19
---

An engineer asks their agent for a small internal tool: a page that shows open
support escalations from your help desk next to each customer's plan in Stripe,
with a button to post a note to the account's Slack channel. Twenty minutes
later, there's a working app on `localhost:3000`. Most internal tools built with
AI stall right there.

Then the real questions start. Where does it run so the support team can use it?
How do people sign in? Where do the help desk, Stripe, and Slack keys go? Who's
allowed to see it? Who pays for it? And who maintains it when the agent that
wrote it has moved on to the next thing?

For most teams, that's where agent-built internal apps die. The code was the
easy part. The plumbing around it is a project, and it usually ends with a key
in an environment variable on a box someone forgot about.

## What internal tools built with AI actually need

Strip away the UI and every internal tool needs the same few things:

1. **Hosting** somewhere other than a laptop.
2. **Sign-in**, so you know who's using it.
3. **Access rules**, so only the right people can open it.
4. **Credentials** for the services it reads and writes, kept out of the code.
5. **A way to see who uses it.**

Agents are good at writing the app. They're not in a position to safely
provision all five, especially the credentials.

## Package apps in Kody

[Kody](https://kody.codes) is the layer under your team's assistants. A Kody
**package** can include an **app**: a fetch handler (or a framework app) that
Kody hosts. The agent writes it as part of the package and publishes it. It's
served at `https://<org>.kody.run/<package-name>`, or on a verified custom
domain.

Here's how the five needs map.

### Hosting and access

The app lives in your team org, next to the package code. Who can open it
follows the package's sharing rules: share it with the support team at **Use**,
and they can open it. Everyone else sees the package page instead. Apps can also
be approved as internet-visible if you want something public, but for an
internal tool you don't have to.

### Sign-in

Kody apps get **Sign in with Kody** without registering an OAuth client. The
visitor signs in with their Kody account and approves what the app asks for on a
consent screen. Your app's server code gets their verified identity, so "who
clicked the button" is a real answer.

### Credentials: the team's, or the visitor's

This is the part I care about most. The app never holds raw keys. It uses the
same `credential(key)` clients as any package, and the value is filled in at the
network boundary for that credential's approved hosts.

A package app runs as one person in the owning org: by default, whoever last
published it, and an Owner can choose someone else. That person supplies the
**publisher credentials**. So the help desk and Stripe lookups use your team's
existing credentials, the same ones your agents already use. Nobody creates a
new API key for the dashboard.

For actions that should happen as the visitor, an app can declare **visitor
needs**. Each one is its own consent scope on the Sign in with Kody screen, with
a description the visitor reads before approving. When the support person clicks
"post a note," it can use their own connected Slack account, not a bot. Visitor
needs never fall back to the publisher's access.

(There's also a newer option where a package declares that some credentials are
supplied by whoever runs it. That's behind a feature flag right now, so I'd
treat it as coming rather than something to plan around.)

### Seeing who uses it

People with **Manage** on the package see a **Connected people** tab. It lists
everyone with a live Sign in with Kody grant for the app: who, when they first
connected, when they last used it, and what they approved. The consent screen
tells visitors the owner can see this. Owners never see a visitor's credentials.

Visitors can revoke an app themselves from **Account, Connected apps**, and it
takes effect on the next call.

## Who pays

Kody's billing for app visits is spelled out in its docs. For members of the
owning org, the owning org pays. For someone outside the org with a grant on an
internal app, the metered work (storage, fetch, capability calls, email) goes to
their own personal org, while the app's compute stays with the owning org. That
keeps a shared internal tool from turning into a surprise bill when you add a
contractor.

## Why this changes what you'll let agents build

When the plumbing is a project, you only build the internal tools that clear a
high bar. When the plumbing is already there, the calculation changes:

- **Credentials once, many apps.** The Stripe credential your team saved for an
  agent workflow is the same one the dashboard uses. The next app reuses it too.
- **Reviewable.** The app is code in a versioned package. You can read the diff
  before you publish.
- **Owned by the team.** It lives in the team org, not on someone's VPS, which
  matters when its author leaves (see
  [What happens to your team's AI workflows when someone quits](/blog/team-ai-workflows-when-someone-quits)).

If you want a guardrail on what the app can do with a powerful credential,
restrict that credential to the app's package, so nothing else can use it.
That's covered in
[least-privilege tokens for AI agents](/blog/least-privilege-for-ai-agents).

## Build one this week

Pick an internal tool your team keeps asking for and nobody has time to build.
[Connect your agent to Kody](https://kody.codes/onboarding) and ask: "Build a
Kody package app in our team org that shows X, using our existing credentials,
and share it with the support team." The
[package apps guide](https://kody.codes/docs/package-apps) covers hosting, Sign
in with Kody, and visitor needs.

More in this series:

- [Bring your own key, letting each teammate run shared tools as themselves](/blog/bring-your-own-key-for-shared-team-tools)
- [Why "just use AWS Lambda" breaks down for teams using AI agents](/blog/why-aws-lambda-breaks-down-for-ai-agent-teams)
- [How to share AI workflows with your team](/blog/share-ai-workflows-with-your-team)
- [A team lead's guide to AI agent credentials](/blog/ai-agent-credentials-guide-for-team-leads)
