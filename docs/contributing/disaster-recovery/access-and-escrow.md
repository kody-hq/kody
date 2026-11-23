# Disaster recovery credentials and escrow

Which credential lives where, how the Admin UI is guarded, and how
`SECRET_STORE_KEY` is escrowed. Start at the
[disaster recovery index](../disaster-recovery.md).

## Credentials and Access

No single credential should both erase production and erase the retained backup.

| Credential                   | Where                                                                                       | Purpose                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Source Account D1 Edit token | Control-plane secret `CLOUDFLARE_API_TOKEN`                                                 | Pre-restore safety export + production D1 import               |
| DR R2 provisioner token      | Operator env only (`backup-resources-cli`)                                                  | Bucket / lock / lifecycle setup — never a Worker secret        |
| Production → DR S3 keys      | Production Worker secrets `DR_BACKUP_ACCESS_KEY_ID` / `DR_BACKUP_SECRET_ACCESS_KEY`         | Stage into the DR bucket                                       |
| Drill D1 Edit token          | Control-plane secret `DRILL_API_TOKEN`                                                      | Create/import/query/delete drill D1 in `DRILL_ACCOUNT_ID` only |
| Restore confirm HMAC         | Control-plane secret `RESTORE_CONFIRM_SECRET`                                               | Short-lived (10 min) prepare→execute token                     |
| Production restore bearer    | Both sides: `DR_RESTORE_SECRET`                                                             | Control plane → `POST /__maintenance/dr-restore`               |
| Manifest signing key         | Control-plane secret `BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64`                     | Sign full-backup manifests                                     |
| Escrow passphrase            | Operator password manager only (`SECRET_ESCROW_PASSPHRASE` in GitHub for the seal workflow) | Unseal `SECRET_STORE_KEY`                                      |

Admin UI auth is dual-layer:

1. Cloudflare Zero Trust Access in front of the control-plane Worker (policy
   pinned to `me@kentcdodds.com`).
2. In-worker verification of `Cf-Access-Jwt-Assertion` against the team JWKS,
   requiring `ACCESS_TEAM_DOMAIN`, `ACCESS_APP_AUD`, and `ACCESS_ALLOWED_EMAIL`
   (same allowlisted address). Mutating POSTs also require
   `Sec-Fetch-Site: same-origin`.

The control-plane Worker deploys to the DR account from GitHub Actions
(`.github/workflows/deploy.yml` → `deploy-backup-control-plane`) using
`DR_DEPLOY_TOKEN`, when `packages/backup-control-plane/` or shared backup
contracts change on `main` inside the 15-commit path-filter lookback (or on
manual `workflow_dispatch`). A longer Validate gap can skip that job while
`main` still has the change; dispatch Deploy on current `main` HEAD to force it.
Local Wrangler against the DR account remains available for emergencies
(`npm run backup:deploy`). Production restore requires the DR Worker to hold the
production-account D1 token as above; Access + JWT guard every UI action that
could use it.

## Secret escrow

`SECRET_STORE_KEY` is the AES-GCM KEK for saved secrets in D1. Restoring D1
without the exact key makes ciphertext unreadable. The plaintext key lives in
GitHub Actions secrets and the deployed production Worker; it must also be
recoverable if those are lost.

Escrow model (solo):

1. Operator passphrase lives only in the personal password manager (also stored
   as GitHub secret `SECRET_ESCROW_PASSPHRASE` for the seal workflow).
2. Manual `workflow_dispatch` of `.github/workflows/dr-escrow.yml` seals the key
   with PBKDF2-SHA-256 (600k iterations) + AES-256-GCM and uploads
   `escrow/secret-store-key.v1.json` to the DR bucket
   (`tools/disaster-recovery/seal-escrow.ts`). The escrow object is write-once;
   after a `SECRET_STORE_KEY` rotation, bump `ESCROW_KEY_VERSION` (for example
   `v2`) when re-sealing — see [Secret rotation](../secret-rotation.md).
3. Dashboard presence does not prove that the passphrase recovers the key. Copy
   the sealed blob to an offline environment and run:

   ```sh
   node tools/disaster-recovery/unseal-escrow.ts \
     --input /secure/input/secret-store-key.v1.json \
     --output /secure/output/secret-store-key
   ```

   The tool reads `SECRET_ESCROW_PASSPHRASE` or prompts without echo. It creates
   the output with mode `0600`, refuses repository paths and existing files, and
   emits no secret metadata. The output parent directory must already exist.
   `ESCROW_INPUT_PATH` and `ESCROW_OUTPUT_PATH` are the environment equivalents
   of the two flags. Omit `--output` only when writing the recovered key
   directly to stdout is intentional. To read from the DR bucket instead of a
   local file, omit `--input`, set the DR bucket credentials, and select the
   sealed object with `ESCROW_KEY_VERSION` (default `v1`).

Never put the plaintext key or passphrase in manifests, tickets, logs, or the
backup SQL. See [Secret rotation](../secret-rotation.md).
