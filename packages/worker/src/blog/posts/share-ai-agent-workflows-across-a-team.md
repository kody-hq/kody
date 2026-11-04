---
title: How to share AI agent workflows across a team
date: 2026-11-03
description:
  "Copy my prompt" doesn't scale. A concrete way to share AI agent workflows with teammates, teams, and contractors without sharing anyone's keys.
order: 13
---

Here's how agent workflows get shared on most teams today. Someone posts in
Slack: "I built a thing that turns a Linear project into a release checklist.
Want it?" Ten people say yes. The author replies with a wall of prompt text, a
link to a gist with a script, and "you'll need to set `LINEAR_API_KEY` and
`GITHUB_TOKEN`."

Three people get it working. Two of them change the prompt a little. A month
later, the author fixes a bug, and nobody else gets the fix. A contractor asks
for it and someone emails them the gist, keys and all, because the script had a
token hardcoded "just for testing."

The problem isn't the workflow. It's that there's no real way to share it. A
prompt isn't versioned. A gist isn't permissioned. And the credentials go along
for the ride.

## What "shared" should mean

When I share a workflow with my team, I want:

- **One source of truth.** A fix lands once and everyone gets it.
- **Different levels of access.** Most people should run it. A few should be
  able to change it. One or two should decide who else gets it.
- **No shared secrets.** Sharing the workflow shouldn't share my keys.
- **Works from whatever agent they use.** My teammate on Cursor and my teammate
  on Claude Code should both be able to run it.
- **Revocable.** I can take it back, and people who leave lose it.

That's a permissions problem, not a prompt problem.

## Workflows as packages

In [Kody](https://kody.codes), the layer under your team's assistants, a shared
workflow is a **package**: a repo-backed TypeScript project with named exports,
living in your team org. Any agent connected to Kody can find it and run it.
I've written before about
[why duplicated tooling is expensive](/blog/hidden-cost-of-everyone-building-agent-tooling);
this post is about the mechanics of sharing once you have the package.

## Pick who gets it

Kody grants a package to one of four kinds of people:

- **A person** in your org
- **A team** in your org (create teams like "platform" or "support" and grant to
  the team, so membership changes carry over)
- **Everyone in the org**, as one live grant that covers people who join later
  and drops people who leave
- **An outside collaborator**, someone who isn't a member. They get access to
  that package and catalog search, and nothing else in your org.

## Pick what they can do

Each grant has a preset: **Read** (source, clone, fork), **Use** (read and run),
**Contribute** (use plus write), or **Manage** (contribute plus publish, delete,
manage access). A reasonable default for a team workflow:

- Everyone in the org: **Use**
- The team that owns the process: **Contribute**
- The author plus one backup: **Manage**
- A contractor: **Use** on just that package, as an outside collaborator

Grants can also carry an expiry, which is handy for contractors and temporary
access.

## Send a link instead of a gist

You don't have to collect usernames. A package's **Collaborators** tab can
create an invite link that grants a chosen preset on that package. The person
opens it, signs in or creates an account, sees exactly what the link gives and
who sent it, and chooses **Accept** or **Decline**. Nothing happens until they
accept.

A few properties make these links safer than a gist:

- Links expire (7 days by default) and can be limited to a number of uses.
- Kody stores only a hash, so the full URL is shown once.
- You can revoke a link any time.
- Creating, revoking, and accepting are recorded in the org audit log.

For bringing a whole team on, Members links and team links work the same way at
the org level.

## Credentials don't travel with the share

This is the part that replaces "you'll need to set `LINEAR_API_KEY`." The
package doesn't contain keys. It declares what it needs, like "a Linear account"
and "a GitHub account," and each person who runs it maps those needs to
credentials they're allowed to use: a team credential, or their own.

Two rules keep this honest:

- **A Use grant never reveals credential values.** Nobody can read anyone's key,
  including Owners.
- **A Use grant doesn't grant credential use, either.** If the package needs a
  team credential, the person also needs a grant on that credential. Package
  access and credential access are separate decisions.

Kody also warns you at share time in one specific risky case. If a package
always acts with the owning org's credentials (nobody running it can swap in
their own), then giving someone Contribute or Manage means they could change the
code to use those credentials differently. Kody still lets you make the grant,
but returns a warning naming each such credential so you decide with your eyes
open.

## Fork vs share

Sometimes a teammate wants the workflow but different. They shouldn't edit the
team's version. They can **fork** it instead: a fork is a copy they own and
adapt. A **grant** is access to the original. The rule of thumb:

- Want the fix when the author fixes it? Get a grant.
- Want to take it somewhere else? Fork it.

## A rollout for one workflow

Take the release checklist example:

1. The author asks their agent to turn the prompt and gist into a Kody package
   in the team org, declaring Linear and GitHub as credential needs.
2. Grant everyone in the org **Use**, and the release team **Contribute**.
3. Make sure there's a team Linear credential (or have people connect their own)
   and grant it to the release team.
4. Post one link in Slack instead of the wall of prompt text.
5. Delete the gist and rotate the token that was in it.

From then on, everyone runs the same version from their own agent, and the
author's next fix reaches everyone.

If you're working out whose credentials the shared workflow should use, the next
posts dig into it:
[one set of credentials across Claude Code, Cursor, and Codex](/blog/share-credentials-across-claude-code-cursor-codex)
and
[bring your own key for shared tools](/blog/bring-your-own-key-shared-agent-tools).

## Share one today

Pick the workflow your team asks about most. Turn it into a package in a Kody
team org and share it with everyone at Use. Start at
[kody.codes](https://kody.codes), and keep the
[package sharing guide](https://kody.codes/docs/package-sharing) open for the
presets and invite links.
