---
title: Least privilege for AI agents, a practical setup
date: 2026-09-15
description:
  A layer-by-layer least-privilege setup for AI agents:
    provider scopes, host allowlists, fill placement, package-only keys, locks,
    and expiry.
order: 5
---

Least privilege for AI agents is easy to agree with and hard to actually do.
Here's the usual sticking point. You want the agent to post release notes to one
Slack channel. Slack's bot token scopes let you get close, but the token can
still post to any channel the bot is in. The agent, meanwhile, can write any
code it wants against that token. So where exactly is the "least" part supposed
to live?

The answer is that it can't live in one place. A provider scope is one layer.
For agents, you need a few more, because the thing holding the token is a
program that writes new programs. This post is the stack I use, from the outside
in, with what each layer does and doesn't cover.

## Layer 1: scope the token at the provider

Nothing downstream can make a broad token narrow, so this is always first.

- Prefer fine-grained tokens over classic ones. GitHub's fine-grained personal
  access tokens let you pick repositories and set each permission to read or
  write. I walk through a real example in
  [How to give an AI agent repo access without giving it your GitHub token](/blog/ai-agent-github-access-without-your-token).
- Prefer test or restricted keys. Stripe restricted keys and test mode keys
  exist for exactly this.
- Use the shortest expiry the provider will let you live with.

Write down what the token is for in one sentence. If you can't, the token is
probably too broad.

## Layer 2: keep the value away from the model

A tightly scoped token pasted into a chat transcript is still a leak. In
[Kody](https://kody.codes), the layer under whatever assistant your team already
uses, a credential's value never enters the agent's context or package code.
Code refers to it by name, like `{{secret:slackBot}}`, and Kody fills the value
in at the network boundary. Agents get a creation link and you paste the value
into a Kody page, not the chat.

That's the foundation the rest of the layers build on. If you want the longer
explanation of why, it's in
[Your engineers are handing private keys to AI agents](/blog/engineers-are-handing-private-keys-to-ai-agents).

## Layer 3: approve exactly one host

Every Kody credential carries a list of approved hosts. It's deny by default: a
credential with no approved hosts can't be sent anywhere, and requests must be
HTTPS. For the Slack example, approve `slack.com` and nothing else.

Two properties make this layer meaningful for agents:

- **Hosts live on the credential, not in package code.** Publishing or forking a
  package can't widen where a key is sent.
- **Agents can't edit hosts.** Changing them takes a person on the Credentials
  page, and each change is recorded in the org audit log.

So "send this token to my server" isn't something an agent can talk its way
into.

## Layer 4: restrict where in the request the value can go

This one is subtle and most people skip it. A token sent in an `Authorization`
header is one thing. The same token placed in a URL query string can end up in
the provider's access logs, a proxy, or a browser history.

Kody stores an allowed **fill placement** on each credential: headers, query,
path, and/or body. New credentials default to headers only. Query, path, and
body each need the owner's opt-in on the credential page, which warns you that
the host may store a value sent there. Agents can't widen placement. If code
tries to fill a placement the credential doesn't allow, the request is refused
and the agent gets an approval link to hand you, so you make the call.

There's a related setting worth knowing for code that forwards text someone else
wrote, like an issue body. Setting the `x-kody-secret-resolution: headers-only`
request header means only headers get filled, even when the credential allows
more.

## Layer 5: limit which packages can use it

By default, any package in the org can use a credential (still without reading
it). For high-value keys, narrow that. On the credential form, **Which packages
can read it** can be set to **Only these packages**. Or create the key from a
package's own **Credentials** tab with **Add a key only this package can read**.

Now an ad hoc script the agent writes on a Tuesday afternoon can't use the key
at all. Only the code you chose can.

## Layer 6: lock the behavior when the token is too coarse

Sometimes the provider simply doesn't offer the scope you want. Kody's docs use
Gmail as the example: there's a send scope, and no drafts-only scope. If you
want an agent that can draft emails but never send, the provider can't help.

The pattern is:

1. Publish a small package that only creates drafts.
2. Lock the package so its published code can't quietly change. Agents can lock
   a package but can't unlock it. Unlock is a person on the website.
3. Lock the integration to that package, so ad hoc code can't borrow the token
   and no other package can use it.

After that, the only thing that can use the Gmail connection is code you've
read, and a later publish can't add a send path without a person signing off.
The same pattern works for a connected MCP server: lock the server to a thin
wrapper package and only that package can call its tools. The step-by-step is in
[Gmail drafts without send](https://kody.codes/docs/locked-gmail-drafts).

## Layer 7: let it expire

Give the Kody credential an expiry that matches the provider's. Once it passes,
Kody treats the credential as missing and stops sending it. That's a nice safety
net for the token you meant to rotate and didn't.

## Least privilege for AI agents, all seven layers together

Here's the Slack release-notes setup, end to end:

| Layer     | Setting                                                 |
| --------- | ------------------------------------------------------- |
| Provider  | Bot token with `chat:write`, bot invited to one channel |
| Custody   | Saved in Kody through a creation link                   |
| Host      | `slack.com` only                                        |
| Placement | Headers only (the default)                              |
| Packages  | Only the `release-notes` package                        |
| Lock      | Package locked after review                             |
| Expiry    | Matches your rotation schedule                          |

None of these layers is perfect alone. Together they turn "the agent has a Slack
token" into "one reviewed package can post with a token nobody can read, to one
host, in one header."

Want to see who's allowed to use which credentials across your team? That's
covered in
[a team lead's guide to AI agent credentials](/blog/ai-agent-credentials-guide-for-team-leads).

## Start with one token

Pick the most powerful token your team's agents use today and walk it down this
list. [Connect your agent to Kody](https://kody.codes/onboarding), ask it to
save the token with one approved host, and then restrict it to the one package
that needs it. The full reference is in the
[credentials guide](https://kody.codes/docs/credentials).

More in this series:

- [AI agent GitHub access without handing over your token](/blog/ai-agent-github-access-without-your-token)
- [Where to store API keys for AI agents (not in agent configs)](/blog/where-to-store-api-keys-for-ai-agents)
- [How to revoke AI agent access in one place](/blog/revoke-ai-agent-access)
- [An MCP security checklist for engineering managers](/blog/mcp-security-checklist-for-engineering-managers)
