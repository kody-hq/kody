# Keep agent context lean

Agents load guidance on demand. Keep the entry map tiny; put detail one hop away
in focused docs, and do not restate the same policy across files.

## Rules

- Root `AGENTS.md` is a small index (map), not an encyclopedia. The `agents-md`
  file-size ratchet (`npm run slop-ratchet:check`) enforces the line budget;
  raise `maxLines` only on purpose.
- Detail lives in focused pages under `docs/` (principles, contributing, guides)
  or in task skills under `.agents/skills/`.
- Progressive disclosure: agents open the index, then only the page the task
  needs. Do not paste the same rule into `AGENTS.md`, a skill, and a
  contributing doc.
- When behavior changes, update the closest source-of-truth page in the same
  change. Leave a short pointer behind if you move guidance.

## Related

- [Examples over prose](./examples-over-prose.md): one example, or a script
- [Harness engineering](../contributing/harness-engineering.md): promote
  repeated advice into checkers
- [Documentation principles](../contributing/documentation.md): how we write and
  garden docs
- [Repo health](../contributing/repo-health.md): CI budgets including
  `agents-md`
