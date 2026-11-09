# Files

## Seed / reach

Start a dedicated local server with
`FILES_INCLUDED_BYTES=1048576 PORT=3748 npm run dev`. Pass
`--origin http://localhost:3748` to control-kody commands. Run
`npm run control-kody -- login`, then use `execute` with `fileCreate` to create
a Markdown document, or create one through the signed-in Files page. Open
`/@{$orgSlug}/-/files`, then select a file. The `file` query parameter is its
stable id. Storage providers do not appear in this flow.

## Assert

- Create, edit, preview, save, reload, and download a Markdown, HTML, or CSV
  file.
- HTML previews run inline JavaScript inside opaque-origin sandboxed frames.
  Check that parent DOM, cookies, storage, top navigation, popups, forms, and
  ordinary network requests stay blocked. The trusted wrapper accepts content
  only from the same-origin parent. No Kody capabilities are exposed to document
  scripts.
- Keep a draft open, save another revision through `fileWrite`, then save the
  browser draft. A conflict preserves both versions until an explicit choice.
- History loads immutable text, and restore makes a new revision.
- Share creates an invite using existing file resource grants. A read-only
  collaborator can view and download but cannot save or delete.
- The action menu renames and moves pages, folders, and files. IDs, links,
  contents, and grants survive. Descendant destinations are excluded.
- Move to trash requires a second click and includes descendants. Trash in the
  sidebar lists recoverable roots, Restore recovers the original hierarchy. A
  subtree mutation fails without changes when any affected item is forbidden.
- Permanent deletion remains an explicit agent API operation. The ordinary
  website action moves items to trash.
- With no `FILES_INCLUDED_BYTES`, reads work and write controls are disabled.

- Edit a page without clicking Save, wait for Saved, and reload. The edit must
  persist. Keep typing during an in-flight save and verify the newer draft is
  saved next. Navigating away should flush pending page edits. Conflicts and
  failed saves must keep the draft and offer an explicit retry.

- Pages use a single Tiptap editing surface. Drag-select text across blocks,
  copy it, delete part of the selection, then undo. Verify block IDs and file
  embeds survive. Check block menus and slash commands, and confirm historical
  or read-only pages cannot be edited.

- Open PDF, DOCX, XLSX, PPTX, SVG, audio, and video fixtures. Office engines
  load only for their own format; native formats load no Office script. Sheet
  tabs and PowerPoint Next/Previous controls work. Office frames cannot access
  parent DOM or browser storage. File data must never go to an external viewer
  service.
- Binary loader data contains no base64 body. Stream responses honor a valid
  Range with 206, reject unsatisfiable ranges with 416, and let HEAD return
  metadata without reading bytes. File grants and immutable revision checks
  apply to asset URLs. Offscreen page embeds must not fetch contents until near
  the viewport.
