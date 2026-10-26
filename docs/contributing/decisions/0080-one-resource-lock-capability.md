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
`orgPermission: 'none'`. The canonical REST path is `POST /v1/resource-locks`.
The four old `/v1` lock routes remain deprecated forwarders to `resourceLock`
with `Deprecation` and `Sunset` headers until 2027-01-22, tracked in
[#4322](https://github.com/kody-hq/kody/issues/4322). The former MCP names have
no aliases; `resourceLock` is the only MCP capability. Revisit if a kind needs a
materially different lifecycle, such as agent-side unlock.
