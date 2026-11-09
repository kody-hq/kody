---
title: Self-service means ownership
date: 2026-07-20
description:
  Why Kody makes you create your own OAuth apps and bring your own keys, framed
  honestly. A few minutes of setup buy you your own app, your scopes, your rate
  limits, and no middleman between you and your data.
order: 7
category: essays
---

When you connect Google or GitHub to Kody, there's no one-click "Sign in with
Google" button that just works. Instead, you go to the provider, create your own
OAuth app, register the redirect URI, and then connect it at
[kody.codes/connect/oauth](https://kody.codes/connect/oauth). The product's own
copy is upfront about the cost: "Bring-your-own takes a few minutes of setup;
your agent does the tedious parts."

I want to explain why it works that way, because it looks like a missing feature
and it's actually a design decision. One I'd make again.

**When you bring your own OAuth app, there is no middleman between you and your
data, and that's worth a few minutes of setup.**

## What one-click actually costs

Every choice trades something off, so let's be clear about what the one-click
version trades. When a hosted assistant offers one-click Google integration,
that click works because the vendor registered an OAuth app with Google. Their
client id, their scopes, their rate limits, their approval status. When you
click Connect, you're granting _their app_ access to your account, and the
assistant reaches your data through it.

That's convenient, and to be fair, most vendors handle it responsibly. But
structurally, their app now sits between you and your data:

- **Their scopes decide what you can do.** If they didn't request calendar write
  access, you don't have calendar write access, and no amount of asking your
  assistant nicely changes that.
- **Their rate limits are shared.** You're drawing from a pool alongside every
  other customer.
- **Their approval status is your uptime.** If the provider suspends their app,
  or the vendor shuts down, or the vendor decides your use case is out of scope,
  your integration is gone. You didn't lose your Google account; you lost your
  only door into it.
- **Their provider list is the menu.** If they haven't built the integration, it
  doesn't exist for you.

None of this is malice. It's just what it means for someone else to own the app.

## What self-service buys you

Flip every one of those. Create the OAuth app yourself and:

- **It's your app.** Your client id, registered under your account at the
  provider. Nobody can revoke it but you and the provider.
- **Your scopes.** Request exactly the access your automations need, no more
  because a product manager somewhere anticipated a use case, no less because
  they didn't.
- **Your rate limits.** Whatever quota the provider grants an app is yours
  alone.
- **Revocable by you, at the provider.** When you're done, you revoke it at the
  source. You don't file a support ticket and hope.
- **No fixed provider list.** This is the one people miss. Because there's no
  vendor building integrations one at a time, there's no menu. Anything with
  OAuth works. Your bank's obscure API, some regional service no vendor would
  prioritize, the internal tool at your company: if it speaks OAuth, you can
  connect it. The [OAuth guide](https://kody.codes/docs/oauth) walks through the
  setup.

The same principle covers plain API keys and personal access tokens. Those go
into the server-side secret store via
[a prefilled secrets page](https://kody.codes/connect/secret-set), never pasted
into chat. They're encrypted, referenced in code as `{{secret:name}}`
placeholders, and resolved only for hosts you've approved, so the plaintext
never enters a prompt. The
[secrets docs](https://github.com/kody-hq/kody/blob/main/docs/use/secrets-and-values.md)
have the details. Bring your own keys, keep your own keys.

## The honest cost

I'm not going to pretend the trade is free. One-click is genuinely nicer in the
moment. Clicking a button beats navigating a provider's developer console, and
some providers make app creation actively annoying: verification steps, review
queues, dashboards that seem designed to be forgotten. The first time you
register a redirect URI, you'll wonder why you're doing a vendor's job.

Here's the reframe that made it click for me: you're not doing a vendor's job.
You're doing the owner's job, because you're the owner. It's the difference
between renting and holding the title. Renting is less paperwork, right up until
the landlord makes a decision you don't like. Imperfect analogy, I know, but it
captures the part that matters: the paperwork is small and one-time, and what it
buys is standing.

And the few minutes really are a few minutes, once per provider. I've done it 11
times; that's how many OAuth integrations are live in my account right now, next
to 51 secrets, and every one of them is an app or key I control end to end. Each
setup was mildly tedious. None of them has ever been taken away from me,
throttled by a stranger's traffic, or limited to scopes someone else chose.

## Own the door

If you'd rather own your assistant's access than rent it, the path is short:
pick one provider you actually use, follow the
[OAuth guide](https://kody.codes/docs/oauth) to create your app, and connect it.
After the first one, the second takes half the time.

If you don't have an account yet,
[create one at kody.codes/signup](https://kody.codes/signup). The whole thing is
[Fair Source](https://github.com/kody-hq/kody) if you want to verify any of this
yourself, which, given the subject of this post, seems fitting.

A few minutes of setup, and the door into your own data has your name on it.
That's the feature.
