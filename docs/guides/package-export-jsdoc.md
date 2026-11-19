---
id: package_export_jsdoc
title: Write export JSDoc for a package
summary:
  Per-export JSDoc rules for Kody packages: what search's Exports Purpose column
  reads, the required what/when line, @param, @returns, and an importing
  @example, and where JSDoc must sit for types files and re-exports.
category: platform
audience: agents
---

# Write export JSDoc for a package

Search detail (`entity: "package:…"`) shows an Exports table whose **Purpose**
column comes from each export's JSDoc. When JSDoc is missing, Purpose falls back
to the generic string `Package export.` Agents skim that column first when
choosing among sibling exports. Export-specific limits and call gotchas belong
here, not in MCP server instructions or account memories
([Where agent guidance lives](./agent-guidance.md)).

TypeScript types and the export name give call shape when present. They do not
say **when** or **why** to pick one export over another, and on exposed exports
they do not protect callers who pass plain objects through `execute` (see
[Runtime input checking](./package-authoring.md#runtime-input-checking)). README
`## Intent` is package-scoped and often does not name every export. Neither
replaces per-export JSDoc.

Do not add a package manifest field, runtime object, saved value, or other Kody
primitive solely to track export purpose. Put it in JSDoc on the exported
function.

When you create or materially change a public export:

1. Write JSDoc immediately above the exported function (or above
   `export default` for a local binding in the same file).
2. Start with one line that states **what** the export does and **when** to call
   it.
3. Add `@param` for each input.
4. Add `@returns`.
5. Add `@example` that **imports** `kody:@scope/id/export` and **calls** it.

If the export's `package.json` `exports` entry has a `types` condition, put the
JSDoc on that types file — search reads the types module when it exists. JSDoc
on an imported re-export (`export default foo` where `foo` is imported) is not
attributed; implement the function in the export file (or a local binding in
that file) so the comment sits on the exported symbol.

```ts
/**
 * Format a Discord moderation report for a channel.
 * Use when a human or job needs a readable summary of recent flags.
 *
 * @param input - Channel id and optional lookback window
 * @returns Markdown report body
 *
 * @example
 * import formatReport from 'kody:@scope/discord/format-report'
 *
 * const report = await formatReport({ channelId: '123' })
 */
export default async function formatReport(input: {
	channelId: string
	lookbackHours?: number
}): Promise<{ markdown: string }> {
	return { markdown: '' }
}
```

Treat missing or generic Purpose (`Package export.`) as unfinished work, the
same as a missing README `## Intent` section.
