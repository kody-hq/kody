# Files collaboration spike

Status: local architecture spike. It is not connected to production Kody
accounts, MCP capabilities, billing, or deployment workflows.

The goal is one portable Markdown document that two people and an agent can edit
together, recover after a Worker restart, and move between object stores without
changing its ID, history, or grants.

## Run it

Use Node 26 and the repository's installed dependencies:

```sh
npm run files:spike
```

Open <http://127.0.0.1:13752/>. Create a document as Alice, then open its link
in another tab with `&person=bob`. The participant selector uses public local
fixtures, not real Kody identities. The Worker refuses non-loopback hostnames.
Do not deploy this harness or put private documents in it.

Run the checks:

```sh
npm run files:spike:check
```

These checks are included in `npm run typecheck`, which is part of the
repository's authoritative `npm run validate` gate. Browser and Worker code have
separate TypeScript configurations because they run in different hosts.

The build writes assets and a bundled test Worker under `.tmp/`. Local state
persists under `.wrangler/files-spike`. Closing and restarting the dev process
keeps acknowledged edits and checkpoints.

## Agent workflow

The local agent fixture has edit access to documents created in the local team.
Create a document, then read it and its version:

```sh
npm run files:spike:agent -- --create "Team notes"
npm run files:spike:agent -- --file <file-id>
```

Write an exact quoted-text patch to a JSON file:

```json
{
	"kind": "anchor",
	"quote": "Write the outline.",
	"replacement": "Write the outline, then review the examples."
}
```

```sh
npm run files:spike:agent -- --file <file-id> --patch patch.json
npm run files:spike:agent -- --file <file-id> --checkpoint
npm run files:spike:agent -- --file <file-id> --export
```

An anchor must match exactly once. Missing and ambiguous anchors return a
conflict without changing the document. Edits to unrelated text can proceed.
Full replacements require `kind: "replace"`, `baseVersion`, `base`, and
`content`. A stale replacement returns `base`, `current`, and `proposed` text,
plus the current version, so the agent can construct a three-way diff and retry.
The spike does not attempt semantic merging of whole-document rewrites.

## Storage

Storage stays under a collapsed control. Normal reads and writes use file IDs.
The default external destination is a second local R2 bucket, explicitly
identified in the storage control as a simulation. It proves adapter switching,
not access to a real user's Cloudflare account.

To use an actual S3-compatible endpoint, configure `S3_CONFIGURATION` as a
secret in a local .dev.vars file beside the spike Wrangler config. The value is
a JSON object containing `endpoint`, `bucket`, `accessKeyId`, `secretAccessKey`,
and `region`. Use `region: "auto"` for R2. Never commit that file or paste
credentials into a file document, patch, or chat. HTTPS endpoints are required,
with a loopback HTTP exception for the local S3 integration test.

Object paths are scoped by workspace and file ID. The S3 adapter signs requests,
does not follow redirects, and verifies copied content against SHA-256 before
switching the current location. A durable migration intent tracks interrupted
copies. Retrying copies the same immutable keys. The previous store remains a
recovery copy until the owner explicitly finishes the move. Purge includes
current, previous, interrupted-migration, and pending-checkpoint objects.

A missing or revoked external connection makes the document read only. The
acknowledged live document remains readable from the Durable Object. Full
history export requires access to its stored revisions. Restoring the connection
restores editing, without making a new file.

The S3 test uses a local HTTP server that checks signed requests and can reject
them. It does not claim a live R2 credential or verify provider interoperability
beyond this API contract.

## What is authoritative

| Fact                                                                | Authority                                        |
| ------------------------------------------------------------------- | ------------------------------------------------ |
| Workspace file list                                                 | Workspace-scoped directory Durable Object        |
| ID, name, owner, direct grants, revision manifest, current location | File Durable Object record                       |
| Live acknowledged text                                              | Yjs state in that same durable record            |
| Portable history                                                    | Immutable Markdown checkpoints in object storage |
| Connected participants                                              | WebSocket connections, not history               |

