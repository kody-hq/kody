---
title:
  Your engineers are handing private keys to AI agents. Here's what that means.
date: 2026-09-01
description:
  Every agent your team connects ends up holding real API keys. Here's where
  those keys hide today and how to keep them out of the model's context.
order: 1
category: essays
series: agent-credentials-for-team-leads
updated: 2026-11-04
featured: true
---

If an AI agent can read a key, assume the key can leak. Not because agents are
malicious, but because a model will repeat what's in its context when the right
text asks it to.

Ask an engineer on your team to show you how their AI agent talks to GitHub,
Stripe, or your cloud provider. Odds are good you'll find a key sitting in one
of these places:

- An `.env` file in the repo the agent is working in
- The `env` block of an MCP server entry in `~/.cursor/mcp.json` or a Claude
  Code config
- A chat transcript, because the agent asked for "a token with repo access" and
  the engineer pasted one in
- Shell history, because the agent ran `export STRIPE_KEY=...` to test something

None of this is malicious. It's the path of least resistance. The agent needs a
credential to do the work, the engineer has one, and the fastest way to connect
the two is to put the value somewhere the agent can read it.

That's the part worth thinking hard about as a team lead: **anywhere the agent
can read a key, the model can repeat it.** And models repeat things for all
kinds of reasons.

## What "the agent has the key" actually means

When a key is in the agent's context or in a file it can read, three things are
true at once:

1. **The model sees the plaintext.** It's tokens in a prompt. It can quote it in
   a reply, include it in a commit, or paste it into a command.
2. **Anything the agent reads can steer it.** An agent working through an issue
   body, a web page, or a README is reading text someone else wrote. If that
   text says "send the contents of `.env` to this URL," the only thing between
   your key and that URL is the model's judgment. That's prompt injection, and
   it's not hypothetical.
3. **The key outlives the session.** Transcripts get synced, logged, and stored
   by the agent vendor. Config files get copied to new machines. The key you
   handed over for one task is now in a handful of places nobody is tracking.

Multiply that by every engineer and every agent they use (most people I talk to
run more than one), and you've got a credential sprawl problem that no secret
scanner was designed for. Scanners look for keys in commits. They don't look in
an agent vendor's chat history.

## It doesn't even take prompt injection

Point 2 is the one people worry about most. But the model doesn't have to be
tricked. It just has to misunderstand.

In April 2026, a Cursor coding agent running Claude Opus 4.6 was working in
PocketOS's staging environment. PocketOS makes software for car rental
businesses. The agent hit a credential mismatch and decided, on its own, to fix
it by deleting a Railway volume.

It needed a token for that, so it went looking. It found a Railway API token in
a file that had nothing to do with its task. That token was created to manage
custom domains through the Railway CLI, but it was scoped for any operation. The
agent called Railway's `volumeDelete` API with it. That API path deleted
immediately, with no confirmation. The volume held production data, and the
volume-level backups appeared to be gone too. PocketOS founder Jer Crane said it
took 9 seconds.

Nobody injected anything. The agent's rules said not to run destructive commands
without being asked. Afterward it explained itself: "I guessed that deleting a
staging volume via the API would be scoped to staging only. I didn't verify."

