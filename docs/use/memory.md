# Memory and conversation context

What a memory is, what does not belong in one, and the verify-first write
workflow live in [Shared memory](../guides/memory.md). This page is the
MCP-level reference: `conversationId`, `memoryContext`, and retrieval behavior.

Kody supports two related memory features:

- **compact auto-surface** on `search` and on `execute` when `memoryContext` is
  present
- **long-term memory retrieval and persistence** via **`memoryContext`** and
  memory capabilities

## `conversationId`

**`conversationId`** ties related tool calls together for progressive disclosure
and other per-thread optimizations. If you already have one from an earlier tool
response, pass it back unchanged. Otherwise omit the field so Kody can return a
server-generated id. Do not make one up yourself.

Memory auto-surface does not require this id and does not hide a memory after
showing it. The compact one-liner can repeat on later retrievals so it stays in
context if earlier tool results were dropped. A different conversation, or a
completely separate agent for the same user, sees the same compact block.

## `memoryContext`

**`memoryContext`** is a short, task-focused hint the agent sends with normal
tool calls. Kody uses it to retrieve a small number of relevant long-term
memories for the current task.

Keep it brief and factual. Good fields include:

- current task
- current query
- important entities
- important constraints

`search` also retrieves from the query string when `memoryContext` is omitted,
including domain-scoped search. `execute` retrieves when `memoryContext` is
present.

## Automatic memory surfacing

When retrieval runs, Kody may return the top one or two relevant active
**personal** memories, including ones surfaced earlier, in the tool text (as
`## Relevant memories (personal)`, each line tagged `[personal]`) and in
structured content (`scope: "personal"`). Auto-surface is compact: **subject**,
**summary**, and **id** (structured). Details stay behind `metaMemoryGet`. Later
ranked hits that share a non-empty `dedupe_key` are collapsed so two copies of
the same fact cannot spend both slots; blank or missing keys surface
independently. Ask before copying a personal memory into an org package.

### Search relevance floor

Memory ranking fuses lexical and vector ranks, and those scores say nothing
about absolute relevance: without a floor the best two memories surface for
every query. `search` therefore drops a memory whose query cosine similarity
(`bge-small-en-v1.5`, CLS pooling) is below `searchMemorySurfaceMinVectorScore`
(0.64), and a memory missing from the vector results. Ranking order and the
two-memory cap are unchanged. Local dev and tests use a hash stand-in for
embeddings, so the floor is skipped there.

The floor came from `tools/evals/memory-surface-floor.json`: 16 synthetic
memories, 56 related queries, and 60 unrelated ones. At 0.64, 46 of 56 related
queries kept their target memory and 3 of 60 unrelated queries surfaced any
memory (40/56 and 0/60 with longer memory details). At 0.60 the leak was 10 of
60; at 0.65 related recall fell to 41 of 56. Retune with that fixture, not a
guess.

That retrieval is:

- **conservative** — the top one or two ranked active memories after
  `dedupe_key` collapse; on `search`, only memories whose embedding similarity
  to the query clears a relevance floor, so an unrelated query surfaces none
- **task-based** — driven by `memoryContext` and, for `search`, the query
- **cheap to repeat** — subject and summary only; the same one-liners may appear
  again so a compacted context keeps the rule

## Verify-first rule for memory writes

Before creating, updating, or deleting a memory, call **`metaMemoryVerify`**,
review the related memories it returns, then upsert, delete, do both, or do
nothing. Kody retrieves the related memories; the consuming agent decides what
they mean. See [Shared memory](../guides/memory.md#writing-memory-verify-first).

## Memory capabilities

Use these through **`execute`**:

- **`metaMemoryVerify`** — required first step before mutating **personal**
  memory (always the signed-in person's personal org)
- **`metaMemoryUpsert`** — create a new personal memory when `memory_id` is
  omitted, or update when `memory_id` is provided
- **`metaMemoryDelete`** — soft-delete by default; pass `force: true` for
  permanent deletion
- **`metaMemoryGet`** — load one personal memory by id
- **`metaMemorySearch`** — browse/search personal memories directly

Memory records can also include optional **`source_uris`** — opaque canonical
document URLs such as GitHub files, R2 object URLs, or Notion pages.

## Account download and categories

Download personal memories as JSON from your personal org's
`/@<slug>/-/memories`. Categories are freeform; suggested values and the
account-download details are in [Shared memory](../guides/memory.md).
