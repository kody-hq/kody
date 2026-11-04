---
title:
  The hidden cost of AI tooling for engineering teams when everyone builds their
  own
date: 2026-10-13
description:
  Five engineers, five private scripts doing the same job. Why duplicated agent
  tooling costs more than it looks, and how to build it once for the team.
order: 11
---

Ask around your team and you'll find something like this. Three engineers have
each built an agent workflow that pulls open PRs and pings reviewers in Slack.
One wrote a Python script their agent shells out to. One has a long prompt saved
in Cursor rules. One found a community MCP server and configured it with their
own token. They all do roughly the same thing. None of them know about the
others. That's what AI tooling for engineering teams looks like when nobody owns
it.

Individually, each one was a good idea. Collectively, it's waste you can't see,
and it gets more expensive the more AI-forward your team becomes.

## What duplication actually costs

It isn't just the hours spent building the same thing three times. The bigger
costs show up later:

- **Three sets of credentials.** Each version has its own GitHub token and Slack
  token, scoped however its author felt like that day, stored wherever their
  agent reads config. That's three things to rotate and three places to leak
  from.
- **Three sets of bugs.** When GitHub changes an API or Slack deprecates a
  method, each version breaks on its own schedule, and each author fixes it
  alone, if they notice.
- **Three behaviors.** One pings reviewers after a day, one after an hour, one
  whenever the agent feels like it. Your team's "process" is whatever each agent
  improvised.
- **Zero leverage for new hires.** The next person who joins builds a fourth
  version, because there's nothing to find.
- **Recurring token spend.** If the tooling is a prompt, the model re-derives
  the procedure on every run. I wrote about that in
  [why your AI agent bill keeps growing](/blog/why-ai-agent-costs-keep-growing).

The root cause isn't that engineers are doing something wrong. It's that agent
tooling has nowhere to live. A script lives on a laptop. A prompt lives in one
assistant's settings. Neither is somewhere a teammate can find, run, or improve.

## Give AI tooling for engineering teams a home

[Kody](https://kody.codes) is the layer under the assistants your team already
uses, and the unit of tooling there is a **package**. A package is a small
repo-backed TypeScript project with named exports. It's built for exactly the
gap above:

- **It's findable.** Agents search for packages before writing new code. Kody's
  own package lifecycle guidance tells agents to reuse what exists, fork a close
  public package, and only then create a new one.
- **It's runnable by any agent.** A package works from Claude Code, Cursor,
  Codex, ChatGPT, or anything else connected to Kody. The Python script only
  worked for the engineer whose laptop it was on.
- **It's reviewable.** It's code in a git repo with versions, not a prompt.
- **It doesn't contain keys.** Packages declare the credentials they need by
  name, and Kody fills values in at the network boundary.

## One package, shared with the team

Once one engineer's PR-reminder workflow is a package in your team org, sharing
it is a grant, not a copy. Kody has four sharing presets:

| Preset     | Can do                                         |
| ---------- | ---------------------------------------------- |
| Read       | See the source, clone, fork                    |
| Use        | Read and run                                   |
| Contribute | Use plus write                                 |
| Manage     | Contribute plus publish, delete, manage access |

You can share with a person, a team in your org, or **everyone in the org**. The
everyone grant resolves live: it covers current members and anyone who joins
later, and someone who leaves loses it right away. So the fourth engineer who
joins next month can find and run the same package on day one.

Give the original author Manage, give the people who care about it Contribute,
and give everyone Use. Now improvements land in one place.

## Same code, everyone's own account

The usual objection: "but it needs to post as me, not as the author." Shared
packages handle that. A package declares a need like "a Slack account," and each
person who runs it maps that need to their own credential. The code is shared.
The accounts aren't. Using a package doesn't give anyone the author's
credentials, and nobody can read anyone else's key. I'll cover that pattern in
more depth in a later post on bring-your-own-key team tools.

## Forks for the people who want something different

Sometimes a teammate really does want different behavior. That's fine. They can
fork the package: a fork is a copy they own and adapt, with its own history. The
difference from today is that the fork starts from working team code instead of
a blank prompt, and you can see that it exists.

The same goes for starting points outside your team. The Kody community has
public packages you can fork instead of writing from scratch, like the public
`@kody/github` and `@kody/slack` packages. Community members also share what
they've built in the public Kody Discord; packages for things like Doppler and
Bitwarden secrets have been shared there. Forking one of those is usually faster
than asking an agent to start over.

## What to do with the existing copies

You don't need a big migration. Here's what I'd do:

1. **Find the duplicates.** In your next team meeting, ask everyone to name
   their three most-used agent workflows. You'll spot the overlaps immediately.
2. **Pick the best version of the most common one.** Usually it's whichever has
   the most edge cases handled.
3. **Have its author turn it into a Kody package** in the team org. Their agent
   can do the conversion: "Turn this script into a Kody package that declares
   GitHub and Slack credentials."
4. **Share it with everyone at Use**, and ask the other authors to try it and
   delete their versions (and the tokens those versions used).

Repeat once a month and the pile of private tooling shrinks while the shared
pile grows.

## Next step

Create a team org on [kody.codes](https://kody.codes), move one duplicated
workflow into it as a package, and share it with everyone in the org. The
[sharing guide](https://kody.codes/docs/package-sharing) covers presets and
grants, and the
[package lifecycle guide](https://kody.codes/docs/package-lifecycle) covers
reuse versus fork versus create.

More in this series:

- [How to share AI workflows with your team](/blog/share-ai-workflows-with-your-team)
- [Why AI agent costs keep growing (and how deterministic tools cut tokens)](/blog/why-ai-agent-costs-keep-growing)
- [AI agent skills vs packages, turning prompts into reviewable code](/blog/ai-agent-skills-vs-packages)
- [When an engineer quits, their AI workflows break or keep running on their keys](/blog/team-ai-workflows-when-someone-quits)
