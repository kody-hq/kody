# Planned breaking changes

Leftover fields and params that still work, and that a later change will remove.
This is not a changelog and not a soak runbook. Architecture docs and code
describe current behavior; this list is the tracker so agents do not treat these
leftovers as identity.

When an item is safe to drop, follow
[cleanup after migrations](./cleanup-after-migrations.md): remove it in the same
change, or open a `Cleanup:` issue if a gate remains.

## `kody_id` / `kody.id`

Package identity is `package.json` `name` (`@scope/leaf`) **or** the
saved-package UUID `package_id` — one or the other, never both required. Prefer
the scoped name when you know it. Use `package_id` only when the name is not
known, or for a stable ref. The leaf after `/` is the URL slug.

`kody_id` (MCP / DB / URLs) and authored `package.json#kody.id` still work.
Create and resolve accept a leaf or a matching `@scope/leaf`. They are leftover
identity names. A future breaking change will remove the authored field, the
public MCP param, and (separately) rename the `saved_packages.kody_id` column.

Prefer the scoped `name` in docs, capability blurbs, and new callers. Mention
`package_id` only as the fallback. Do not teach `kody_id` / `kody.id` as
first-class identity.

Server lookups go through `resolveSavedPackageRef` (leaf, `@scope/leaf`, or
UUID; slug = leaf of `saved_packages.name`). The `saved_packages.kody_id` and
`community_listings.kody_id` columns are still written but are not lookup keys;
`insertSavedPackage` / `updateSavedPackage` derive `saved_packages.kody_id` from
the name leaf. Rename redirects write only `package_slug_redirects`; the legacy
`package_kody_id_redirects` table is still read as a fallback and cleared on
release/delete. Dropping the columns and the legacy table is
[#3676](https://github.com/kody-hq/kody/issues/3676) (reopened #1909 phase 4).

**Ready when:** agent transcripts and create/resolve traffic no longer need the
leftover param (Sentry KODY-7M and similar scoped-name-as-`kody_id` collisions
stay quiet), and a dedicated removal PR can drop the field without a fleet
codemod.

**Introduced as leftover by:** the change that documents identity as scoped
`name` or `package_id` while leaving the leftover param in the runtime contract.