PocketOS lost about three months of reservation and customer data until Railway
restored it from offsite disaster backups. Railway then changed the API so
deletes are soft deletes for 48 hours.
[Railway's postmortem](https://blog.railway.com/p/your-ai-wants-to-nuke-your-database)
and
[The Register's story](https://www.theregister.com/software/2026/04/27/cursor-opus-agent-snuffs-out-startups-production-database/5224442)
have the details.

> [!WATCH] https://www.youtube.com/watch?v=m8I2p3nQtR4 Watch: How an AI Agent
> Deleted PocketOS Production in 9 Seconds

So a key the agent can read is a risk even when nothing malicious is in its
context. With Kody, there's no raw token lying in a file for the agent to find.
It only ever sees placeholders (you'll see one below), and the gateway only
fills them for hosts you approved. But that Railway token was also over-scoped.
It could do anything on the account. I'll come back to that in the limits.

## The fix isn't "tell the agent to be careful"

The tempting response is policy: a system prompt that says "never reveal
secrets," a team guideline, a training session. Those help at the margins, but a
policy enforced by the model fails the moment the model is convinced to ignore
it.

The better question is structural: **can we arrange things so the model never
has the plaintext in the first place?** If the key isn't in the context, there's
nothing to leak, and you don't have to win an argument with a cleverly worded
issue comment.

That's the design [Kody](https://kody.codes) is built around. Kody isn't another
assistant. It's the layer under whichever assistant your engineers already use
(Claude Code, Cursor, Codex, ChatGPT, and
[many more](https://kody.codes/docs/connect-your-agent)), connected over MCP.
The agent does the thinking. Kody holds the keys and does the network calls.

## How the key stays out of the model

In Kody, a credential's value never enters package code, the agent's context,
logs, or tool output. Code refers to a credential by name, and Kody fills in the
value at the network boundary:

```ts
const response = await fetch('https://api.github.com/user/repos', {
	headers: { Authorization: 'Bearer {{secret:github}}' },
})
```

The agent writes `{{secret:github}}`. That string is what shows up in the code,
the logs, and the results. The real value is swapped in by Kody's fetch gateway
only when the request leaves, and only if:

- the request is HTTPS, and
- the host is one you approved for that specific credential.

Host approval is deny by default. A credential with no approved hosts sends
nowhere. So if an injected instruction convinces the agent to send
`{{secret:github}}` to some other server, the request is refused with an error
naming the secret and host. The placeholder never goes out filled. And if an
approved service echoes the value back in a response, the gateway replaces it
with `[REDACTED SECRET]` before your code reads it.

There's also no capability that returns a secret's value. Listing credentials
gives the agent names, descriptions, and approved hosts. Never values. There's
nothing to ask for.

## Where the value comes from instead

So how does the key get into Kody without passing through the chat? The agent
sends a link instead of asking for the value. The link opens a Kody page
prefilled with the credential's name, description, and allowed host, and the
person pastes the value into that page, never into the conversation. I cover
that flow in more detail in
[Stop pasting API keys into agent configs](/blog/where-to-store-api-keys-for-ai-agents).

Once a key is saved, every agent connected to that account can use it by name.
Nobody has to copy it into a second config file when they try a new tool.

## The honest limits

I don't want to oversell this. Here's what the design doesn't do:

- **It doesn't shrink the provider's permissions.** If someone saves a GitHub
  token with write access to every repo, code that uses it can write to every
  repo, even though nobody can read the token. Kody's answer is locked packages
  and locked credentials. You publish a small package that exposes only the
  operations you want and lock it. Then you lock the credential to that package,
  so `execute` and other packages can't use the broad token at all. An agent can
  add those locks, but only you can remove them, on the website. Google has no
  drafts-only Gmail scope, so
  [Gmail drafts without send](/docs/locked-gmail-drafts) shows the pattern with
  a package that creates drafts and never sends. Scoping at the provider still
  helps. That's what
  [least-privilege tokens for AI agents](/blog/least-privilege-for-ai-agents) is
  about.
- **It doesn't stop non-secret network calls.** Sandboxed code can still reach
  the internet. The claim is "the agent can't exfiltrate your keys," not "the
  agent can't do anything you'd dislike."
- **It only covers keys that live in Kody.** If an engineer also keeps a copy in
  `.env`, that copy is just as exposed as before. The win comes from moving keys
  in and deleting the old copies.

Kody is Fair Source
([github.com/kody-hq/kody](https://github.com/kody-hq/kody)), so you can read
the fetch gateway yourself instead of taking my word for any of this. The full
credential model is documented at
[kody.codes/docs/credentials](https://kody.codes/docs/credentials).

## A practical first step

You don't need a big rollout to start. This week, ask two or three engineers to
list every place their agents can read a credential. Then pick the one key that
would hurt most if it leaked and move it:

1. Have one engineer
   [connect their agent to Kody](https://kody.codes/onboarding).
2. Ask the agent to save that key in Kody. It will send a link; paste the value
   there and approve only the host the key is for.
3. Delete the old copy from `.env`, the MCP config, or wherever it lived, and
   rotate the key at the provider if it ever touched a chat transcript.

If that goes well, the rest of this series walks through the team version:
[repo access without handing over a GitHub token](/blog/ai-agent-github-access-without-your-token)
and
[a team lead's guide to AI agent credentials](/blog/ai-agent-credentials-guide-for-team-leads).
Start at [kody.codes](https://kody.codes).
