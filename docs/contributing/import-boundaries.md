# Import boundaries

`packages/worker` has four layers, and imports may only point downward:

| Layer                                       | Path                         | Holds                                                                                                 |
| ------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| App (`#app/*`)                              | `packages/worker/src/app/`   | Request handlers, SSR, and other server-only HTTP/UI code                                             |
| MCP capabilities (`#mcp/*`)                 | `packages/worker/src/mcp/`   | The MCP server, capability registry, capability implementations                                       |
| Shared primitives (the rest of `#worker/*`) | `packages/worker/src/`       | Domain services, repositories, and infrastructure both server layers build on                         |
| Universal (`#universal/*`)                  | `packages/worker/universal/` | Client-safe contracts, registries, display helpers, and UI primitives the browser bundle also imports |

The app layer may import MCP capabilities, shared primitives, and universal
modules. MCP capabilities may import shared primitives and universal modules.
Shared primitives may import universal modules. The browser client (`#client/*`)
may import universal modules and other client modules. Nothing may import
upward.

When two layers need the same code, extract it into `#universal/*` if the
browser must import it, or into a neutral `#worker/*` module if it is
server-only.

Do not grow `packages/worker/tsconfig-client.json` with individual worker files.
That config includes `client/**` and `universal/**` only.

## What is enforced

`kody-custom/enforce-import-boundaries` (see
[oxlint JS plugins](./oxlint-js-plugins.md)) fails `npm run lint` on:

- any `#app/*` import from a file under `packages/worker/src/mcp/`
- any `#mcp/*` import from a file under `packages/worker/src/package-registry/`
- any `#app/*`, `#worker/*`, or `#mcp/*` import from `packages/worker/client/**`
  or `packages/worker/universal/**` (except client test files that assert
  server/client parity)
- any `#client/*` import from `packages/worker/universal/**`

The rule covers static imports, re-exports (`export … from`), dynamic
`import()`, and `vi.mock` / `vi.unmock` specifiers, so tests cannot route around
it.

`#app/handlers/*` is never allowlistable from `#mcp/*`. A capability that needs
handler logic is the wrong shape — the shared part belongs in a `#worker/*` or
`#universal/*` module that both the handler and the capability call.

## Adding to the allowlist

Each boundary in `tools/oxlint/local-plugin.js` carries an `allowedSpecifiers`
list, and every entry needs a `reason` saying why the edge cannot be extracted
yet. `tools/oxlint/import-boundaries.node.test.ts` asserts that every entry is
documented. Prefer extracting a neutral module over adding an entry; the
allowlist exists to freeze the edges that already exist, not to make room for
new ones.

## Known remaining cycles

These are not covered by the rule yet:

- `#worker/jobs/*` and `#mcp/jobs-vectorize.ts` / `#mcp/jobs-embed.ts` import
  each other's building blocks. The job vector id and embed-text helpers should
  move to a neutral module the way `#worker/vectorize/*` did.
- Several non-MCP subsystems (`#worker/community/*`, `#worker/email/*`,
  `#worker/webhooks/*`, `#worker/scheduled/*`, and
  `#worker/account/unverified-account-purge.ts`, which wraps
  `#app/account-deletion.ts`) still import `#app/*` data modules. Extending the
  rule to all of `#worker/*` would need those extracted first.
