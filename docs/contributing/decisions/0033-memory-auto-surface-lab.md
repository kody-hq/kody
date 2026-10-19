# 0033 lab: memory auto-surface (2026-08-22)

Point-in-time evidence for [0033](./0033-no-user-as-conversation.md). This is
not a second steering record. The lab script under
`tools/memory-auto-surface-lab/` was removed after the findings were recorded
here; recover it from git history at `51def919d` (last commit that contained
it).

## Method

Deterministic window simulation, not an LLM eval. For each policy × trace: was
“never send” / “draft only” in the host-visible tool text at the decision, and
what did that cost (`chars/4`). Isolation is a second agent with a fresh handle
after the first agent already surfaced the memory.

Phrase match proves transport, not that a model read or obeyed the line.

2026-08-22 run: **5149** policies (cartesian grid plus named theories) × the
original 15 traces plus 9 invented adversarial traces. **82** core-perfect
policies (isolation + every required scene). Execute-only send with no
`memoryContext` stays stretch.

## Falsified

| Policy                                    | Isolation       | Compaction           | Notes                                     |
| ----------------------------------------- | --------------- | -------------------- | ----------------------------------------- |
| Full payload + per-handle hide            | pass            | fail                 | First show falls out of a 3-result window |
| User-global hide                          | fail            | fail                 | Chat B never sees the rule                |
| Compact + hide on echoed `conversationId` | pass            | fail                 | Same compaction miss                      |
| Search-only compact                       | pass            | fail                 | Misses execute-only and compaction        |
| Subject-only                              | pass            | fail on weak subject | “Email habits” hides the rule             |
| `n=1`                                     | pass            | fail on rank-2       | Critical memory is second                 |
| Ids / structured-only / empty payload     | fail visibility | —                    | Markdown-only hosts see nothing           |
| Always-full, no hide                      | pass            | pass                 | About 2–4× the compact cost               |

## Surviving shape

Every core-perfect policy shared:

- `search` retrieves from the query
- `execute` retrieves only with `memoryContext`
- the line includes the **summary** (keywords, 80-char summary, or subject +
  summary)
- **no hide** after the first show
- **n=2** so a rank-2 critical memory still appears

Cheapest core-perfect: keyword soup, no hide, n=2. Readable core-perfect:
subject + summary, no hide, n=2 — about half of a full-record payload. `n=3` and
`executeWhen=always` also survive and buy stretch scenes at roughly 2× tokens.

Composite score still crowns cheaper `n=1` / keyword rows that miss rank-2. That
is a rubric artifact. Do not treat min-tokens-at-reliability=1 as the product
pick.

## Product pick (0033)

Compact **subject — summary** one-liners (id in structured content), top two
active memories, retrieve on search query and on execute `memoryContext`, **no
auto-surface hide**. Repeat is the compaction tax. Auto-surface collapses later
ranked hits that share a non-empty `dedupe_key` so two copies of the same fact
cannot spend both slots.

## Live probe (2026-08-22)

Production `search` / `execute` as Kent: 48 ranked task queries and 54 live
probes across email, Discord, social, Cursor/GitHub, packages, home, journal,
content, OAuth, and account/meta/secrets, plus empty browse, entity detail,
whitespace / `memoryContext`-only, tight `maxResponseSize`, and execute with and
without `memoryContext`.

n=2 still holds. n=1 loses dual-constraint tasks (draft+support, BWK
kit+defaults, repo bounds+ManagePullRequest). n=3 buys a few rank-3 edges and
does not fix misses that never enter the top ranks. Contract checks held: empty
browse and entity detail do not dump memories; execute surfaces only with
`memoryContext`; reserved memory budget survives a tight size cap. Misses were
ranking and a duplicate `dedupe_key` pair, not width. Do not widen auto-surface
from this probe.

## Revisit

Calendar check: 2027-02-22
([#1648](https://github.com/kentcdodds/kody/issues/1648)). Keep 0033 unless one
of these is true:

1. MCP or a major host puts a spec-defined conversation or thread id on every
   request.
2. Auto-surface tokens are large relative to the rest of a typical
   search/execute result.
3. Re-running the lab (or a live MCP probe) shows hide/`n=1`/subject-only no
   longer fail the core traces.

Do not promote execute-always to core unless execute-only send without
`memoryContext` becomes the common host path.