Every edit is applied to a candidate document first. Size and access checks run
before the record changes. The Worker persists the candidate before broadcasting
it or returning an acknowledgment. On reconnect, the browser merges server state
and resends pending local changes. Browser errors retain the local draft and
provide export instead of silently replacing it with server text.

A document session serializes edits, checkpoints, grants, and moves. This spike
briefly queues edits while a small document's revisions are copied. It does not
yet implement a long-running migration job for large media libraries.

Yjs is the live editing representation. Markdown checkpoints remain independent
of editor state, so history can outlive an editor change. The text editor does
not support comments, suggestions, rich blocks, or binary files yet.

## Bounds and access

The spike caps each workspace at 10 files, each document at 64 KiB of UTF-8 text
and 256 KiB of encoded collaboration state, and each history at 20 checkpoints
or 1 MiB. It caps open connections and edit rates too. These are harness bounds,
not proposed Free or Pro allowances. History-limit failures preserve live text,
reads, and export. No automatic history pruning occurs.

Alice owns a new document. Bob and the writing agent can edit, the viewer can
read, and the other-workspace participant cannot read it. Alice can change Bob's
direct grant. A grant change closes Bob's active connections, including a
downgrade to view only. The server checks live grants on every edit.

These fixtures exercise isolation but do not replace Kody's real access model.
Production must use the existing `authorize` path, credential scopes, profile
chains, and grants, as described in [Authorization](./authorization.md).

## Verification

The automated checks cover:

- Two independently edited human replicas plus an agent patch converge.
- Stale full replacements and missing or ambiguous anchors return conflicts.
- Cross-workspace reads, viewer edits, and revoked grants are denied.
- Malformed updates, quota failures, and failed durable writes leave the last
  acknowledged state intact.
- A real workerd process accepts WebSocket edits and recovers them after the
  runtime is disposed and recreated with the same persistence directory.
- Revoking a grant closes a real open editing socket.
- Storage moves preserve IDs, grants, portable history, and live text.
- Failed moves keep the source authoritative and can be retried or purged.
- Signed S3 requests, integrity checks, and credential revocation work through
  the real Worker runtime against a local S3 test endpoint.

Manual browser verification uses the spike's own local origin. The existing
control-kody login and Feature Map apply when this is connected to Kody's real
app routes, which this spike does not modify.

## Production integration still required

1. Add a file resource family through shared org permissions, grant presets,
   invite resource lookup, profile grants, and app capability declarations.
   Reuse the one access check and attribution path. Do not ship fixture auth.
2. Add a durable, recoverable creation/deletion workflow between the catalog,
   document session, and blob storage, including account export and deletion,
   team-org deletion, recovery copies, and abandoned uploads.
3. Add an org-wide quota reservation and usage-metering path. Choose Free
   eligibility, allowances, retention, and processing limits with Kent.
4. Resolve BYO credentials through Kody's credential boundary and a forkable
   setup package. Persist credential references, never raw credentials in file
   records. Scope access to a dedicated managed prefix.
5. Mount the document UI in Start and expose the same service through
   discoverable capabilities and the CLI. The spike's HTTP/CLI surface is local.
6. Add opaque stable viewer routes, temporary signed transfers, multipart
   uploads, binary revision handling, and provider CORS setup. This text spike
   sends document text through the collaboration service; it is not proof of
   direct large-file transfer costs.
7. Add isolated HTML previews and format-specific viewers. Design inherited
   folder access and anonymous publishing before exposing either.
8. Define draft durability across a browser crash, richer editor undo/cursor
   behavior, comments and suggestions, migration workers, checkpoints and CRDT
   compaction policy before a general release.

The `tools/files-spike` harness stays isolated from production. The separate
production foundation below adds the actual Kody bindings and entry points.

## Production foundation

