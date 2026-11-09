# File collaboration proposal

Status: local implementation, November 6, 2026. Collaboration now uses real file
rooms, shared Yjs documents, authenticated participants, and durable comments.
No simulated collaborators are used by the workspace.

## File details and permissions

Every page, folder, and file opens the same Details & permissions panel from its
context menu or file action menu. File grants reuse package collaborators'
people, team, organization, outside collaborator, audit, and invitation model.
Managers can set a role, edit individual file permissions, remove a grant,
revoke an invitation, and create or revoke a public link. Read-only viewers see
details without permission editing controls.

Inherited grants apply recursively. A restricted node requires an explicit grant
at that node for every requested permission. Every restricted ancestor must
allow that permission, so a child grant cannot restore writing, commenting,
deleting, or access management blocked above it. Organization owners retain
recovery access, subject to their credential scopes. Multiple grants at the same
node combine, matching existing team and package grants.

A public link explicitly publishes its root without sign-in. Restricted
descendants are excluded, and a restricted ancestor blocks a child's public
link, including links created before the ancestor became restricted. Public link
revocation does not remove quota reservations for pending file writes.

## Implemented ownership and behavior

One FileStore per organization owns hierarchy, quota reservations, immutable
revision references, and structural metadata. One FileRoom per opened file owns
the live Yjs head, comment rows, operation receipts, notification outbox, and
recent participation. File names and directory paths are presentation. Moving or
renaming a file does not change its identity or relocate its blobs.

The rich editor binds directly to Yjs. Agents use the same room through the
existing capabilities. Plain text uses Y.Text. Binary files retain version-safe
replacement and receive file-level discussions. Replacements refresh connected
previews and advance the discussion revision without accepting binary CRDT
edits. Agent creates, reads, writes, and comments infer participation. Comments
support file, block, and relative text anchors, with outdated markers when the
target disappears. Video timestamps are excluded from the schema.

A live save acknowledges durable room storage. Immutable R2 checkpoints include
both readable content and the CRDT state needed to preserve anchor identities.
Agent writes checkpoint before returning success. Browser checkpoints coalesce
on the room alarm. Live headVersion and immutable revisionId are deliberately
separate. Comments pin their originating checkpoint, and history is retained
until explicit deletion, subject to the included storage allowance. No automatic
age-based pruning is enabled.

Comment permission is independent from write permission. Commenters can resolve
or reopen discussions; authors can edit their own comments; authors and access
managers can remove comments. Mentions and replies enter the durable in-app
notification outbox. They never start an agent. Public links are explicit,
revocable read grants and omit discussions, participants, and private history.
Restricted descendants are excluded from directory links.

Clients use TanStack DB projections, persisted pending Yjs updates and comment
commands, and local drafts. Recent visitors expire after seven days and fade
over fifteen minutes. Live presence expires after 45 seconds, with 15-second
heartbeats. Inferred agent activity receives a 15-second activity lease. Session
and grant validity are checked during fanout, not just at socket admission.

Local proof includes two connected browser sessions with an actual remote
selection/caret, two identities with live grant revocation in Workers, recovery
from an immutable CRDT checkpoint, idempotent comment retries, deep discussion
pagination, and a disposable OAuth/execute agent journey with cleanup.

## Storage and catalog

The org catalog and revision history now use indexed SQLite rows. The migration
preserves existing stable IDs and immutable object keys. Listing returns current
revision metadata and counts rather than every historical revision. Directory
and history capabilities support cursors, and the version UI loads older history
on demand. The old 64-file pilot cap is removed. The existing finder still loads
the authorized metadata catalog for its tree, while rendering is virtualized.
The paged directory API is available for incremental consumers; this is not a
claim of a 100,000-file browser benchmark.

