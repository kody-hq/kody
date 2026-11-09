---
title: A team lead's guide to AI agent credentials
date: 2026-09-04
description:
  Who owns the keys when your team's AI agents call real services? A practical
  model for team, personal, and shared credentials.
order: 3
category: how-to
series: agent-credentials-for-team-leads
---

Picture the Slack thread. Someone on your team built a handy agent workflow that
files Linear issues from customer emails. It works great. Three other engineers
want it. So the author shares the script, and each person needs a Linear API key
to run it. One asks in the thread, "can I just use yours?" That question is
where AI agent credentials stop being a personal choice and become a team
problem.

Now you have to answer a question you probably haven't written down yet: **for
AI agent work, which credentials belong to the team, which belong to a person,
and who gets to use which?**

If you don't decide, the default decides for you, and the default is "whoever
pasted a key most recently." This post is the model I'd use to decide on
purpose, and how [Kody](https://kody.codes) lets you enforce it instead of just
writing it in a wiki.

## Three kinds of AI agent credentials

Almost every key your team's agents touch falls into one of three buckets:

1. **Team credentials.** Accounts the team owns, not a person: the shared Sentry
   org, the deploy bot's GitHub App, the company Stripe account in test mode. If
   the person who set it up leaves, the team still needs it.
2. **Personal credentials.** Accounts that act as a specific human: my Gmail, my
   calendar, my GitHub user. Actions taken with these show up as me. Nobody else
   should run things as me.
3. **Per-person access to a team tool.** The Linear example. Everyone uses the
   same integration, but each person should file issues as themselves, with
   their own token.

The mistakes happen when a credential from one bucket gets used like it's from
another. A personal token used as a team credential leaves when its owner does.
A team credential used for per-person work makes every action look like it came
from the bot, which ruins your audit trail.

## Team credentials live in the team org

In Kody, credentials belong to an org. Every account has a personal org, and you
can create team orgs with Owners and Members. A credential saved in the team org
belongs to the team: it doesn't disappear when its creator's membership changes,
and it shows up on the org's **Credentials** page for Owners to see and manage.

By default, Members can create credentials in a team org. Owners can turn that
off under the org's settings if you'd rather keep credential creation to a
smaller group. That's the first real decision to make, and it depends on your
team. A small team of senior engineers probably leaves it on. A larger team with
a compliance story probably turns it off.

Two other defaults are worth knowing:

- **Secret values are never shareable org-wide.** You can grant everyone in the
  org access to read packages, for example, but there's no "everyone can read
  all secret values" switch, because nobody, including Owners, can read values.
  Agents and people get names and descriptions only.
- **Using a package doesn't grant its credentials.** If you share a package with
  someone at the **Use** level, they can run it, but if it needs a credential
  they don't already have, they need a separate grant to use that credential.
  Package access and credential access are two different decisions.

## Personal credentials stay personal, even inside the team

Sometimes a teammate wants their own credential to work inside the team org. Say
they want a team package to read their own calendar. Kody lets a person grant a
personal credential to a team org, with a rule I really like: it only works in
**that person's own runs** there. Other members can't use it. Owners can't use
it. Automation can't run as them with it.

So the answer to "can I just use yours?" can be "no" without being unhelpful.
Each person keeps their own credential, and the team package uses whichever one
belongs to whoever is running it.

## Per-person access through the team's OAuth app

For the Linear case, there's a cleaner path when the provider supports OAuth. An
Owner registers the team's OAuth app once in the org. Then each member opens the
app's page and clicks **Connect your own account**. They sign in to the provider
as themselves. The client id and secret stay on the server, so the member never
sees them, and the resulting tokens are saved for that member only, used only in
their own runs in that org.

Owners can see who has connected and can revoke a connection, but they can't use
it or read it. When someone leaves the org, their connection through the team's
app goes with them. I'll go deeper on that offboarding story in a later post;
for now the point is that the default is right.

For providers that only issue API keys, each member saves their own key and the
shared package lets each caller pick their own account. Same outcome: everyone
runs the same code as themselves.

## Packages ask for credentials by need, not by value

The thing that makes all of this work is that a Kody package never contains a
key. It declares what it needs in `package.json`:

```json
{
	"kody": {
		"credentials": {
			"linear": {
				"provider": "linear",
				"description": "Linear account that files the issues"
			}
		}
	}
}
```

At run time, Kody matches that need to a credential the caller is allowed to
use. If there's exactly one, it uses it. If there are several, it stops with a
`credential_ambiguous` error that lists the options instead of guessing. If
there are none, it stops with `credential_unbound`. Your engineers' agents can
read those errors and fix the mapping, and nobody ever passes a raw key around.

## A starter policy

If you want something you can paste into your team docs, here's where I'd start:

1. **Team-owned services:** save the credential in the team org. One owner of
   record per credential, named in its description.
2. **Anything that acts as a person:** that person's own credential, in their
   personal org, granted to the team org only if a team package needs it.
3. **Shared tools that act as the caller:** register the team's OAuth app once
   and have each member connect their own account, or have each member save
   their own key.
4. **No raw keys in chat, `.env`, or MCP configs.** Agents send a Kody save link
   instead. (More on that in
   [Stop pasting API keys into agent configs](/blog/where-to-store-api-keys-for-ai-agents).)
5. **Scope at the provider first.** Kody keeps keys unreadable, but it can't
   make a broad token narrow. See
   [least-privilege tokens for AI agents](/blog/least-privilege-for-ai-agents).

## Next step

Create a team org in Kody and invite two people with an invite link. Move one
team-owned credential into it and turn one shared script into a package that
declares that credential as a need. Start at [kody.codes](https://kody.codes),
and keep the [credentials guide](https://kody.codes/docs/credentials) and
[organizations guide](https://kody.codes/docs/organizations) open while you do.
