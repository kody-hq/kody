# Production backup control plane

This package is the DR backup control plane: a dedicated Worker on the DR
Cloudflare account. It seals full backup days, runs isolated paced restore
drills, and runs graduated production restore. It is intentionally separate from
application cron and does not use `DynamicCallableWorkflow`.

D1 data is captured by the paced lane in the production worker (`d1-paced/...`).
The full seal (hourly `:45` cron and the `kody-production-seal-day` Workflow)
requires each `D1_PACED_SOURCES` sealed paced night and signs a schema-v3 full
manifest that lists them under `d1Paced`. See
[docs/contributing/disaster-recovery.md](../../docs/contributing/disaster-recovery.md).

## REST-era days are not restorable

Until #4306 this Worker also exported APP_DB and JOBS_DB nightly through the
Cloudflare D1 export API into `<tier>/d1/<database-uuid>/<yyyy-mm-dd>/`. The
read-only reader for those schema-v1/v2 days was removed on 2026-11-22: restore
rejects a v1/v2 full manifest with `restore-rest-era-day`. The REST objects are
left untouched and expire under R2 lifecycle (`daily/` about 35 days, `weekly/`
about 400 days).

## Credential contract

`CLOUDFLARE_API_TOKEN` (Account D1 Edit on the production account) serves
[live D1 size lookups on the dashboard](./control-plane-ui.ts) and
[graduated production restore](./production-restore.ts), including its
pre-restore safety export. Cloudflare grants that permission account-wide; the
Worker's [source configuration checks](./backup-policy.ts) do not scope the
token to one database. Keep it separate from destination R2 administration and
from drill credentials (`DRILL_API_TOKEN`).

Set `BACKUP_MANIFEST_SIGNING_KEY_ID` and
`BACKUP_MANIFEST_VERIFYING_PUBLIC_KEY_SPKI_BASE64` as reviewed non-secret vars.
Set `BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64` only as a Worker secret;
it must never appear in Wrangler config, logs, manifests, evidence, or signed
URLs.

The operator **Seal day** action enqueues workflow `kody-production-seal-day`
(instance id `seal-day-<day>`) and redirects to `/seal-status`. The hourly
`sealRecentCompleteDays` scan is a synchronous `sealFullBackupDay` call.

## Deploy

GitHub Actions deploys this Worker to the DR Cloudflare account from
`.github/workflows/deploy.yml` (`deploy-backup-control-plane`) when
`packages/backup-control-plane/` or `packages/shared/src/backup-*` change on
`main`. Requires repository secrets `DR_DEPLOY_TOKEN` and
`DR_BACKUP_ACCOUNT_ID`. Manual/emergency:

```sh
CLOUDFLARE_ACCOUNT_ID=<DR_ACCOUNT_ID> \
  CLOUDFLARE_API_TOKEN=<DR_DEPLOY_TOKEN> \
  npm run backup:deploy -- --var "BUILD_COMMIT:$(git rev-parse HEAD)"
```

Worker secrets (`CLOUDFLARE_API_TOKEN`, `DRILL_API_TOKEN`, signing key, restore
secrets) are not synced by that job — set them once with Wrangler / the
Cloudflare dashboard.

## Integrity checks

The isolated paced restore drill replays the sealed paced chains into the drill
account and re-hashes every restored row against the sealed manifest. Graduated
production restore uses the same replay and verification steps and is a
disaster-only path, not a scheduled validation.
