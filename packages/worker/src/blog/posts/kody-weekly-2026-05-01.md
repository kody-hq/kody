---
title: Kody weekly: Your agent can send and receive email
date: 2026-05-01
description: Kody inboxes store inbound mail and send replies, and packages can react to new mail, plus 8 more updates to packages and secrets.
order: 1
category: updates
placeholder: false
---

Here is what shipped in Kody from April 25 to May 1, 2026. This week Kody gets
email, and packages grow into long-running workloads with services, secrets,
subscriptions, and search retrievers.

## Your agent can send and receive email

### What shipped

The new MCP `email` domain gives your agent inboxes. `email_inbox_create` makes
an inbox with a routable alias, and mail sent to it is parsed and stored.
`email_message_list`, `email_message_get`, and `email_attachment_get` read
stored messages, headers, threads, and attachments. `email_send` sends from a
verified sender identity (set one up with `email_sender_identity_verify`), and
`email_reply` replies to a stored message. Mail to unknown aliases is rejected,
and display names are not trusted: the envelope sender, parsed `From`, and
authentication headers are stored separately.

Packages can subscribe to `email.message.received`. A handler gets the message
id and receipt metadata, loads the body with `email_message_get` or
`import { email } from 'kody:runtime'`, and can call normal capabilities such as
`agent_chat_turn` and `email_reply`.

### Why it matters

Email is where many requests and notifications already arrive. With a Kody inbox
your agent can receive a message, decide what to do with it, and reply, all from
code you own in a package, instead of you forwarding mail into a chat by hand.

### Example

Ask your agent, through `execute`:

1. Call `email_inbox_create` to make an inbox and note its alias.
2. Send a test message to that alias from your own mail client.
3. Call `email_message_list`, then `email_message_get` with the new message id
   to read the parsed body.

PRs: [#284](https://github.com/kody-hq/kody/pull/284),
[#295](https://github.com/kody-hq/kody/pull/295),
[#290](https://github.com/kody-hq/kody/pull/290),
[#301](https://github.com/kody-hq/kody/pull/301)

## More updates

- **Packages:** Adds package services. Declare `kody.services` in `package.json`
  for long-running, gateway-style workloads with MCP controls, status,
  auto-start, and a persistent mode.
  ([#264](https://github.com/kody-hq/kody/pull/264),
  [#267](https://github.com/kody-hq/kody/pull/267))
- **Automations:** Adds declarative package subscriptions, so a package can
  react to events such as new email.
  ([docs](https://kody.codes/docs/package-subscriptions),
  [#267](https://github.com/kody-hq/kody/pull/267))
- **Credentials:** Lets you approve a secret for specific packages, from the
  account secrets page or with `allowedPackages` on `/connect/secret`, and
  packages declare the secrets they need with `secretMounts`.
  ([docs](https://kody.codes/docs/secrets),
  [#267](https://github.com/kody-hq/kody/pull/267),
  [#311](https://github.com/kody-hq/kody/pull/311))
- **Packages:** Adds an external invocation API. Trusted callers can run a
  package export with `POST /api/package-invocations/:package/:export` using a
  token limited to a user, package, export, and source.
  ([#275](https://github.com/kody-hq/kody/pull/275))
- **Packages:** Adds `kody.retrievers`, so a package can contribute results to
  `search` and automatic context. Retriever failures turn into warnings instead
  of failing search. ([#280](https://github.com/kody-hq/kody/pull/280))
- **Packages:** Supports named re-exports with export metadata from JSDoc and
  signatures, and npm dependencies declared in `package.json` that resolve at
  bundle time. ([#304](https://github.com/kody-hq/kody/pull/304),
  [#306](https://github.com/kody-hq/kody/pull/306))
- **Credentials:** Adds `jwt_sign`, which signs a JWT you provide with a private
  key from a saved secret (RS256, with optional JSON field extraction for
  service account files). ([#283](https://github.com/kody-hq/kody/pull/283))
- **MCP:** Shows capability inputs and outputs in search as generated TypeScript
  types, including schema descriptions as JSDoc.
  ([#279](https://github.com/kody-hq/kody/pull/279),
  [#303](https://github.com/kody-hq/kody/pull/303))

## Fixes

- **MCP:** Fixes capability search dropping literal name matches.
  ([#272](https://github.com/kody-hq/kody/pull/272))
- **Credentials:** Fixes secret host approval links so validation errors show on
  the account secrets page and approving keeps you on the selected secret.
  ([#276](https://github.com/kody-hq/kody/pull/276),
  [#278](https://github.com/kody-hq/kody/pull/278))
- **Credentials:** Tightens how OAuth connector credentials are attached to
  requests. ([#313](https://github.com/kody-hq/kody/pull/313))
- **Email:** Fixes outbound reply and thread headers, and empty HTML bodies no
  longer get filled with the subject.
  ([#287](https://github.com/kody-hq/kody/pull/287))
- **Platform:** Fixes home connector websocket reconnects and gives clearer,
  retried errors for Bond and Lutron devices.
  ([#288](https://github.com/kody-hq/kody/pull/288),
  [#294](https://github.com/kody-hq/kody/pull/294),
  [#277](https://github.com/kody-hq/kody/pull/277),
  [#302](https://github.com/kody-hq/kody/pull/302),
  [#289](https://github.com/kody-hq/kody/pull/289))

## Try it

Create an inbox with `email_inbox_create`, send it a message, and ask your agent
to read it back with `email_message_get`.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
