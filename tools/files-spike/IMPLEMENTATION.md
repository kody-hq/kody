# Collaboration implementation

User authorized the whole system on November 6, 2026. Video timestamps are
removed from scope, including the anchor schema. Preserve existing workspace
work and demo data. Do not stop after a mock or a first slice. No release or PR
is authorized by the transcript. Feature-flag rollout.

- [x] Per-file durable room and metadata ownership, immutable
      revision/checkpoint recovery, outbox and quota coordination
- [x] Shared page and text editing, one authority for humans/agents,
      revision-safe binary replacement
- [x] File/block/text comment anchors, durable threads/replies, comment
      permission, moderation, idempotency, resolved/outdated states
- [x] Browser/agent service parity, explicit agent attribution, mention
      notifications without automatic agent execution
- [x] Live presence, real cursor/selection decorations, inferred agent activity,
      recent participant order/fade/retention, duplicate-session aggregation
- [x] TanStack DB projections, disconnect/local-pending UI, persisted drafts,
      retry/resync
- [x] Directory inheritance/restriction, move access-change preview, embeds do
      not grant access, explicit revocable public sharing
- [x] Version/history policy, pinned references, metadata export/recovery and
      retention behavior, included/external storage policy
- [x] Polished responsive comments/presence UI in the existing full and preview
      workspace
- [x] Local proof with two identities and agent,
      restart/reconnect/retry/revocation, anchor edits/deletion, feature flag
      and full validation

Architecture and current limits: COLLABORATION.md. The workspace uses a
FileStore per organization, a real FileRoom per opened document, Yjs bindings
for pages and text, and immutable R2 checkpoints. Activated documents cannot
fall back to a parallel whole-document writer.

## Implementation progress, November 6

The workspace now uses a real per-file FileRoom, Yjs/Tiptap binding, durable
comment ledger, TanStack DB projections, IndexedDB pending updates, shared text
selections, recent/live participant badges, in-app mention/reply outbox,
file/block/text anchors, inherited/restricted access, move access previews, and
explicit revocable public read links. The isolated MCP proof exercises OAuth
plus execute against the actual service, with disposable data and cleanup. No
test fixture was added to the shared Jane demo through that proof.

Immutable history checkpoints and live edit versions are separate. R2
checkpoints include CRDT identities, checksums, and accounted bytes. Agent
writes checkpoint synchronously before reporting success. Ordinary browser edits
acknowledge durable room storage first. Account exports include room metadata,
and deletion keeps recovery indexes until room cleanup succeeds.

Verified so far: production Vite build, 18 focused Workers tests, anchor and
comment tests, 27 authorization/service tests, 24 flag/fixture tests, three
standalone editor/prose browser tests, and the isolated real agent journey. The
first full gate found regressions that have been fixed. The second full gate is
/tmp/kody-collaboration-validate-second.log and has its own .exit file. Do not
claim completion until final source passes. No release, PR, or schedule has been
created.

Final local proof: two actual browser sessions displayed a remote selection and
caret in Launch, and the comment rail remained aligned with the page title.
Reloading reconnects the room and restores the header controls. Discussion
pagination covers more than 100 replies and exact updates outside the first
page, with a legacy index migration. Room exports and anchor maintenance scan
all durable storage pages instead of silently stopping at the default limit.
Final gate passed with exit 0: /tmp/kody-collaboration-validate-final.log and
matching .exit. Results: 8,476 Node tests, 672 Workers tests, 35 MCP tests, and
104 browser tests, plus type checks, lint, and startup checks.

Storage completion: the catalog and history now live in indexed SQLite rows,
with legacy migration, independent history pagination, and no 64-file cap.
Storage settings and common browser/agent capabilities connect an encrypted,
host-approved R2 or S3 credential for future revisions. Old revision and pending
upload locators remain attached to their provider. Streams, range reads, account
export, cleanup receipts, and failed-probe cleanup use the same locators. Local
HTTP mocks exercise actual signing and provider cutover without contacting an
external account. The finder still loads its authorized metadata catalog; the
new paged directory capability is available for incremental consumers.

The final gate after these storage changes and the thumbnail resize focus fix is
/tmp/kody-collaboration-validate-completed.log with its matching .exit file. Do
not reuse the earlier passed gate as proof for these later changes. The focused
thumbnail resize keyboard test passed five consecutive runs.
