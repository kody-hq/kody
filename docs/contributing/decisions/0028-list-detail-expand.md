# 0028: List/detail records expand inside the table

- **Status:** accepted
- **Date:** 2026-08-20
- **Supersedes:** [0010](./0010-account-record-table.md) mode assignment
  (`expand` for read-only records, `pane` for editors)

## Context

[0010](./0010-account-record-table.md) put editors in a pane below `RecordTable`
so a long form would not push the list apart. In use, that made secrets,
integrations, MCP servers, memories, jobs, and the other list/detail screens
feel unlike packages: the record lived outside the row that selected it. Create
flows (`/new`) also had no row to attach to — `selectedId` is `null` — so a
naive `mode="expand"` hid the editor.

Admin platform integrations already kept its form in the expanded row. That is
the shape readers expect for every list/detail screen.

## Decision

List/detail screens use `RecordTable` `mode="expand"`, including editors. `pane`
stays only as the off-window fallback: a loaded record whose row is not in the
current list (deep link, filter, or paging) still renders below the table. A
not-found state also renders below the table, even when no row is selected.

Create flows share one `createRow` prop. It prepends a selected placeholder row
and unfolds the editor under it, including when the collection is empty so the
table is not replaced by the empty-state copy.

## Consequences

The list is not height-capped while a record is expanded (already required by
0010). A large editor still grows the table; that is the accepted trade. Screens
no longer assemble a one-off `__new__` row and selected id.

Revisit if a record outgrows one column badly enough to need a dedicated route —
the option 0010 left open — rather than adding a fourth table mode.

## Table controls

`RecordTable` uses TanStack Table for row processing. Existing callers keep
their current list and detail behavior until they provide `dataControls`. Skills
is the first caller to opt in.

Pass raw sortable/filterable values in `row.values`, separately from rendered
`row.cells`. Controlled sorting, column filters, global search, and pagination
live in `dataControls.state`; `onStateChange` receives patches. Skills stores
these in route search parameters, resets the page on filter changes, and
preserves them when opening a skill. Its by-package view groups the current page
of skills, with package sorting applied first.

Client mode filters and sorts the loaded collection before paging. For a
server-paged collection, use `manual: true` and the server's `rowCount`, and
apply all processing in the query. Do not client-sort or filter a partial server
page. A stable `visibilityKey` saves column preferences in the browser; primary
columns remain visible.

Selection is opt-in through `dataControls.selection`, which requires a bulk
action renderer. The header checkbox selects the current page. Selection is
controlled and can persist across pages; the action renderer receives both
loaded selected rows and all selected IDs, including unloaded server pages.
Callers must clear deleted selections and decide whether a changed query should
retain them. Skills is read-only and does not enable selection.

Tables keep their columns visible and scroll horizontally by default. The
compact “Stack rows” toolbar toggle opts into labeled stacked rows at any
container width. Narrowing the viewport no longer hides columns or switches
layouts automatically.
