---
title:
  Your engineers are handing private keys to AI agents. Here's what that means.
date: 2026-09-01
description:
  Every agent your team connects ends up holding real API keys. Here's where
  those keys hide today and how to keep them out of the model's context.
order: 1
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
  repo, even though nobody can read the token. Scoping still starts at the
  provider. That's what
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

More in this series:

- [AI agent GitHub access without handing over your token](/blog/ai-agent-github-access-without-your-token)
- [A team lead's guide to AI agent credentials](/blog/ai-agent-credentials-guide-for-team-leads)
- [Where to store API keys for AI agents (not in agent configs)](/blog/where-to-store-api-keys-for-ai-agents)
- [Least privilege for AI agents, a practical setup](/blog/least-privilege-for-ai-agents)