Owners can explicitly connect R2 or Amazon S3 through Storage settings in the
create menu. A dedicated encrypted workspace credential supplies signing keys,
with a required endpoint host allowlist and no package restriction. Keys stay
server-side and resolve through the central credential authorization and audit
service. A storage connection acts as its authorizing owner with only secret:use
scope, never as a browser session or an agent run. Its authorizer must remain an
active owner. Another owner can explicitly reconnect the same provider identity,
including with a replacement credential, without moving its bucket or stranding
history. Credential renames preserve the stable binding. Org-only resolution
never falls back to a personal credential. Connection verification writes,
reads, verifies, and deletes a probe. Failed cleanup remains durable and is
retried. A failed reconnection leaves the existing provider and active selection
unchanged. Arbitrary custom storage hosts are not accepted by this first
provider policy.

New revisions use the selected provider. Existing revision locators remain
immutable. Switching back to included storage never migrates or deletes existing
bytes. Live edit reservations and in-flight uploads retain their selected
provider through a default change. Included quota charges managed history and
pending managed uploads. External object bytes do not consume that allowance.
The application retains its per-file limits: 64 KiB text, 16 MiB binary, 1 MiB
shared state, and 64 live sessions. Metadata remains managed by Kody.

Asset streaming, range reads, history, account exports, and deletion resolve
through the same server-only locators. Public responses omit provider settings,
credentials, discussions, people, and history. Account deletion retains the
credential rows until external cleanup succeeds. Deletion receipts allow retry
without restarting every prior external delete.

Local tests cover 105 files, migration and paging of 125 revisions, old managed
and external history after a provider switch, signed external reads/writes,
range reads, expired credentials, exports, and deletion. External HTTP is mocked
in the isolated Workers test. No real external account has been connected or
charged, and production rollout still requires review.

## Input from the November 6 call

