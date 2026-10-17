# 0010 supporting material — account RecordTable

Historical working notes behind
[decision 0010](../../0010-account-record-table.md). Measurements, rejected
alternatives, and a screen inventory from the week the first RecordTable landed.
**Not current layout law** and not part of the
[steering veto list](../../index.md). 0010 is superseded by
[0028](../../0028-list-detail-expand.md).

- [Screen inventory](./page-inventory.md) — every affected screen, its mode, and
  its `MetadataGrid` call site

## The measurement that reframed it

`AccountManagementShell` caps at `72rem`. Inside it the rail and gutters leave
an 810px content column, and `AccountManagementLayout` splits that column:

|               | list  | gap  | record    |
| ------------- | ----- | ---- | --------- |
| Split (today) | 352px | 24px | **434px** |
| Unsplit       | —     | —    | **810px** |

434px is what the browser reports at 1244px wide, and also at 2560px: past
1152px every extra pixel becomes margin. Unsplitting the column is worth +87% to
the record and touches nothing outside `AccountManagementLayout` — more than
raising the cap to `96rem` would have given (525px at the same viewport), for a
far smaller blast radius.

At 434px the pane is 376px inside its padding, so `columns={3}` yields 115px
columns. A UUID is 36 characters. That is the whole story of the wrapped ids.

## Rejected alternatives

**Raise the cap to `layoutMaxWidths.wide`.** Two tokens, and it does help. But
the header and footer keep their own `72rem` measure, so the console outgrows
the brand above it unless all three move together, and it does nothing for
phones. Kept as a possible follow-up, not a prerequisite.

**Replace the shell: rail into a horizontal section bar, uncapped width,
mail-client split.** It buys the most room, but the rail is not what starves the
record — the split is — and a 15-item horizontal section bar scrolls sideways on
a laptop, which trades one problem for another. Rejected in favour of leaving
the shell alone.

**A dedicated record route per screen.** Best density available, and the right
answer for a record deep-linked from outside the account area. It discards the
scroll-preserving list navigation from #1270 and turns comparing two records
into two navigations. Deliberately not built; named in 0010 as the escape hatch
if a record outgrows one column.

**Keep side-by-side with a slimmer list.** A 216px name-and-date rail gives the
record 578px. Better than today, worse than stacking, and it forces the filters
into a popover that then needs designing. Rejected.

## The component API

Settled by building it against four screens rather than by design:

```ts
RecordTable({
  mode: 'expand' | 'pane' | 'none',
  columns: [{ key, label, align?, drop?, render? }],
  rows,
  selectedId,
  buildHref, // rows stay real links
  toolbar: [ /* controls */ ],
  renderRecord, // omitted for mode: 'none'
  countLabel,
})
```

Four screens needed 13–15 lines of config each and no per-page CSS. Three things
that only surfaced from building it:

1. **`mode` is a prop, not two components.** The plan was `RecordTable` plus a
   separate list-over-detail layout. Secrets proves they are one component:
   identical toolbar, table, columns and metadata band, differing only in where
   the record renders.
2. **Column dropping is per-column priority, not one breakpoint.** Usage has
   five columns that all matter; packages has two that do not. Hence
   `drop: 1 | 2 | 3` on the column, with the card fallback at 620px catching
   whatever is left.
3. **`expand` must not cap the list height.** The record renders inside the
   list's scroller, so a `max-height` traps it in a nested scroll. Visible the
   moment admin users unfolded eight fields and a role cluster. `pane` and
   `none` keep the cap, because there it is what keeps the record below
   reachable.

A control _cluster_ fits an expanded row (admin users carries a role select, an
add button and two destructive actions). A _form_ does not — that is what `pane`
exists for.

## Implementation order

Two independent steps. The first stands alone and is the only one that helps
phones.

**1. Content layer — landed.** No layout change, so it could land and be judged
by itself.

- `MetadataGrid`: `columns` prop gone, replaced by
  `repeat(auto-fit, minmax(min(14rem, 100%), 1fr))` across all 17 call sites.
  The `min()` guards a container narrower than the floor; the old
  `max-width: 860px` single-column override went with it, since auto-fit now
  answers that question from the container rather than the viewport
