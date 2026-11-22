# Documentation

This repository maintains two audiences:

- **[`docs/guides/`](../guides/README.md)** — Served catalog at
  [kody.codes/docs](https://kody.codes/docs). Agents load a page with
  `search({ entity: "guide:{id}" })` or
  `curl -fsS https://kody.codes/docs/<slug>.md`.
- **[`docs/use/`](../use/README.md)** — MCP field reference linked from those
  guides. A page that only repeats a guide is a stub pointing at the catalog.
- **`docs/contributing/`** — People who develop Kody (code, kody, infra).

## Principles

**Describe how things work.** Write in the present tense. Avoid changelog-style
phrases (“now we…”, “we no longer…”, “previously…”) in both usage and
contributing docs; those belong in commit messages or
[release notes](./release-notes.md) (PR bodies and Discord ship summaries, with
an optional **May break packages** heading). Describe the system as it works
today (“Kody stores…”, “The manifest rejects…”) instead of narrating a rollout
(“Kody now stores…”, “We no longer accept…”).

Run `npm run docs:check` before pushing a docs change. It runs the docs checkers
(temporal language, decision-record numbers, markdown file refs, hosted-execute
guidance, agent text, and mermaid syntax) and names each failing member. Lint
covers docs too: `kody-custom/no-oversized-guide-section` keeps official guide
sections inside the search response budget. `npm run validate` runs all of
these; [Repo health](./repo-health.md) and
[Oxlint JS plugins](./oxlint-js-plugins.md) describe the other checkers and
budgets.

Docs-like product copy follows the same rule: MCP server instructions, tool and
schema descriptions, and user-visible UI strings should not read like release
notes.

**Exceptions.** Migration and rotation guides (for example
[`secret-rotation.md`](./secret-rotation.md)) may use ordered steps across
deploy phases, [decision records](./decisions/index.md) are a point-in-time
steering veto list by design, and dated reviews under
[`docs/audits/`](../audits/) are point-in-time snapshots. Outside those
procedures, still describe the current design in plain language. Quoted
validation errors and runtime messages should match what the product returns,
even when the wording contrasts with older manifest shapes.

**Stay lightweight but valuable.** Prefer small, accurate pages over large stale
ones. **Garden** docs when behavior changes: update or delete sections in the
same change as the code when possible. Remove duplication between pages by
linking out instead of copying paragraphs. When a contributing guide grows past
a single topic, turn it into a directory with a short `index.md` and one file
per topic so agents load only what they need (see [`setup/`](./setup/index.md)).

**Write guidance in the positive direction.** Agent and contributing guidance
states what to do, in a few short lines, rather than a long list of things to
avoid. Keep entry pages short and link to detail (progressive disclosure) so a
reader loads only what the task needs.

**Prefer a checker over a should-list.** Constraints that lint, TypeScript, or
`npm run validate` can reject belong in those tools. Contributing docs describe
how the system works and point at the check. They do not ask agents or humans to
remember a rule the repo can enforce. When a pattern needs control-flow or
interprocedural reasoning a cheap checker cannot do, describe the failure mode
and stop — do not add a noisy half-rule. See
[harness engineering](./harness-engineering.md) (promote into enforcement) and
[oxlint JS plugins](./oxlint-js-plugins.md).

**Security claims cite their proof.** A sentence that promises a security
property (an agent "cannot" do something, a lock "keeps" something from
happening, only the owner can approve) links the test or code that enforces it,
for example the
[`resourceLock` contract test](../../packages/worker/src/mcp/capabilities/secrets/resource-lock.node.test.ts).
Keep the claim exactly as strong as that test. When a change touches a guide
with such a claim, check the claim against the code in the same change; the
daily docs-freshness pass checks changed security claims the same way.

**MCP instructions and tool descriptions stay tight.** Server-level instructions
and per-tool descriptions should give the model what it needs **before**
choosing or invoking a tool: workflows, constraints, and **copy-pasteable
examples**. Long policy lists and exhaustive field semantics belong in **usage
docs** or in **tool responses** (structured content, error text, and follow-up
messages), not in the instruction string.

**Put post-call detail in the call result.** Anything the model only needs
**after** a tool runs (full schemas on demand, ranked hit lists, approval URLs,
error bodies) should surface from the **tool response**, not from static
instructions. Static text should not repeat large chunks of what the user or
model will see in the next response.

**Avoid overlap with generated surfaces.** If the MCP host already shows tool
schemas or resource listings, documentation and instructions should not restate
the same tables verbatim; link to usage docs or rely on the tool output.

## Related

- [Harness engineering](./harness-engineering.md) — promote repeated advice into
  lint, tests, or commands before adding a should-list
- [Oxlint JS plugins](./oxlint-js-plugins.md) — where cheap syntactic rules live
- [Usage index](../use/index.md) — end-user table of contents
