# 0080: One `resourceLock` capability; no per-resource lock capabilities

- **Status:** accepted
- **Date:** 2026-10-24

## Context

Four capabilities expressed the same narrow-a-credential-to-a-saved-package
concept. Their different resource identifiers and approval behavior did not need
separate capability names or surfaces.

## Decision

Use one `resourceLock` capability with a `kind` discriminated union. A new
lockable credential kind adds a variant rather than a new capability; unlock and
grant removal remain website-only.

## Consequences

The handler checks permission per kind while the surface declares
`orgPermission: 'none'`. REST lock paths collapse to `POST /v1/resource-locks`.
Revisit if a kind needs a materially different lifecycle, such as agent-side
unlock.
