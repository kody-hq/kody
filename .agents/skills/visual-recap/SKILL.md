---
name: visual-recap
description:
  Generate and maintain the system recap block in a PR description - a
  GitHub-rendered visual summary of which system primitives a change touches,
  how risky it is, and what changed. Prefer mermaid sequence diagrams for the
  change; pick another graph type when it explains the diff better. Use when
  planning a non-trivial change (plan mode), when creating or updating a pull
  request (recap mode), or when the user asks for a visual recap, visual plan,
  system review, or PR recap.
---

# System recap

When a change is non-trivial (a plan, a PR create or update, or a request for a
visual recap), put one marker-delimited block in the PR description. GitHub
renders it. It does not replace reading the diff.

## When

**Recap mode reads the diff, not memory.** Claims about what changed must be
checkable against `git diff <base>...HEAD` (plus `--stat`). Session context may
explain intent only.

Run the classifier. Roll up to the highest of `adds`, then `extends`, then
`composes`. You still choose `composes` vs `extends` from the diff. `adds` is a
new map entry.

| Rollup     | Risk   | Also                                                                                                                                        |
| ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `composes` | low    | Wiring and call sites only.                                                                                                                 |
| `extends`  | medium | Local [control-kody](../control-kody/SKILL.md) verify as the seeded user; [preview](../preview-manual-test/SKILL.md) only when local cannot |
| `adds`     | high   | Update `primitives.yaml`, `npm run primitives:check`, and the same local verify (preview when needed)                                       |

Update `primitives.yaml` when this PR adds, removes, or materially reshapes a
primitive (new `id`, renamed meaning, or ownership roots that must change). Do
not edit `summary` for ordinary feature work. Call out a touched invariant from
that map at every risk.

Plan mode uses `**Mode:** plan` before a PR exists. Recap mode replaces that
block from `git diff <base>...HEAD`. In plan mode, say explicitly when the plan
requires **no** change to any primitive — that is the lowest-risk outcome.

The block shape is one example:
[references/block-format.md](./references/block-format.md).

## Command

```bash
node .agents/skills/visual-recap/scripts/classify-primitives.mjs --base <base> --head HEAD --json
node .agents/skills/visual-recap/scripts/upsert-recap-block.mjs <pr-number> <block-file>
```

The upsert script checks mermaid, then replaces the marker block or appends it.
It does not edit text outside the markers. Re-run both commands after a
significant push.

## Failure

- The mermaid check exits non-zero. Fix the diagram. Do not put `;` in sequence
  notes or messages. `npm run docs:check` (mermaid member) uses the same parser.
- The block file must start with `<!-- system-recap:start -->` and end with
  `<!-- system-recap:end -->`.
- `gh pr edit` fails with
  `Resource not accessible by integration (updatePullRequest)`. The script still
  prints the merged body. Apply that body with Cursor ManagePullRequest. Do not
  have Kody edit the PR.
- A health check or login smoke is not medium or high verification. Prefer local
  control-kody proof; use preview only when local cannot exercise the change. Do
  not cat the session cookie into curl or Python.
