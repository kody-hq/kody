# Storage isolation

[Data storage overview](./index.md)

## Per-user isolation invariant

Kody is multi-user with strict per-user isolation. Every user-owned storage
layer described below is scoped by `user_id` (D1 columns, Vectorize metadata, KV
key prefixes, Durable Object names), and every owner read/write path takes a
`userId` argument. Two users with the same logical identifier (for example the
same MCP server name, the same package id, or the same storage id) land on
different durable objects and different rows. Any new persistence layer added to
the project must follow the same convention; user-scoped tests should exercise
both the "happy" path and a cross-user denial path.

The deliberate storage exception is **operator-owned system email** for reserved
platform local parts (`systemEmailLocals` in
`packages/worker/src/email/system-email.ts`: `kody`, `support`, `abuse`, `dmca`,
`postmaster`, `security`, `admin`, `psl`, `kent`, and `news`). The permanent D1
tables are `system_email_threads`, `system_email_messages`,
`system_email_attachments`, and `system_email_delivery_events`. They omit
`user_id` because the operator owner is implicit. They are the sole live
`system:email` graph authority. The reserved id is not a login account and must
not be conflated with the `kody@example.com` fixture or Kent's personal account.
Account deletion and export treat these tables as platform/operator content in
`accountOperatorOwnedD1Surfaces`, with guardrail tests.

Platform feedback remains user-owned and user-scoped in storage, but has a
narrow cross-user read and triage path. Only feedback the submitting user
explicitly approved enters that role-gated admin surface. The stored submitter
id makes feedback attributed rather than anonymous; the exception never grants
admins access to unrelated account data.

Community forks and ratings remain user-owned rows for deletion and export, with
a narrow role-gated admin metadata projection. It joins those rows only to
public listing identity and the actor's username. Fork rows snapshot the public
listing name and package name leaf so retained provenance remains intelligible
after a listing is deleted. The projection never reads the forked Artifacts
source, the public snapshot file tree, rating notes, or unrelated account data.
Actor usernames resolve through the unique `users.stable_user_id` index; email
and stable user ids remain absent from activity results and events. One-click
installs and ordinary forks share the same row shape and therefore appear as
`fork`.
