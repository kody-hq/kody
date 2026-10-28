# Search entity plugins

Search list results are built from ordered entity plugins under
`packages/worker/src/mcp/tools/search-entity-plugins/`.

The plugin registry is the discovery/candidate/format seam, but a new entity
type is **not** only a plugin registration yet. Closed TypeScript unions,
Markdown list formatting, and detail resolution still need parallel updates.

To add a search entity:

1. Add one lower-kebab-case module in `search-entity-plugins/`.
2. Export a `SearchEntityPlugin` with the entity `type`.
3. Implement the applicable hooks:
   - `buildDescriptors` for `understandSearchQuery` entity hints.
   - `buildCandidates` for list-search candidates.
   - `formatSlimMatch` for structured list results (`toSlimStructuredMatches` /
     `SlimSearchMatch`). It does **not** cover Markdown list output — keep
     actionable list fields in parity with `formatMatchListItem` in
     `search-format-list.ts` (entity refs, why-matched, inlined call contracts /
     shapes, next-step guidance).
   - `formatEntityDetail` only when `search({ entity })` supports that type.
4. Register the plugin once in `search-entity-registry.ts`, in the intended
   flatten order.
5. Extend the closed unions in `search-format-types.ts`, keeping these groups
   separate:
   - Always required for any list/result type (including result-only types such
     as `domain`): `SearchMatchType`, `SearchMatch`, and `SlimSearchMatch`.
   - Entity-backed only (types accepted by `{type}:{id}` / entity detail):
     `SearchEntityType`, `SearchEntityDetail`, and related
     `SearchEntityDetailStructured` variants as needed.
6. Update Markdown list formatting in `search-format-list.ts`
   (`formatMatchListItem` used by `formatSearchMarkdown`) for the new type.
   Plugin `formatSlimMatch` alone is not enough for agent-visible list text.
7. Teach `resolveEntityDetail` in `search-detail.ts` how to load that entity
   when `search({ entity })` should support it (skip for result-only types such
   as `domain`).
8. Update `parseEntityRef` in `search-format-helpers.ts` so `{type}:{id}`
   parsing accepts the new entity-backed type (first `:` is the type; the id may
   contain colons). Unknown types and malformed refs share the same
   invalid-entity error. Guide and package entity refs also accept a hash
   fragment. Guides: `guide:{id}#{slug}` for a heading, or `guide:{id}#L165` /
   `guide:{id}#L165-L180` for lines (uppercase `L`, checked before heading
   lookup). Packages: `package:{id}#{subpath}` for one export. A package
   fragment that is not an export subpath and names a source file
   (`package:{id}#README.md#export-jsdoc`, `package:{id}#src/file.ts#L165`)
   opens that file. Other entity types reject fragments in
   `resolveEntityDetail`. Missing file anchors fail instead of returning the
   whole file.
9. For entity-backed types, update the public allowed-type lists so agents and
   docs stay in sync:
   - `search-tool-definition.ts` (tool description and `entity` input schema
     copy that enumerates `capability` | `guide` | `integration` | `mcp-server`
     | `package` | `secret`)
   - `docs/use/search.md` (user-facing `{type}:{id}` type list)
10. Add or update `search.node.test.ts` to prove the registry-backed search
    behavior and whether the type is entity-backed.

Current candidate flatten order is:

1. `capability`
2. `guide`
3. `package`
4. `integration`
5. `secret`

The **package** plugin may emit additional first-class candidates for strong
export contracts (`id` / entity ref `package:{kodyId}#{subpath}`) alongside the
package index candidate. Promotion is capped and score-gated so broad queries
are not flooded; see `docs/use/search.md` (Package exports in ranked results).

`domain` is registered last as a result-only plugin (slim formatting only): its
rows come from the broad-query domain overview in `searchUnified`, not from the
candidate pipeline.

Keep ranking, scoring, and output formatting changes out of plugin seam work
unless the behavior change is explicitly requested.
