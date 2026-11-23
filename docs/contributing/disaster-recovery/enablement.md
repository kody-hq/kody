# Solo enablement checklist

Work top-to-bottom. Leave gates false until the matching gate item is done.

## 1. Accounts and destination

- [ ] DR Cloudflare account exists and is administered separately from
      production.
- [ ] Production source identities recorded: account id, APP_DB UUID/name
      (`kody`), JOBS_DB UUID/name (`kody-jobs`), Worker origin, R2 bucket names.
- [ ] Drill account id differs from production; recorded as `DRILL_ACCOUNT_ID`.
- [ ] Provisioner plan/apply creates the private DR bucket with `daily/` (35d)
      and `weekly/` (400d) lock/lifecycle rules; provisioner token never becomes
      a Worker secret.
- [ ] Checked-in CLI trust registries populated via code review when you want
      offline drills/readiness (optional if UI-only, recommended).

## 2. Manifest keys and Access

- [ ] Ed25519 manifest keypair generated; public SPKI + key id committed as
      reviewed vars; private PKCS#8 only as control-plane Worker secret.
- [ ] Zero Trust Access application fronts the control-plane hostname; policy
      allows only `me@kentcdodds.com`; `ACCESS_*` vars match that app.
- [ ] Control-plane secrets set: `CLOUDFLARE_API_TOKEN`,
      `BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64`, `DRILL_API_TOKEN`,
      `RESTORE_CONFIRM_SECRET`, `DR_RESTORE_SECRET`.

## 3. Deploy control plane (still gated off)

- [ ] Placeholders in `packages/backup-control-plane/wrangler.jsonc` replaced;
      both enable vars remain `"false"`.
- [ ] `DR_DEPLOY_TOKEN` is set; optional R2-admin `DR_BACKUP_ADMIN_TOKEN`
      reconciles policy when accessible and logs a non-blocking skip otherwise;
      the control plane deploys to the DR account; `BACKUP_BUCKET` bound;
      Workflows `kody-production-dr-restore`,
      `kody-production-paced-restore-drill`, and `kody-production-seal-day`
      present; public bucket access off.
- [ ] UI loads only through Access; unauthenticated and wrong-email JWTs
      get 403.

## 4. Production exporter wiring

- [ ] Production Worker vars/secrets: `DR_EXPORT_ENABLED` (leave unset/false
      until ready), `DR_BACKUP_ACCOUNT_ID`, `DR_BACKUP_BUCKET_NAME`,
      `DR_BACKUP_ACCESS_KEY_ID`, `DR_BACKUP_SECRET_ACCESS_KEY`,
      `DR_RESTORE_SECRET` (same value as control plane).
- [ ] Control plane `PRIMARY_WORKER_ORIGIN` points at production.
- [ ] Set `DR_EXPORT_ENABLED=true` in production. The exporter skips nightly and
      manual runs while the gate is off.
- [ ] The first completed staging export (nightly, or finished by daytime
      catch-up) writes `staging/{day}/exporter/summary.json` with acceptable
      warnings; verify the mailbox and RunLog indexes and at least one
      referenced owner dump against the recorded byte count and SHA-256.

## 5. Enable the seal schedule

- [ ] The isolated paced restore drill passes for the latest sealed paced base.
- [ ] Set `BACKUP_BENCHMARK_APPROVED` and `ENABLE_PRODUCTION_D1_BACKUPS` to
      `"true"` and redeploy control plane.
- [ ] Observe the first sealed day after staging completes.

## 6. Escrow and ongoing drills

- [x] `SECRET_ESCROW_PASSPHRASE` in password manager + GitHub secret; run
      `dr-escrow.yml`; dashboard shows escrow present; run
      `node tools/disaster-recovery/unseal-escrow.ts --input <sealed-blob> --output <secure-path>`
      against the sealed blob with the real passphrase, offline (proven
      2026-08-07 — see the [live evidence log](./evidence-log.md) /
      [#1091](https://github.com/kentcdodds/kody/issues/1091)).
- [ ] Monthly: UI isolated paced restore drill; confirm alert paths for
      freshness failures.
- [ ] Quarterly: seal verification + verify every Mailbox owner dump against its
      sealed index + spot-check StorageRunner/R2/artifact restore into a
      non-production target (or full UI production restore only during a real
      incident, after a fresh drill of the day being restored; leave the drill
      day empty to replay the newest day from the last week that every paced
      source sealed).
- [ ] After material schema/storage/encryption changes: extra drill before
      trusting the newest sealed day.
