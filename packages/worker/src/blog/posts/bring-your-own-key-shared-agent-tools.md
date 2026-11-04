---
title: Bring your own key: letting each teammate run shared tools under their own account
date: 2026-11-03
description: Shared agent tools shouldn't run as whoever built them. How to let each teammate run the same tool under their own account, with no keys shared.
order: 16
---

Someone on your team built an agent tool that drafts weekly status updates from
your calendar and your merged PRs. Everyone wants it. But it was built against
one person's Google account and one person's GitHub token. If you share it as
is, everyone's status update is about the author's week, posted as the author.

So the usual workaround kicks in. People copy the tool, swap in their own
tokens, and now you have six copies, which is the duplication problem from
[the hidden cost of every engineer building their own agent tooling](/blog/hidden-cost-of-everyone-building-agent-tooling).
Or, worse, the author's token gets shared "just for now."

What you actually want is one tool and many accounts. Everyone runs the same
code. Each run uses the account of whoever is running it.

## Why this is hard with scripts and prompts

The difficulty is that most agent tooling mixes two things together: the
behavior ("summarize my week") and the identity ("as this Google account"). When
the key is an environment variable or a line in a config, the only way to change
the identity is to change the copy.

Separating them takes three pieces:

1. The tool says _what kind_ of account it needs, not which one.
2. Each person has their own account connected somewhere the tool can reach,
   without seeing the key.
3. At run time, something picks the right account for the person running it, and
   refuses to guess if it's unclear.

## How Kody splits behavior from identity

In [Kody](https://kody.codes), the layer under your team's assistants, the tool
is a **package**. It declares the accounts it needs in `package.json`:

```json
{
	"kody": {
		"credentials": {
			"calendar": {
				"provider": "google",
				"description": "Calendar of the person writing the status update"
			},
			"github": {
				"provider": "github",
				"description": "GitHub account whose merged PRs to include"
			}
		}
	}
}
```

The code opens each need by name with `credential('calendar')` and gets back a
client that can make requests. It never holds a key. Which actual account fills
that need is decided per caller, not baked into the code.

## Each teammate connects their own account

For providers with OAuth, the cleanest path is the team's OAuth app. An Owner
registers it once in the team org. Each member opens it and clicks **Connect
your own account**, signs in to Google as themselves, and their connection is
saved for them only. It's used only in their own runs in that org. Not in
another member's runs, not by Owners, not by automation acting for someone else.

For providers that only issue API keys, each person saves their own key in Kody
through a creation link, pasting the value into a Kody page instead of a chat.

Either way, the author never sees anyone else's credential, and nobody else ever
sees the author's.

## How the right account gets picked

When the package calls `credential('github')`, Kody picks the credential using
the first rule that applies:

1. **A per-run choice.** The caller can pass a credentials map on `execute`, or
   `--credential github=work` on the CLI.
2. **A mapping on the trigger** that started the run, for scheduled work.
3. **A default mapping on the package.** This can be a personal default (yours
   only) or an org default.
4. **The one matching credential** the caller is allowed to use.

And the important rule: **Kody never guesses.** If there are no matches, the run
stops with `credential_unbound`. If there are two, it stops with
`credential_ambiguous`. Both errors are clear enough for an agent to read and
fix the mapping, or to ask the person which account they meant.

That's what makes this safe as a team default. A teammate who hasn't connected
GitHub yet gets an error telling them so, not a status update quietly built from
someone else's data.

## When one person needs more than one account

Plenty of people have a work and a personal calendar, or two GitHub accounts. A
need can be declared with `multiple: true`, and then the package opens several
accounts at once. The per-run map can pick an array, like
`"calendar": ["work", "personal"]`. Same rule: explicit, never guessed.

## Scheduling it for everyone

Once the package works this way, each teammate can turn on the weekly schedule
for themselves. A scheduled job in Kody runs as the person who turned it on,
with their live access, so each person's Friday run uses their own calendar and
GitHub account. If they leave the team, their run pauses rather than borrowing
anyone else's access. I covered that more in
[What happens to your team's AI workflows when someone quits](/blog/team-ai-workflows-when-someone-quits).

## What a team lead should check

A few things worth confirming before you roll a shared tool out this way:

- **Package access and credential access are separate.** Granting someone Use on
  the package doesn't grant them any credentials. That's the point: they bring
  their own.
- **Some tools should use a team account.** A tool that posts to the team's
  shared channel as the team bot should use a team credential, not each
  person's. Decide per need. See
  [a team lead's guide to AI agent credentials](/blog/team-lead-guide-to-ai-agent-credentials).
- **Watch for packages that always use the owner's credentials.** If a package
  is set up so callers can't swap in their own account, Kody warns when you give
  someone Contribute or Manage on it, because they could change how those
  credentials get used.

## Convert one tool

Take the most-copied agent tool on your team:

1. Turn it into a Kody package in your team org, with each account as a declared
   need instead of an environment variable. Your agent can do the conversion.
2. Register the team's OAuth app for the provider, or ask everyone to save their
   own key.
3. Share the package with everyone at Use.
4. Ask each person to connect their account and run it once. Anyone who skipped
   step 2 gets a `credential_unbound` error that tells them what to do.

Start at [kody.codes](https://kody.codes). The
[shared packages guide](https://kody.codes/docs/shared-packages) has the full
mapping rules, and the [OAuth guide](https://kody.codes/docs/oauth) covers
connecting through an org's app.
