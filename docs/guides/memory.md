---
id: memory
title: Shared memory
summary:
  What a Kody memory is (personal-only), why it follows the person instead of
  one host's chat or a team org, how memories surface automatically on search
  and execute, the verify-first rule for writes, and what does not belong in
  memory (package state, config, credentials, shared org knowledge). Load this
  when someone asks what their agents remember about them or how memory travels
  between agents.
category: platform
---

# Shared memory

A memory is a durable **personal** fact or preference attached to you — your
personal org — not to a team workspace. Say it once in one agent and every other
agent connected as you can use it, including when that connection is bound to a
team org. That is the whole point: memory follows the person, not the product
and not the org.

Your agents have their own memory too: Claude's memory, Codex notes, Cursor
rules, a personal agent's notes on your machine. Those are good at what that one
host needs, and you can keep using them. They are also invisible to every other
agent you connect. Put the facts you want every agent to know in Kody memory;
Kody is the system of record for the state that should follow you.

Watch:
[How Kody Gives Your Agents a Shared Home](https://www.youtube.com/watch?v=h5G8uaZHrVI).
The written loop is [How Kody works](./how-kody-works.md).

## What a memory is for

Use memory sparingly, for facts that need to travel between agents and don’t
have a better home. Put repeatable behavior in package code, with typed inputs
and documented defaults. A reply utility can quote the thread automatically; a
release-summary package can put breaking changes first and include source links.
Neither needs a separate memory for the agent to remember each time.

Useful memory examples include:

- who you are (`profile`)
- names, ids, and handles you keep re-typing (`identifier`)
- people and relationships that give tasks context (`relationship`)
- project nicknames or background facts not recorded elsewhere (`project`)

Categories are freeform strings; those are suggestions, not a closed list.

## What a memory is not for

Kody has a home for each kind of state, and memory is only one of them:

| State                                 | Home                                     |
| ------------------------------------- | ---------------------------------------- |
| A durable **personal** fact           | **Memory** (your personal org)           |
| Shared org / team knowledge           | Documented packages and org instructions |
| Repeatable behavior and task defaults | Package code and documentation           |
| A credential                          | [Secrets](./secrets.md)                  |
| A cursor, checkpoint, or runtime knob | `packageStorage()` inside the package    |
| Versioned configuration               | The package repository                   |
| An OAuth login                        | An integration                           |

If the fact is about a package's job or about the org rather than about you, it
does not belong in memory. Agents must **ask before copying** a personal memory
into an org package. Choosing among MCP server instructions, package docs,
export JSDoc, and memory is covered in
[Where agent guidance lives](./agent-guidance.md).

## How memories surface

Your agent does not have to ask for memories. When it calls `search`, Kody
retrieves the one or two most relevant active **personal** memories for the
query (an unrelated query gets none) and adds them to the response as a compact
`## Relevant memories (personal)` block, labeled `[personal]`: subject, summary,
and id. `execute` does the same when the agent passes a short `memoryContext`
(the task, the query, key entities and constraints). Agents should ask you
before copying any of those into an org package.

That auto-surface is deliberately small and repeatable. The same one-liner may
show up again later so the rule stays in context after a long conversation is
compacted. Details stay behind `metaMemoryGet`; two copies of the same fact
sharing a `dedupe_key` collapse into one so neither spends both slots.

A different conversation, or a completely separate agent for the same account,
sees the same block. That is portability in one screen.

## Writing memory: verify first

Memory writes are explicit. Before creating, updating, or deleting a memory the
agent should:

1. call `metaMemoryVerify` to see what already exists on the topic
2. review the related memories it returns
3. decide to upsert, delete, do both, or do nothing

Kody retrieves the related memories; the agent decides what they mean. Agents
should say what they saved — the value of memory is that you can see it move.

## Capabilities

All through `execute`:

- `metaMemoryVerify` — required first step before any write
- `metaMemoryUpsert` — create (no `memory_id`) or update (with `memory_id`)
- `metaMemoryDelete` — soft-delete by default; `force: true` deletes for good
- `metaMemoryGet` — load one memory by id
- `metaMemorySearch` — browse or search stored memories directly

Memories can carry optional `source_uris` — canonical document URLs such as a
GitHub file, an R2 object, or a Notion page — so a later agent can go to the
source.

## Your copy

You can download your **personal** memories as JSON from your personal org's
`/@<slug>/-/memories` page. Team workspaces do not list memories (memory is
personal-only). The export file is memories only: no credentials or other
account primitives. Deleted memories are included only when you turn on
**Include deleted**.

## Where to go next

- [Where agent guidance lives](./agent-guidance.md) — choose among MCP
  instructions, package docs, JSDoc, and memory before writing guidance.
- [Connect your agent](./connect-your-agent.md) — Step 3 is a second agent
  reusing a memory the first one saved.
- [Email and memories](./first-win.md) — an optional playbook that turns a
  welcome-email reply into memories.
- [Memory and conversation context](../use/memory.md) — the MCP-level reference:
  `conversationId`, `memoryContext`, and retrieval behavior.
