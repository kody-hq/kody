# 0033: No user-as-conversation, MCP session, or user-global memory hide

- **Status:** accepted
- **Date:** 2026-08-22

## Context

MCP revision `2026-07-28` is a stateless protocol: every request carries its own
`_meta`, servers **MUST NOT** infer context from prior requests on the same
connection, and servers **SHOULD** handle requests for multiple tasks, threads,
or conversations. An open connection or stdio process is not a conversation.
State that spans requests **MUST** be an explicit identifier the client passes
([Statelessness](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#statelessness);
[0005](./0005-mcp-dual-lane-stateless-migration.md)).

Kody users talk to the same account from concurrent chats and from completely
separate agents. A memory shown in chat A must still be visible in chat B.

## Decision

Do not treat the signed-in user, an MCP transport session, or an open connection
as "the conversation." Do not add a user-global "already shown" window for
auto-surfaced memories.

Surface relevant memories on the tool result that retrieved them. Do not hide
auto-surface after the first show: a per-handle omit fails when the host drops
earlier tool results. `conversationId` is a progressive-disclosure handle, not a
hide key.

Do not require a protocol conversation id in `_meta`. If a host later puts a
stable thread or run id there, use that handle; do not invent a session
stand-in.

## Consequences

Concurrent agents for one user stay isolated. Repeating a cheap one-liner costs
less than hiding a rule that later falls out of context.

Evidence from the 2026-08-22 policy grid lives in
[0033-memory-auto-surface-lab.md](./0033-memory-auto-surface-lab.md). The lab
script was removed; recover `tools/memory-auto-surface-lab/` from git history
at `51def919d` (last commit that contained it). Revisit on the calendar check
([#1648](https://github.com/kentcdodds/kody/issues/1648), 2027-02-22) or sooner
if a major host ships a spec-defined conversation or thread identifier that
every request already carries, or if auto-surface token cost becomes large
relative to the rest of the tool result.