Source: Kody's 1:07 PM post in the private `kent-tanner-kody` Discord channel,
linking to the
[meeting summary and all 34 raw transcript sections](https://app.notion.com/p/2026-11-06-Call-Agent-first-files-workspace-OpenAI-41077ef0f2db819f9940f6e1a5664a96).
Read through the signed-in browser. This proposal records only the product and
engineering material relevant to files. It does not reproduce unrelated private
discussion.

The raw transcript labels Tanner as Speaker 1 and Kent as Speaker 2 in the
relevant demo sections. Its “Them” and “You” prefixes are recording labels, not
reliable author names on their own.

Product direction supported by the discussion:

- Parts 21–23: minimal asynchronous comments in a familiar right rail. Humans,
  connected agents, and deterministic packages are participants. Persisted human
  operations must also be directly callable by agents. Use the existing
  capability/service interfaces, not a separate file-plugin protocol or a new
  hosted agent/chat product.
- Part 22 discussed timecoded video comments. Tanner subsequently removed video
  timestamps from scope, including the anchor schema.
- Part 24: infer agent activity from authenticated file operations. Do not
  require agents to issue an “I am here” command. Show action/run attribution,
  block context where known, and a bounded recent-activity lease. The suggested
  15-minute fade is a starting value to test, not an agreed retention policy or
  an assertion that the agent remains connected.
- Parts 18–19: familiar directory access for teams and users, reusing existing
  authorization where possible. Explicit public file/directory sharing is a
  separate grant/publishing action. Copying a normal file link must not change
  access. Org-root visibility was discussed as a possible default; it is not a
  decided inheritance rule.
- Parts 25–27: HTML documents are sandboxed artifacts. Stateful dashboards use
  existing apps/packages and storage. An index of apps can live in the workspace
  without granting HTML artifacts application capabilities. Inline app execution
  is a separate later security/design decision.
- Parts 30–31: prioritize ordinary copy-to behavior. Do not introduce a public
  fork graph or a Git-like branch model for files as part of
  comments/versioning.
- Parts 28–29: architecture review comes before rollout. Discuss the PR with
  Kent, address cost/performance/permissions, then use a feature flag and the
  experimenters track. Reading the transcript does not itself authorize opening
  a PR or releasing the feature.

Still open, not decisions from the call: authoritative metadata placement,
per-file room topology, CRDT persistence and checkpoints, R2 limits and
economics, comment moderation policy, directory inheritance, and public sharing
semantics. The database/room split in this document is a recommendation for that
review.

The demo conversation describes CRDT behavior as if available (parts 15 and 18).
At proposal time the workspace had no collaboration provider. The local
implementation now connects the rich editor to the room. Two-client editing
remains a release acceptance test.

### Metadata layouts to review with Kent

| Option                                                                   | Tradeoff                                                                                                                                  | Recommendation                                            |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Hidden metadata beside user-named objects                                | Renames, permission changes, and concurrent comments require coordinated updates across objects; listing must filter implementation files | Do not use as the live source of truth                    |
| A mirrored metadata directory tree                                       | Duplicates path/hierarchy management and can drift during moves or partial failures                                                       | Do not use as the live source of truth                    |
| An internal prefix per stable file ID, with content and manifests inside | Useful object-key organization and export packaging; it is not itself a transactional database                                            | Use for immutable blobs/checkpoints and derived manifests |
| Database records keyed by stable file ID                                 | Supports queries, moderation, access checks, operation receipts, and durable transactions                                                 | Recommended authority for metadata/comments               |

An object prefix resembling a directory is compatible with database-owned
metadata. The important decision is who owns each mutable record and how a
complete workspace can be recovered, not whether an R2 key contains slashes.

### Cost and performance review before rollout

Measure a realistic quiet workspace, an actively coedited page, an agent batch
editing many files, and a large directory being browsed. Include object request
counts and bytes, retained revisions, checkpoint frequency, durable storage
writes, active room duration, presence fanout, and directory-query latency.
Compare included storage and external-provider operation paths. Specify
storage/history allowances and behavior at the limit. UI virtualization is not
evidence that catalog listing, authorization, or revision storage scales to
hundreds of thousands of files.

## Ownership

Keep authoritative metadata in databases keyed by stable IDs. File paths are
presentation, not identity. Do not use hidden sibling files, mirrored directory
trees, or R2 object custom metadata as the authoritative comment store.

| Owner                  | Records                                                                                                                                  | Consistency                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Org catalog            | File ID, name, parent, media type, storage reference, quota reservations, metadata version                                               | Serialized structural commands, indexed and paginated |
| Existing access system | Resource grants, org membership, delegated capability scope                                                                              | Authoritative for admission and revocation            |
| File room              | Content head, collaboration epoch, CRDT checkpoint and update tail, thread/comment records, durable activity, operation receipts, outbox | Persist before success acknowledgement                |
| Object storage         | Immutable content revisions, immutable CRDT checkpoints, optional backup/export manifests                                                | Publish references only after verified writes         |
| Client collections     | Authorized visible files, threads, comments, recent participants, unread state                                                           | Rebuildable projections with optimistic commands      |
| Awareness channel      | Session lease, active file/block, selection, editing/idle state                                                                          | Ephemeral and bounded                                 |

A file room is a lazily addressed Durable Object, not a permanently running
process for every file. It can coordinate comments on a binary file even when
that file has no editable CRDT. Use hibernating WebSockets where supported,
reconstruct state on wake, and remove dead sessions with leases. High-frequency
awareness must not trigger durable writes or perpetually keep every room awake.

Use SQLite-backed room storage with independent rows/tables rather than
repeatedly rewriting a growing JSON file record. Split revisions out of the org
record; avoid returning every revision with every directory listing. Start with
one room per file and a bounded org catalog. Sharding the catalog later should
not alter public file IDs or the command API.

The org catalog and file room cannot share a database transaction. File rooms
own content heads; directory listings hold a versioned projection. An outbox in
the room's commit transaction retries catalog and notification updates
idempotently. Never treat a stale catalog projection as authoritative for
content head or authorization. Quota uses an org reservation before an upload
and reconciliation after commit, not an optimistic count with no recovery path.

## Versions and recovery

Keep application revision IDs and immutable object keys across R2 and
S3-compatible stores. Do not couple history to provider-specific bucket version
IDs. Store hash, byte count, storage locator, author identity, reason,
timestamps, parent/head relation, and collaboration frontier with each revision.
Preserve storage locators for old revisions through provider migration; do not
replace a file-wide provider pointer and strand history.

A live editing acknowledgement means the accepted update is durably recorded in
room storage. It does not mean an R2 checkpoint has already been produced. A
separate checkpoint process compacts a bounded update tail and writes a
recoverable immutable state. The UI must distinguish locally pending, server
saved, and temporarily disconnected states. Define maximum checkpoint delay and
supported recovery horizon before shipping.

Do not put every keystroke into user-visible history. Coalesce autosave
checkpoints, keep explicit milestones and agent run boundaries, and pin
revisions referenced by comments or review. Define storage and history retention
with quotas. Deleting old blobs is a reference-aware collection job with a grace
period, not a bucket age rule that can erase a live reference. CRDT compaction
must preserve identities needed by live anchors and supported offline clients.

Write new blobs first, verify them, then atomically commit revision references
and outbox events in the room. Uncommitted uploads are recoverable pending
records and eventually collectible orphans. R2 and SQLite are not one
transaction. Export metadata and checkpoint manifests for backup/portability,
including comment authors and anchor schema versions. Those exports are derived
copies. A bucket alone must not be advertised as a complete workspace backup
without them.

Restoring a historical page normally becomes a new forward change through the
current CRDT, preserving usable block identities where possible. Never silently
replace the document with an unrelated Y.Doc while old clients remain connected.
An unavoidable history reset needs a new collaboration epoch, resync, and
explicit anchor migration. Duplicating a file produces a new identity; comments
stay with the original unless explicitly copied with provenance.

## Comments

A thread belongs to `(orgId, fileId)` and optionally targets a revision, block,
or range. Comments are independent of content revisions, so a reply does not
create a new file version.

- `thread`: ID, file ID, anchor, anchor schema version, created-at/by,
  resolved-at/by, optimistic concurrency version.
- `comment`: ID, thread ID, body, immutable author identity,
  created/edited/deleted timestamps, mutation version, optional reply reference.
  Preserve audit policy separately from visible soft deletion.
- `actor`: person or agent identity, acting-for person/org, and optional agent
  profile/run ID. Derive it from authentication, never a user-supplied display
  name. The same human may have several browser sessions; one agent may have
  several runs.
- `receipt`: operation ID and result for safe retries.
- `read-state`: per viewer/thread last-read sequence. Only explicit opens/reads
  count, never background prefetch.

Start with file-level and block-level anchors, then stable text ranges once Yjs
is integrated. Store Yjs relative positions plus block ID, quote/context
fallback, and originating revision. Plain integer text offsets drift under
edits. When the source is deleted or matching is ambiguous, show an outdated
anchor and its original excerpt/revision. Never silently attach a comment to a
different sentence.

Use a discriminated anchor schema for file, block, text range, image region, PDF
page/region, structured-record identity. Add only file/block/text UI first.
Pixel positions must be normalized to source dimensions and tied to a revision.
A CSV row number or JSON array index is not a stable record ID. HTML and Office
preview comments must not depend on arbitrary DOM coordinates; begin with
file-level or revision-level comments there.

Commands: list threads with a cursor, get a thread, create a thread, reply, edit
own comment, resolve/reopen, and remove under policy. Browsers and agents call
the same service commands, permissions, identity derivation, idempotency
handling, rate limits, and revision checks. Agent-friendly block/context lookup
can return safe opaque anchor tokens. Agents do not need to understand a browser
DOM or keep a socket open to comment.

Add a comment permission independently from content editing. Read permission
bounds visibility of threads and participants. Resolve/delete policy needs
explicit product defaults. Mentions enqueue notifications after commit through
the outbox; comments, mentions, or instructions inside a document do not
themselves grant an agent permission to run tools or edit files. Agent reply
loops need budgets, deduplication, and explicit subscriptions. Do not spawn
agents automatically just because somebody typed a mention.

Authoritative comment commands are validated server-side. Do not put mutable
server-managed comments in a writable Y.Doc shared with comment-only users and
then assume read-only content is protected. Raw CRDT binary updates also need
schema/size validation and accepted document boundaries. A rich-text editor undo
stack should not undo a remote comment or permission change.

## Presence and multiplayer behavior

Separate live presence from durable recent participation.

Live: session ID, authenticated actor, file/block, relative selection,
editing/reading/idle status, heartbeat lease. On disconnect or expiry, stop
showing the live dot and cursor. Aggregate multiple sessions into one avatar per
actor, expand session details on demand. An agent receives an agent badge and
run/activity label; an API read is not a fabricated mouse cursor.

Recent: coalesced foreground open/activity times, last seen, and optionally last
edited/commented, under a bounded retention policy. Do not write every cursor
movement. Reads from background preview cards, thumbnails, indexing, and agents
listing a directory should not mark someone as viewing a file.

Suggested initial presentation, to tune in the prototype:

1. Active editors, then current readers, then recent visitors, sorted by last
   activity within each group. Freeze ties and avoid reordering on every
   heartbeat.
2. Current participants have full-opacity avatars and a live marker. Recent
   avatar images fade over minutes/hours; names and timestamps remain readable
   in the popover. Never use a faded avatar as the sole indication of status.
3. Cap the header stack and show `+N`. Exclude self from the visible stack by
   default. Click shows names, person/agent identity, current activity, and last
   seen.
4. Show a caret/selection for text editors and a quiet block marker for readers.
   Hide labels after a short delay. Avoid broadcasting free-floating mouse
   movement over every document.
5. Image/media pointers should be normalized to content coordinates, not
   viewport pixels. Following another participant is opt-in and Escape exits
   following. Presence of a viewer does not imply permission to expose their
   identity in every sharing mode.
6. Comments open in a compact rail on wide screens and a sheet on narrow
   screens. Clicking a marker brings its anchor into view. Resolve collapses the
   thread but keeps it accessible. Drafts survive closing the panel and
   reconnecting.

## Which libraries

Yjs owns concurrent document editing and relative positions. Awareness owns
temporary presence. A network provider transports them. Tiptap needs the
matching collaboration binding and cursor/selection decorations; the spike's
Y.Text cannot be substituted directly for a rich editor's shared XML structure.
Plan a single-authority cutover per file: initialize shared state from the saved
page once, then all human and agent writes route through that authority. Do not
run whole-document autosave and CRDT replacement in parallel.

TanStack DB is a good client projection layer for files, threads, recent
participants, and unread state. It does not replace the server's durable
database, authorization, or the rich-text CRDT. Start by integrating the
existing query transport or a small validated sync adapter. Load collaboration
code only for an opened document or comment panel, not every finder thumbnail.

Durable Streams offers persisted replayable HTTP streams, and its Yjs provider
includes compaction and optional awareness. StreamDB builds typed reactive
collections on Durable State and TanStack DB. These are viable alternatives for
transport and projection, not requirements to install alongside a custom room
protocol. Decide whether one owns the durable update log before implementation.
Do not accept updates independently into two competing logs.

For this Cloudflare codebase, the default proposal is file rooms plus Yjs and
TanStack DB projections. Run a bounded Durable Streams comparison before locking
the provider if it materially reduces restart recovery, offline replay, agent
subscriptions, or maintenance. Evaluate auth/revocation, deployment model,
acknowledged durability, compaction compatibility, loaded bundle size,
active/idle cost, and fault behavior. Keep a provider interface and portable
checkpoints so this choice remains replaceable. Never expose an org-wide replay
stream to a file-scoped grant.

## Build order and acceptance

1. Feel prototype: simulated current/recent participants, comment marker/rail,
   agent attribution, resolve/reopen, recency decay, disconnected state. It
   establishes interaction choices only.
2. Real local vertical slice: two separately authenticated browsers plus an
   agent command on one disposable page, live Tiptap/Yjs selections, file/block
   comments, room persistence, and coalesced recent activity. Use actual
   identities and explicitly show mock agents when simulated.
3. Durability proof: kill/restart room and server, reconnect with unsent edits,
   retry commands, restore an old revision, remove an anchored block, and revoke
   access while a socket is open. Verify no acknowledged data disappears, no
   duplicate replies appear, no stale cursors remain, and revoked users cannot
   keep receiving updates.
4. Expand anchors to image/PDF and add cross-file inbox/search projections only
   after the vertical slice works. Retain ordinary raw-file replacement with
   revision conflicts for binary formats. Concurrent arbitrary binary editing is
   not promised.

Decision needed before production: retention/access policy for recent viewers,
who can resolve another person's thread, whether mentions invoke agents at all,
supported offline horizon, and included/external checkpoint durability
expectations. These do not block a labeled local interaction prototype.

## Prior art

- [Dropbox architecture](https://www.dropbox.com/business/trust/security/architecture):
  metadata database separated from content-addressed file storage.
- [Notion's block model](https://www.notion.com/blog/data-model-behind-notion):
  stable block records and references.
- [Notion concurrent editing](https://www.notion.com/blog/how-notion-handles-concurrent-editing-with-crdts):
  rich-text CRDT work and block split/merge cases. This is evidence for explicit
  modeling, not a recommendation to copy their private infrastructure.
- [Yjs awareness](https://docs.yjs.dev/getting-started/adding-awareness):
  temporary presence separate from persisted content.
- [Yjs relative positions](https://docs.yjs.dev/api/relative-positions):
  positions and text anchors that survive concurrent edits, including
  deleted-anchor failure.
- [Google Drive comments](https://developers.google.com/workspace/drive/api/guides/manage-comments):
  separate comment/reply records and revision-aware anchors; arbitrary API
  anchors are not automatically rendered by Workspace editors.
- [Cloudflare WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/):
  hibernation and room lifecycle.
- [R2 S3 API surface](https://developers.cloudflare.com/r2/api/s3/api/): verify
  capabilities rather than assuming all S3 features exist.
- [Durable Streams Yjs](https://durablestreams.com/yjs),
  [StreamDB](https://durablestreams.com/stream-db): replay/compaction provider
  and collection integration.
- [TanStack DB overview](https://tanstack.com/db/latest/docs/overview): client
  collections, live queries, and optimistic mutations.

## Comment interaction rules

Selecting page or text content exposes Comment and the platform shortcut. Page
anchors use Yjs relative positions and stable block IDs. Highlights and comment
counts are editor decorations, so opening a discussion does not change stored
content or block spacing. The active discussion sits alongside its anchor on
desktop and opens in a bottom sheet on small screens.

Composers keep separate local drafts for each anchor, reply, and edit. Failed
commands retain their text; explicit Cancel discards it. Mention suggestions,
sending, discussion navigation, and closing use scoped TanStack Hotkeys while
ordinary text editing keeps its native behavior. Closing returns focus to the
editor. Resolve supports Undo, and comment actions use the shared context menu.
Unread state comes from canonical room notifications, and only a visible,
focused active discussion is automatically marked read.

## Sharing and copies

The file drawer separates access management from details. Direct grants, parent
access, and public links are distinct. Only managers can recover a public link
token, which is sealed in the file store alongside its hash. Older hash-only
links keep working and can be replaced when the owner needs a new URL.

A public link opens a standalone preview and download without sign-in. Use in
Kody offers an agent prompt or an independent copy in the visitor's personal
workspace. Sign-in returns to the copy dialog without starting a write. Copies
include visible descendants and page embeds, with new file IDs and no source
grants, comments, presence, or history. A sealed plan binds the selected
revisions and destination to the signed-in person. Each step checks current
public scope, then writes through the normal quota and audit path. A retry
within the dialog resumes with the same write IDs.
