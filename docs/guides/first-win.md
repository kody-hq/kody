---
id: first_win
title: Email and memories: the welcome-email loop
summary:
  Optional agent playbook: send a welcome email, point the person at their own
  inbox to reply, look the reply up when they say it is sent, save what matters
  as memories, then offer a next step. After Connect your agent (`/onboarding/step-1`),
  Step 2 is Make something useful (`/onboarding/step-2`) and Step 3 is Connect a
  second agent (`/onboarding/step-3`); the optional climax guide is
  quick-example. Load this when someone wants the email loop. Includes the
  no-polling rule and troubleshooting for missing mail and unbound tools.
category: platform
audience: agents
---

# Email and memories: the welcome-email loop

<!--
Agent notes — for AI agents driving the optional email loop from this page:

- Onboarding Step 1 is Connect your agent (`/onboarding/step-1`). Step 2 is Make
  something useful (`/onboarding/step-2`): one prompt that retrieves
  `search({ entity: "guide:onboarding" })`, looks at what is already in that
  agent (connections, skills, memories, instructions, repeating processes), and
  proposes a few to move into Kody. If there is little to move, it offers six
  first-win ideas instead.
  Step 3 is Connect a second agent
  (`/onboarding/step-3`) and reuses what Step 2 made via
  `search({ entity: "guide:portability" })`. Hosted OAuth is not the
  onboarding path. The optional climax after that is /docs/quick-example
  (ad hoc execute → persist → own). Use this guide only when the person wants
  the email-and-memories loop.
- You drive the whole loop. The person stays in this chat; they should not need
  to go back to the Kody web page except to finish Step 2 at
  `/onboarding/step-2` if they have not made something useful yet, or Step 3 at
  `/onboarding/step-3` to connect a second agent.
- Work one step at a time and confirm each step out loud before moving on. Keep
  messages short — under roughly 120 words.
- NEVER poll, sleep, retry on a timer, or "wait" for the reply to arrive. Tell
  the person to come back and say "replied", then look it up. Repeated lookup
  calls while they are away are the single worst failure mode here: they burn
  tokens, they look broken, and they add nothing that one lookup after "replied"
  does not.
- Every Kody path below (`/onboarding`, `/connect/oauth`, `/@<slug>/-/email`) is
  relative to the origin you fetched this guide from. Resolve them against that
  origin; never send someone to a different Kody deployment.
- Use the exact subject from step 1 whenever you refer to the email, so the
  person can search their inbox for it.
- Save memories only after the reply is in hand, and say what you saved.
- Do not create packages, jobs, or workflows during the first win. This is one
  short loop, not a build session.
-->

This guide is an optional playbook for exercising stored mail and durable
memory: the agent introduces itself over email, the person replies from their
normal email client, and the answers become memories that follow them into every
agent they connect later. For the default post-connect climax (run one ad hoc
request, then persist a package you own), use
[`quick-example`](./quick-example.md) instead.

Paths below are relative to the same deployment origin this guide was fetched
from; everything after this happens in their agent, not on the web page.

## Before you start

The account needs a verified email address and an authorized MCP host. If
`emailSend` reports that the account email is unverified, stop and tell the
person to finish verification first — the rest of this loop cannot work without
it.

## Step 1 — Send the welcome email

Call `emailSend` with `to` set to the verified identity email
(`{your-verified-email}`), even if a different destination is the default, with
a subject the person can find by searching their inbox:

```text
Welcome to Kody — reply to introduce yourself
```

Keep the body short and personal, and ask three questions in it: their name,
what they do for work, and what they do for fun. Close by inviting a reply to
that same message.

`emailSend` only mails verified email destinations, and the from address is the
account's platform inbox (`{username}@<platform domain>`). Extra destinations
expand that `to` set and do not change the From address. Note both the subject
you used and the from address the response reports — the next step needs them.

Then tell the person what you sent, quoting the subject verbatim.

## Step 2 — Point them at their own inbox

The reply comes from the person's **personal** email client, not from Kody. Tell
them, in one short message:

- Open the inbox for the email address on their Kody account.
- Look for the subject **Welcome to Kody — reply to introduce yourself** (quote
  it exactly, and name the from address you saw in step 1).
- Check spam or promotions if it is not in the inbox — first mail from a new
  domain lands there sometimes.
- Reply with their name, work, and something they do for fun. Thirty seconds is
  plenty.

## Step 3 — Wait for them, not for the mail

**Do not poll.** Do not loop on `emailMessageSearch`, do not schedule a job to
watch for the reply, and do not tell the person to hold on while you check.
Nothing in Kody answers by itself, so there is nothing to watch.

Instead, end your message with an explicit hand-off: ask them to come back to
this chat and say **"replied"** when they have sent it. Then stop and let them
go.

## Step 4 — Look the reply up

When they say they replied, find it once:

- `emailMessageSearch` with a query from the subject (or `emailMessageList`
  filtered to inbound mail), then
- `emailMessageGet` for the full body of the match.

If nothing is stored yet, say so plainly and ask them to say "replied" again in
a moment rather than checking on a timer yourself. Mail is stored on delivery,
so a fresh reply can take a beat to land.

## Step 5 — Save what matters as memories

Turn the reply into durable memories — not values, not a package. Memories are
the right home for "who this person is" facts, and they surface to every agent
connected to the same account.

Call `metaMemoryVerify` first to see what already exists, then
`metaMemoryUpsert` for each fact worth keeping: their name, their work, what
they do for fun, and anything else the reply volunteered (timezone, tools they
live in, what they want automated).

Then confirm out loud, in one short list, exactly what you saved. This is the
moment the whole loop pays off, so make it visible rather than silent.

## Step 6 — Offer the next step

The email loop is done. Offer one concrete next step and let them choose:

- **Make something useful.** If they have not finished onboarding Step 2, send
  them to `/onboarding/step-2` on the same origin this guide came from, or open
  `search({ entity: "guide:onboarding" })`. After a first win, Step 3 is
  `/onboarding/step-3` so a second agent can reuse that same thing
  (`search({ entity: "guide:portability" })`), or
  `search({ entity: "guide:quick_example" })` for one ad hoc execute then
  persist.
- **Ask what they want automated** and open
  `search({ entity: "guide:package_lifecycle" })` to pick between a one-off
  `execute`, a community fork, and a new package.
- **Bring their own OAuth app** to connect a service — open
  `search({ entity: "guide:oauth" })`, or a resolved
  `search({ entity: "guide:provider_<slug>" })`.
- **Bring their own API key or PAT** to connect a service — open
  `search({ entity: "guide:connect_secret" })`, or a resolved
  `search({ entity: "guide:provider_<slug>" })`.

## Troubleshooting

**The email never arrived.** Have them check spam and promotions first, and
confirm the address on their Kody account is the inbox they are looking at. Kody
also keeps its own copy: `/@<slug>/-/email` shows the stored outbound message,
so the subject is recoverable even when the personal copy is lost. Sending again
is fine — say that you are resending so a duplicate is not a surprise.

**Their reply is not in Kody.** Confirm they replied to the welcome message
rather than composing a new mail to a different address, and confirm the from
address matches the account inbox. A reply from an address that is not on the
account is not stored as theirs.

**Kody's tools are not available in the host.** Claude Desktop (and some other
hosts) bind MCP tools when a conversation starts, so a host that authorized
mid-conversation often needs a **brand new chat** before the Kody tools appear.
Have them start a fresh chat and paste the prompt again. If tools still do not
appear, the authorization did not finish — send them back to `/onboarding` to
reconnect.

**Nothing seems to happen on its own.** That is by design. Kody stores mail,
memories, credentials, and code; it does not run its own chat-model agent loop.
Search indexing uses a small embedding model. Every step in this loop happens
because an agent asked for it.

## Try it

Paste this into the agent connected to your Kody account, swapping in your
deployment's origin if it is not kody.codes:

> Ask the connected Kody server to read https://kody.codes/docs/first-win and
> then walk me through the optional email-and-memories loop, one step at a time.
