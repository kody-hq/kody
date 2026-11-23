# Disaster recovery

Solo-operator runbook for Kody production data. One operator (Kent) owns
enablement, escrow, drills, and restore. The engineering invariants stay
fail-closed: immutable R2 objects, Ed25519-signed manifests, checked-in trust
registries populated only via code review, source/drill identity allowlists, D1
size ceilings, and drill-before-production-restore.

In short: the production worker stages every canonical store nightly into a
locked bucket on a separate DR Cloudflare account, the DR control plane seals
each complete day, and restore replays a sealed day after an isolated drill has
proven it. These pages describe the designed end state. Treat every checklist
item as unproven until the
[live evidence log](./disaster-recovery/evidence-log.md) has evidence for it.
Code-complete packages are not proof that the DR account, bucket locks, secrets,
schedules, Access policy, or escrow blob are live.

Load only the page you need:

- [Live evidence log](./disaster-recovery/evidence-log.md) — first-proven date
  for each lane and the incidents that shaped it
- [Architecture](./disaster-recovery/architecture.md) — objectives, DR account,
  bucket layout, capture lanes, derived and accepted-loss stores, gaps, and
  exclusions
- [Credentials and escrow](./disaster-recovery/access-and-escrow.md) — which
  credential lives where, Admin UI auth, and `SECRET_STORE_KEY` escrow
- [Restore and drills](./disaster-recovery/restore.md) — Admin UI routes, agent
  seal API, isolated drill, graduated production restore, Durable Object PITR,
  and Mailbox re-import
- [Schedules and freshness](./disaster-recovery/schedules.md) — cron table,
  alerts, and finishing a stranded staging day
- [Maintenance mode (edge)](./disaster-recovery/maintenance-mode.md) — turn
  ingress off and on with a Cloudflare Single Redirect
- [Offline CLI fallback](./disaster-recovery/offline-cli.md) — CLIs for UI-down
  recovery
- [Solo enablement checklist](./disaster-recovery/enablement.md) — top-to-bottom
  setup and ongoing drills

Primary operator surface:

- Admin UI on the backup control-plane Worker (Cloudflare Zero Trust Access +
  in-worker JWT verification) for dashboard, seal-day, isolated restore drill,
  and graduated production restore.
- Offline CLIs under `tools/disaster-recovery/` when the UI is unavailable.
- Edge maintenance mode: `npm run maintenance-mode -- on|off|status`.
- Destination provisioner: `node tools/ci/backup-resources-cli.ts plan|apply`.

## Prevention

`npm run deploy-guardrails:check` protects the reviewed Durable Object migration
and binding baseline in `tools/ci/durable-object-baseline.json`. Every
`deleted_classes` migration must exactly match
`tools/ci/do-deletion-allowlist.json`; changing that allowlist is the explicit
code-review gate for destructive class deletion. The same check rejects removal
or renaming of protected `new_sqlite_classes` tags, changes to protected
Wrangler binding identities (`name`, `class_name`, `script_name`, or
`environment`), and destructive Cloudflare CLI deletion commands in GitHub
workflows unless the job is operator-triggered with `workflow_dispatch`.