- `IdValue`: single line, `text-overflow: ellipsis`, copy button. The whole
  value stays in the DOM — clipping is CSS, never a truncated substring — so
  assistive tech reads the id in full and `user-select: all` makes one click
  select it; `title` is the hover convenience on top of that. Its copy button is
  a new `chip` variant of `CopyTextButton`, named per field so a band of six ids
  does not present six identical "Copy" buttons
- `TimestampValue`: `white-space: nowrap` and
  `font-variant-numeric: tabular-nums`, and it owns the null fallback
- `/account/packages` `searchText` moved behind an `accountDisclosureCss`
  disclosure with a `12rem` scroll box

Ids outside a metadata band were left alone: the inbox address on
`/account/email`, the connector and endpoint URLs, the TOTP setup key, and the
reporter/owner ids on `admin/community-reports` — a screen the inventory above
already defers.

**2. `RecordTable` across all seventeen screens — landed.**
`packages/worker/start/pages/record-table.tsx`, with `/account/packages` as its
first consumer and the other sixteen following. `AccountManagementLayout`,
`AccountManagementSidebar`, `AccountManagementList`,
`AccountManagementListItemLink`, `AccountManagementSearchField`,
`accountManagementListMaxHeight`, and the three `accountManagementTable*Css`
exports are deleted.

Both steps keep `createListDetailRoute`, the loader payloads, and the `selected`
query parameter untouched — this was a rendering change, not a data or routing
one.

### Where the built API differs from the one settled above

The API in this record was written against a throwaway HTML prototype, which
held one flat array and no types. Two parts of it could not be built as
specified:

- **`columns[].render(row)` became `rows[].cells` keyed by column key.**
  `remix/ui`'s JSX does not carry component generics — neither inference nor an
  explicit `<RecordTable<Pkg>>` type argument reaches the component, so a
  `render` callback would receive `unknown`. Call sites stay fully typed because
  each maps its own typed rows into `cells`.
- **`renderRecord(row)` became a `record` prop holding the built node.** Every
  one of these screens loads its detail separately from its list — an
  `AccountPackageDetail` is a different payload than an
  `AccountPackageListItem`, not a richer view of the same object. `RecordTable`
  decides where the record goes; the screen decides what it is.

Two more things the real components forced that a static page could not show:

- **`ariaLabel` names the region as well as the table.** An empty collection
  renders no `<table>` at all, so on a fresh account the toolbar, count, and
  empty copy sat in an unnamed part of the page.
- **`onNavigate` takes the row id.** `account/remote-connectors` seeds its
  editor draft from the row being opened, which a no-argument callback cannot
  do.

### Screens whose shape changed beyond the swap

- **`account/integrations`** had a two-level sidebar: OAuth apps as group
  headers with their connections nested underneath. A table has no second level,
  so this is now two tables — apps, then connections with an App column. Each
  keeps its own selection.
- **`admin/system-email`** made the inbox local part the row link. The subject
  is the primary column now, because the primary column is both the link and the
  card heading below 620px, and "support" is not a useful heading.
- **`admin/users`** had a hand-rolled entitlements table inside its detail; it
  is a nested `mode="none"` `RecordTable`, which trades a sideways scroll for
  the card fallback.
- Placeholder panes ("Select a package", "Select a job", …) are gone. They
  existed to fill the empty right half of a split that no longer exists.

## Open questions

- **Sort affordance.** Settled: the toolbar keeps the existing `sort` select.
  Clickable column headers would be more natural in a table but need to stay
  URL-backed to match how `q`, `app` and `sort` already work, and that is a
  separate change.
- **Expanded-row semantics.** Built as specified: a `colspan` row after the
  selected row, with the name cell's link carrying `aria-expanded` and
  `aria-controls`. The axe suite passes, but it still wants a screen-reader
  pass, which axe cannot stand in for.
- **`admin/users` role cluster.** Shipped as `expand`. If it feels wrong in use
  it moves to `pane` — still a one-word change.
- **Whether to also raise the cap** afterwards, moving header and footer in
  step. Independent of everything above, and still open.
