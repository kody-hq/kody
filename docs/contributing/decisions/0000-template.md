# NNNN: Short decision title (the no)

- **Status:** accepted <!-- accepted | superseded by [NNNN](./NNNN-slug.md) -->
- **Date:** YYYY-MM-DD

## Context

What proposal or situation forced the decision. A few sentences on the system
state and constraints, with links to code or docs. Write this **after** the
decision is made — not as a design brief for a PR.

## Decision

What was decided, in one or two sentences. The usual record is a product-shaped
**no** (we will not build X). Name the existing primitive that covers the need.
Add this record's path to that primitive's `adrs` in
[primitives.yaml](../architecture/primitives.yaml).

## Consequences

What stays simple, what gets harder, and the **revisit-if** — the concrete
condition that would reopen this. Half a page is enough.

Do not use this template for a layout or UI tweak, a library pick the code
already encodes, or because a PR shipped.
