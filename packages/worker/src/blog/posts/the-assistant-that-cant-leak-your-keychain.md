---
title: The personal assistant that can't leak your keychain
date: 2026-07-20
description:
  My assistant's account holds 51 secrets. Here's the security architecture that
  makes the scary failure modes structurally impossible instead of
  policy-discouraged.
order: 3
category: essays
---

My [Kody](https://kody.codes) account currently holds 51 secrets. API keys,
OAuth tokens, personal access tokens for services I actually use. My assistant
can act on my behalf across all of them.

If that sentence doesn't make you a little nervous, you haven't thought about it
hard enough. An AI assistant with your keychain is one prompt injection away
from being the most expensive mistake you've ever made. So before I trusted Kody
with key number one, I needed an answer to a specific question: what happens
when things go wrong?

**A personal assistant holding your keys is only acceptable if the scary failure
modes are structurally impossible, not policy-discouraged.** That distinction is
the whole post, so let me define it.

## Policy vs structure

Policy-discouraged means "we told the model not to do that." A system prompt
that says "never reveal secrets." A guideline. A hope. Policies fail the moment
a sufficiently clever input convinces the model to ignore them, and we have
years of evidence that such inputs exist.

Structurally impossible means the plaintext isn't there to leak. The model can't
reveal a secret it never had, the same way you can't pick a lock on a door that
doesn't exist. When I evaluate any system that combines LLMs with credentials,
this is the question I ask: is the safety property enforced by the architecture,
or by the model's good behavior?

Kody is Fair Source
([github.com/kody-hq/kody](https://github.com/kody-hq/kody)), so you don't have
to take my word for any of what follows. You can read the code. Here are the
three layers.

## Layer 1: execute runs in a box with nothing in it

Kody's `execute` tool runs user code in a sandboxed Cloudflare Worker isolate,
loaded via Worker Loader, and here's the important part: the sandbox is created
_without_ the parent environment. No platform bindings. No database handles. No
ambient authority over the host at all.

When code inside the sandbox needs to do something real (read a memory, write to
storage, schedule a job), that capability is RPC'd back into the platform, and
every one of those calls is scoped to the calling user's userId. The sandbox can
ask for things through a narrow doorway; it cannot reach around the doorway and
grab the platform's internals.

This matters because `execute` runs code your assistant wrote. Assistants write
buggy code. Sometimes they write code influenced by content they read on the
internet five seconds earlier. The design assumption is not "the code will be
well-behaved." The design assumption is "the code might be hostile, so give it
nothing to be hostile with."

## Layer 2: secrets your assistant literally cannot read

This is my favorite layer, because it's the one that sounds impossible until you
see the trick.

Secrets in Kody are encrypted at rest (AES-GCM under a server-side key) and
scoped to your user. When your assistant lists your secrets, it gets metadata:
names, descriptions, which hosts are approved. Never values. When code needs to
use a secret, it references a placeholder:

```ts
const response = await fetch('https://api.example.com/v1/things', {
	headers: {
		Authorization: 'Bearer {{secret:exampleApiKey}}',
	},
})
```

That `{{secret:exampleApiKey}}` string is what the assistant writes, what
appears in the code, and what shows up in any logs or results. The placeholder
is resolved into the real value in exactly one place: inside the platform's
fetch gateway, at the moment the outbound request is made. And the gateway only
resolves it for hosts you explicitly approved for that specific secret.

Host approval is deny-by-default. Saving a secret approves zero hosts. If I save
a Stripe key and approve `api.stripe.com`, then some injected instruction tricks
my assistant into writing code that sends the key to `evil.example.com`, the
resolution simply doesn't happen. The request goes out with a literal
placeholder string in the header, which is worth nothing.

Trace the plaintext's journey and you'll find it never enters a prompt, never
lands in chat, never appears in the assistant's context window, never comes back
in an execute result — and package code that calls `packageSecrets.get` receives
only an opaque `{{secret:…}}` placeholder, not the value. The model reasons
about a name. Only the gateway (and other platform use sites like JWT signing)
ever touches the value. There is no "please don't reveal the secret" instruction
anywhere, because there's no secret in reach to reveal.

## Layer 3: isolation all the way down to the Durable Object

Multi-tenant systems have a classic failure mode: the query that forgot the
`WHERE user_id = ?` clause. One missed filter and you're reading someone else's
data.

Kody's answer is to push isolation below the query layer. Every read and write
path is scoped by userId, and the stateful services (your job scheduler, your
storage, your package runtime) run in Cloudflare Durable Objects namespaced by
your userId. My scheduler is a different object than yours. My storage is a
different object than yours. Cross-user data sharing isn't a risk to be filtered
against per-query; it's treated as a bug in the platform, full stop, because the
architecture gives each user their own walls.

## The honest limits

I'd be doing you a disservice if I stopped here and let you believe this is
bulletproof. Every choice trades something off, so here's what this one doesn't
cover.

Non-secret outbound fetch from the sandbox relies on Cloudflare's platform
egress controls. There's no bespoke denylist sitting in front of every request
the sandbox makes. Sandboxed code can still talk to the internet, which is most
of why it's useful, and also why "the sandbox can't exfiltrate your secrets" is
a much stronger claim than "the sandbox can't do anything you'd dislike."

And more broadly: security is architecture plus review habits, not magic. The
layers above remove entire categories of failure, which is exactly what
architecture is for. They don't remove the need to pay attention to what your
assistant is doing on your behalf, especially when you install code someone else
wrote. The architecture buys you a system where a mistake is annoying instead of
catastrophic. That's the trade, and I think it's a great one.

## Why this is the bar

Kody is Your agents' cloud: the memory, keys, code, and automations it keeps, no
matter which agent I'm talking to. You connect the agent you already use over
MCP
([here's how](https://github.com/kody-hq/kody/blob/main/docs/use/connect-your-agent.md)),
and everything it accumulates lives in an account you own.

Your agents' cloud holding 51 keys had better be built like it. The full secrets
model is documented at
[Secrets and host approval](https://github.com/kody-hq/kody/blob/main/docs/use/secrets-and-values.md),
and the code behind every claim in this post is in
[the repo](https://github.com/kody-hq/kody).

If you'd rather own your assistant than rent one,
[kody.codes/signup](https://kody.codes/signup) is where to start. And whether or
not Kody is your thing, take the question with you: for every system holding
your keys, ask whether the safety property is enforced by structure or by hope.
You'll never look at a system prompt that says "never reveal secrets" the same
way again.
