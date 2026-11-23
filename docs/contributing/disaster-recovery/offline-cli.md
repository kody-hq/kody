# Offline CLI fallback

The UI is the primary drill/restore path. Keep the CLIs for air-gapped or
UI-down recovery:

- `node tools/disaster-recovery/d1-restore-drill-cli.ts` — isolated D1 import of
  a REST-era schema-v2 SQL export against checked-in
  identity/baseline/manifest-key registries (`--database kody` or
  `--database kody-jobs`). Paced schema-v3 days drill through the UI.
- `node tools/disaster-recovery/canonical-readiness-cli.ts` — fail-closed
  readiness assessment from local Ed25519 evidence envelopes
- `node tools/disaster-recovery/seal-escrow.ts` — same seal used by
  `dr-escrow.yml` (also runnable locally with env vars)
- `node tools/disaster-recovery/unseal-escrow.ts` — authenticated recovery from
  a local sealed blob or the DR bucket; writes only to stdout or a new file
  outside the repository
- `node tools/maintenance-mode.ts` — edge maintenance mode (Cloudflare Single
  Redirect on `kody.codes`; see
  [Maintenance mode (edge)](./maintenance-mode.md))

Details:
[`tools/disaster-recovery/readme.md`](../../../tools/disaster-recovery/readme.md).
Trust registries are populated only by code review, and the guardrail test in
`restore-trust-and-verification.node.test.ts` pins their exact contents.
`trusted-d1-restore-identities.json` and
`trusted-backup-manifest-public-keys.json` carry the live reviewed production
identity, drill target, and manifest verifying key.
`trusted-restore-baselines.json` and `trusted-readiness-public-keys.json` remain
empty, which keeps CLI baseline verification and CLI readiness fail-closed
(**NOT READY**) — the UI drill and sealing flows are the primary operational
paths.

Known v1 restore-shape limits (documented, not bugs): R2 restore is put-only
(objects created after the backup day are not deleted by a restore), and the
`staging/{day}` → `daily/full/{day}` key layouts plus the `userId/storageId`
dump identity encoding are load-bearing for bucket lock and lifecycle rules —
changing them requires a reviewed migration of the bucket layout.
