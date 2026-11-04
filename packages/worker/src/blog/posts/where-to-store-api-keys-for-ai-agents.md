---
title: Where to store API keys for AI agents (not in agent configs)
date: 2026-09-08
description:
  MCP configs and .env files spread API keys across every laptop and agent.
  Here's how to connect agents to services without putting keys in config files.
order: 4
---

If you're wondering where to store API keys for AI agents, start with where they
live today. Here's a real-looking `~/.cursor/mcp.json`:

```json
{
	"mcpServers": {
		"sentry": {
			"command": "npx",
			"args": ["-y", "some-sentry-mcp"],
			"env": { "SENTRY_AUTH_TOKEN": "sntrys_..." }
		},
		"stripe": {
			"command": "npx",
			"args": ["-y", "some-stripe-mcp"],
			"env": { "STRIPE_SECRET_KEY": "sk_live_..." }
		}
	}
}
```

Now picture that same file, give or take, on every engineer's laptop. And then
again in their Claude Code config, because they use both. And again in a Codex
config, because they're trying it out this week. Each copy is plaintext, sitting
in a home directory, readable by any process running as that user, including the
agents themselves.

This is how most teams wire agents to services today. It works on day one. It's
a mess by month three.

## What goes wrong with API keys for AI agents in config

None of these are exotic:

- **Copies multiply.** Every new agent or machine is another copy of every key.
  Nobody has a list.
- **Rotation is a scavenger hunt.** When you rotate the Stripe key, you have to
  find every config that had the old one. You won't find them all, so either
  something breaks or you delay rotating.
- **Configs get shared.** "Just copy my MCP config" is a common onboarding
  shortcut. That copies the keys too. Sometimes into a gist. Sometimes into a
  dotfiles repo.
- **The agent can read them.** An agent with file access can read its own
  config. If it's ever tricked into doing something with that file, the keys go
  with it.
- **Live keys sneak in.** It's easy to grab the live key because the test key
  didn't have the data you wanted, and then forget.

If you're a team lead, the uncomfortable part is that you can't see any of this.
It's all on individual laptops.

## The alternative: one connection, keys stay server-side

With [Kody](https://kody.codes), each agent gets one MCP entry, and that entry
has no keys in it:

```json
{
	"mcpServers": {
		"kody": { "url": "https://kody.codes/mcp" }
	}
}
```

The agent signs in to Kody through the browser the first time. After that, it
can use any service connected to the account by name. The keys themselves live
in Kody, and Kody fills them into outgoing requests at the network boundary,
only for the hosts each key is approved for.

Connected MCP servers work the same way. Instead of each engineer running their
own copy of a Sentry MCP server with a token in its `env` block, you add the
remote server to Kody once. Agents call its tools through Kody, and the server's
auth stays on Kody's side.

## How a key gets in without being pasted into chat

The other half of the problem is how keys get in. If you replace "paste it in
the config" with "paste it in the chat," you haven't gained much. Now the key is
in a transcript instead of a file.

So Kody agents don't ask for values. When an agent needs a new credential, it
builds a link to a Kody page with the details filled in: the credential's name,
a description, the host it should be sent to, and optionally an expiry. You open
the link, paste the value into the page, and save. The agent sees that the
credential now exists. It never sees what you pasted.

That's also the moment to check the approved host. A Stripe key should be
approved for `api.stripe.com` and nothing else. Hosts live on the credential
itself, and an agent can't add hosts to a credential. That takes a person on the
Credentials page.

## Use your existing vault if you have one

Plenty of teams already keep secrets in 1Password, Bitwarden, or Doppler and
don't want a second source of truth. Kody supports **secret provider** packages:
a package that knows how to look up values in your vault. Code then uses a
placeholder like `{{secret/1password:<item ref>}}`, and Kody fetches the value
from the vault at the network boundary. Same rule: the value never shows up in
the agent's context or the code.

There are community examples of this in the public Kody Discord, including
`@kody/doppler` and Bitwarden vault packages shared by community members, if you
want something to fork.

## What this does to rotation

This is the payoff I care about most as someone who has rotated a lot of keys.
When a key lives in one place:

1. Rotate it at the provider.
2. Update the one credential in Kody.
3. Done. Every agent, on every machine, picks up the new value on its next
   request, because none of them ever had a copy.

Kody also lets you put an expiry on a credential. After it passes, Kody treats
the credential as missing and stops sending it. If you set that to match the
provider's expiry, the "stale key quietly keeps working" problem goes away.

## A cleanup you can do this afternoon

1. Ask your engineers to run
   `grep -l -E "sk_|ghp_|sntrys_|xoxb-" ~/.cursor/mcp.json ~/.claude.json ~/.codex/config.toml 2>/dev/null`
   (or whatever paths their agents use) and count the hits. You don't need the
   values, just the count.
2. Pick the service that shows up most. Add it to Kody once, in the team org if
   it's a team-owned account.
3. Replace that MCP entry with the single Kody entry, then delete the old key
   from every config and rotate it at the provider.

Not sure which credentials belong in the team org and which are personal? I
wrote
[a team lead's guide to AI agent credentials](/blog/ai-agent-credentials-guide-for-team-leads)
for exactly that. And if you're wondering why keys in agent-readable files are
risky in the first place,
[Your engineers are handing private keys to AI agents](/blog/engineers-are-handing-private-keys-to-ai-agents)
covers it.

[Connect your agent to Kody](https://kody.codes/onboarding) and move your first
key out of a config file today.

More in this series:

- [ Your engineers are handing private keys to AI agents. Here's what that means.](/blog/engineers-are-handing-private-keys-to-ai-agents)
- [Least privilege for AI agents, a practical setup](/blog/least-privilege-for-ai-agents)
- [Sharing credentials across Claude Code, Cursor, and Codex without copying secrets](/blog/claude-code-cursor-and-codex-shared-credentials)
- [An MCP security checklist for engineering managers](/blog/mcp-security-checklist-for-engineering-managers)
