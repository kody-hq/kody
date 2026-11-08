---
title: How to give staff and their bots access to your Kody org
date: 2026-11-07
description:
  You built the packages. Now staff who will never build anything need to ask a
  bot for answers. How Kody accounts, orgs, seats and bot connections fit.
order: 8
category: how-to
updated: 2026-11-08
---

Here's a setup I expect to see a lot. One technical person builds Kody packages
for a small business: a weekly analytics report, an alert when a payment fails,
a check for stale class listings. Someone who doesn't build anything starts
asking a bot questions, and the bot pulls answers from every service the
business uses. It works. Now the staff want the same thing.

That's when the accounts start to blur. Does each employee need their own paid
plan? Is the bot a separate account? Which org is it talking to? This guide
answers those questions for a technical owner setting things up for staff who
will never write a package.

## How the accounts tie together

There are four things, and it helps to keep them separate.

**A person's Kody account.** Every employee signs up with their own username.
Signing up gives them a personal org, on the Free plan, that they own. They may
never use it, and that's fine.

**Your team org.** This is where the business lives: your packages, credentials,
jobs and apps. Per the
[organizations docs](/docs/organizations#personal-vs-team), the org is the
billing and data boundary. Resources belong to one org, and grants control who
can do what inside it.

**The plan and seats.** The plan belongs to the org, not the person. On Pro,
every live Owner and Member of the team org is a paid seat, and the org pays for
it ([paid seats](/docs/organizations#paid-seats)). Billing-only members and
outside collaborators are not seats. Work an employee does while connected to
the team org counts against the team org's limits, not their personal plan.

**The bot.** A bot like Grok Bot is not a separate Kody account. It's an agent
connected to Kody as the employee, through a connection they approve. Each
connection is bound to exactly one org, picked when they approve it
([connect one client to two orgs](/docs/organizations#connect-one-client-to-two-orgs)).
Over that connection, the bot can do what that employee can do in that org, and
nothing they can't. If you want a bot to have less than its person, that's what
[agent profiles](#give-a-bot-less-than-its-person-with-agent-profiles) are for.

So each employee needs a free Kody account of their own, membership in your team
org (a seat you pay for on Pro), and one bot connection approved for the team
org. That's the whole list. They don't need a paid personal plan, and they don't
need to build or connect anything else.

## Step by step

**1. Decide what staff can create.** In **Organization settings**, **Member
permissions**, "Members can create packages and apps" is off by default and
"Members can create credentials" is on. For staff who only ask questions,
consider turning credentials off too, so nobody connects a stray account into
the business org. Owners can always create.

**2. Make an invite link.** Open `/@<your-org>/-/members` and create an invite
link. It joins people as Member by default, and it can carry a label, default
teams, an email domain allowlist, a use limit and an expiry. The full URL is
shown once, so copy it then. If you're making a team like `front-desk` for
grants (more below), set it as a default team so new hires land in it.

**3. The employee joins.** They open the link, create an account (choosing their
own username), and choose **Accept**. Nothing happens until they accept. If
they're already signed in, the invite also waits on their Waiting page.

**4. Connect their bot.** For Grok Bot, the
[Kody Bot template](https://x.ai/bot/yTSGElYcIjFW_5IXu2I-e) comes with the Kody
plugin, or they can add the Kody plugin to a bot they already use. They complete
**Authorize** when it asks. The important part is the org: at consent, pick the
business org, not their personal one. For clients that take an MCP URL, adding
`?org=<your-org>` to `https://kody.codes/mcp` binds the connection to that org
up front. If the bot also uses the Kody CLI, `kody login --org <your-org>` does
the same for the CLI. Afterward, the connection should show on the org's Agents
page at `/@<your-org>/-/agents`.

**5. Ask one question.** Have them ask something you know they're allowed to
answer. If the bot can't find your packages, the first thing to check is which
org the connection is bound to.

## Give staff only what they need

A new Member starts with very little: the org basics like reading the member and
team lists, and catalog search. They can't run your packages or open your apps
until you grant them.

That's good, because it means you choose. Grant **Use** on the packages each
person should run. Use lets them read and run a package, not change it. Grants
can go to one person, a team, or everyone in the org. A team grant is usually
the cleanest: grant `front-desk` Use on the three packages the front desk needs,
and everyone who joins that team gets them.

Hosted apps are separate. A Use grant on a package doesn't open the package's
app. Staff need an app grant too. I covered that difference, and the Read, Use,
Contribute and Manage presets, in
[Read, Use, Contribute, or Manage?](/blog/read-use-contribute-manage-app-access).

Your habit of splitting packages by action is the right instinct, and Kody can
back it up. If the scheduling software has no granular permissions, its key can
do anything. So put "look up a class roster" and "move a booking" in different
packages, and grant them to different teams. Then lock the scheduling credential
with **Which packages can read it**, **Only these packages**, so only those
packages can use the key at all.

Running a package that uses a credential also takes Use on that credential, so
grant the same team Use on the keys those packages need. Use is not the same as
seeing it. Per the [credentials docs](/docs/credentials), a credential's value
never enters package code, and agents, logs and tool output never see it. Code
names the credential, and Kody puts the value into the outgoing request only for
the hosts that credential allows. A bot can do the allowed action without anyone
holding the secret. If you want to check what an existing app actually runs with
before you share it, see
[Whose credentials does this app use?](/blog/whose-credentials-does-this-app-use).

## Give a bot less than its person with agent profiles

Sometimes the person should keep their access but their bot shouldn't have all
of it. Say a manager can move bookings, but their bot should only answer
questions from the report packages. Kody's [agent profiles](/docs/profiles)
cover that case.

A profile is an identity in one org that an agent acts as instead of acting as
the person. It's an early access experiment, so whoever uses it turns it on
first at `/account/experiments`. Profiles live on the **Agent profiles** page,
at `/@<your-org>/-/profiles` in a team org.

How it works in practice:

- **The employee creates it.** A profile acts for the person who made it, so
  each employee creates their own, with you helping if they need it. You pick
  its starting grants from what that person holds right now, and you can give it
  an expiry.
- **Access is the overlap.** A request as a profile only reaches something when
  the person's live access, the profile's grants, any parent profile's grants,
  and the token's scopes all allow it. Being an Owner doesn't skip a profile's
  limits. Its grants are a snapshot, so it doesn't gain access later when its
  person does.
- **Share packages and credentials separately.** Give a profile a package from
  the package's **Collaborators** tab with **Add one of your profiles**. That
  doesn't share the credentials the package uses, so grant each credential to
  the profile too.
- **It needs a token, not an MCP connection.** Profile tokens work with the Open
  API and the Kody CLI (as `KODY_API_TOKEN`), not with `/mcp`. A bot connected
  through the usual **Authorize** step acts as the person. So a profile only
  helps a bot that reaches Kody through the CLI or the API with a profile token.
  I haven't tested that setup with Grok Bot, so check it with one bot before you
  roll it out.

A profile's name doesn't limit anything, and neither does anything you tell the
bot. Grants do. An agent can see which profile it's running as with `whoami`,
but the docs are clear that this is for choosing behavior, never a security
check. If a bot shouldn't do something, take the grant away rather than telling
it not to.

For most staff, membership plus the right team grants is enough. Reach for a
profile when a specific bot should do less than the person it works for.

## Common gotchas

**The bot is connected to the wrong org.** One connection binds one org. If an
employee approved their personal org, the bot sees an empty account. Add Kody
again with the business org selected, or with `?org=<your-org>` on the URL.

**A credential lives in the wrong org.** Kody does not move credentials between
orgs. If you connected the payment service in your personal org, reconnect it
from the team org's Credentials page. Granting a personal credential to the team
org doesn't share it with staff. It only works in your own runs there.

**Automations run as whoever turned them on.** A scheduled job runs as the
person who enabled it, with their live access. If an employee turns on a job and
later leaves, it pauses until someone else turns it on for themselves. For the
weekly reports, it's usually best if you turn them on.

**Apps run as one person.** A hosted app runs as the person who last published
it unless an Owner picks someone else. If that person leaves, the app stops
acting as them, with an error that says so, until an Owner picks someone else.

**Someone leaves.** Remove them on the Members page. Grants to everyone in the
org are checked live, so they lose those at once, and leaving revokes their
agent profiles in the org. Also revoke any invite link you no longer need, since
a removed person can rejoin with a live membership link.

## Documenting how the business works

The last piece is the knowledge: how a refund works, which system is right when
two disagree, what "stale" means for a class listing. Staff ask their bots these
questions, so the bots need the answers somewhere.

Kody doesn't have an org-wide guide system today. Memories are personal and
follow one person, not the org. MCP instructions are set per person too, and
agent profiles carry access, not instructions. The honest workaround is a
package. Package docs (`README.md` for people and `AGENTS.md` for agents) and
[package skills](/docs/package-skills) are where shared knowledge lives now. A
small "how we run the business" package, granted to everyone in the org, gives
every connected bot the same answers. Writing that package is a good
[first useful workflow](/blog/first-useful-kody-workflow) in its own right.

If you're setting this up now, here's a prompt for your own agent that looks
before it changes anything:

```text
Using Kody, look at my team org <your-org>. List the members and their roles,
the teams, which packages and apps each team or person can use, and which org
credentials are locked to specific packages. Don't change anything. Then propose
a front-desk team with Use on only the packages the front desk needs, and wait
for my approval before creating the team or any grants.
```