`packages/worker/src/files/` adds the org-owned `FileStore` Durable Object. It
owns the catalog, revision manifests, upload intents, deleted-id tombstones, and
quota decisions. Immutable content lives in the dedicated `FILE_BLOBS` R2
bucket. The signed-in `/@org/-/files` page, `fileList`, `fileGet`, `fileCreate`,
`fileWrite`, and `fileDelete` capabilities, and `/v1/files` API operations all
use the same authorization service. File grants also work in profile snapshots.

The initial bounds are 64 files per org, 64 KiB of UTF-8 text per revision, and
16 MiB per binary revision. All revisions count against the workspace allowance.
`FILES_INCLUDED_BYTES` must be explicitly supplied to the write service. Missing
or zero capacity disables writes without blocking reads, exports, or deletion.
This does not choose the public free-tier size.

Writes carry a unique id and expected base revision. Retrying the same id and
content returns the original revision, conflicting bases return both versions,
and deleted ids cannot be reused. Upload intents reserve capacity before R2
writes, allowing the same upload to recover after an interrupted commit. File
resource grants use Kody's existing read, write, delete, and manage-access
permissions. File metadata and revision bytes join account export, and account
or org deletion purges the bucket prefix before clearing the catalog.

The page supports creating and uploading text, source editing, Markdown and
isolated HTML previews, downloads, immutable history, restore as a new revision,
conflict comparison, sharing invites, and confirmed deletion. Saves preserve a
draft on failure. Read-only grants hide write controls and remain enforced on
the server. Creator grants, profile intersection, audit events, and account
write leases apply equally to browser and agent operations.

For local UI iteration:

```sh
FILES_INCLUDED_BYTES=1048576 PORT=3748 npm run dev
# In another terminal, if this checkout has no local database yet:
npm run migrate:local
node tools/seed-test-data.ts --local
```

Open `http://localhost:3748/@jane/-/files`, sign in as `jane@example.com` with
`ilikecode`. Changes to the Start page hot reload. The 1 MiB allowance is local
configuration, not a public free-tier commitment. `control-kody` commands can
use `--origin http://localhost:3748` to avoid another checkout's server.

Next, connect the proven live collaboration protocol and BYO storage through
that same identity and authorization boundary. Binary uploads and previews are
supported within the pilot limits. Live CRDT collaboration is still separate
work.

Workspace pages autosave after a 900 ms pause. Revision history counts toward
the workspace byte quota, with no separate twenty-revision cutoff.

### Lazy file previews

Binary page loads contain metadata, never base64 file bodies. Authenticated
`/file-assets/:org/:file` responses stream immutable R2 revisions and support
byte ranges, including HEAD and 416 responses. They use the same resource-grant
authorization as file capabilities. Restoring a binary revision copies its
contents on the server instead of sending them to the browser and back.

PDF, SVG, audio, and video use native browser rendering. SVG stays in image
context and direct SVG responses are sandboxed. Office files use separately
built, content-addressed scripts for DOCX, XLSX, and PPTX. Each is fetched only
for the selected format and executes inside an opaque-origin iframe. The CSP
blocks external fetches, subframes, forms, and inline scripts. The parent sends
file bytes only to that frame; document scripts get no Kody API bridge. Office
archive metadata is bounded before parsing. XLSX renders saved cell values with
sheet tabs, capped to 1,000 rows and 200 columns per visible sheet.

Inline embeds fetch previews only near the viewport. Page editing, image
controls, Markdown, and native/Office viewer shells are separate lazy imports.
`npm run viewers:measure` reports compressed renderer sizes. DOCX and PPTX use
lightweight text and table previews with a corner notice. They do not reproduce
page or slide layout, images, charts, or full formatting. Both reuse JSZip and
the browser XML parser, with no Office layout engines. The ZIP directory reader
powers a lazy read-only ZIP browser with folder navigation and uncompressed
entry sizes, without another parser or decompressor. Extraction is not enabled.
Encrypted, split, ZIP64, and oversized archives show a download fallback.
