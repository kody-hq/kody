# Start opt-in deployment

The migration branch stays unmerged. The current production worker remains the
default and keeps its existing custom domain, background jobs and resource
ownership. A separate, immutable Start worker shares the existing production
resources. A routing worker can be activated on `kody.codes/*` after both
workers are verified.

Only the two approved stable person IDs may opt in. Resolve those IDs from the
production accounts for `tannerlinsley` and Kent, review the usernames and IDs
together, then supply the two IDs to the generator. Do not use usernames as
signed identity claims.

## Generate the review bundle

Use an existing, resolved production Wrangler config. Do not run
`production-resources ensure`, a migration command, or any resource provisioning
command for this rollout.

```sh
node tools/ci/start-rollout-config.ts \
  resolved-production.json \
  packages/start-routing-worker/wrangler.jsonc \
  FULL_SOURCE_COMMIT_SHA \
  approved-person-ids.json \
  emitted-asset-paths.json \
  rollout-review.json
```

The last two input files contain JSON arrays. Asset paths must come from the
candidate's emitted client files, relative to its client directory. The router
exposes only those exact static paths beneath `/__start/<release>/`. This list
must never include server function paths.

The output has `candidate`, `router` and `manifest` sections. It is a review
bundle, not a single Wrangler config. Write the two configs to their proper
build locations, preserving relative path resolution. Build the candidate from
the pinned source SHA with its isolated release asset prefix. Replace the source
production `main` and `assets.directory` with the resulting candidate build
paths, and verify the resulting bundle before deployment. Never deploy the old
production entry as the candidate.

The candidate config removes routes, scheduled triggers, queue consumers and
migrations. Existing DO and workflow bindings must already reference their
owning production scripts, otherwise generation fails. Queue producers, database
IDs, bucket names, service entrypoints and external workflow bindings stay
unchanged. Both workers disable workers.dev and preview URLs. The router config
has no routes, so deploying it does not activate traffic routing.

## Secrets and activation

Cloudflare cannot return existing secret values. Obtain the production secrets
from their trusted source and install them on the candidate securely. In
particular, `COOKIE_SECRET` and stored credential encryption keys must match
production. The router needs the same `COOKIE_SECRET` and a separate
`START_ROLLOUT_SECRET` of at least 32 characters. Never rotate live secrets to
make rollout deployment easier. Stop if the existing values are unavailable.

Before activating the zone route, verify the pinned build, shared resource
bindings, session compatibility, protocol routing, exact asset list, allowed
accounts and private cache policy. Verify signed-out requests and a noneligible
account stay on legacy, and each eligible account also stays on legacy until
choosing opt in. Verify opt out returns to legacy and stale Start tabs cannot
bypass the identity checks. Existing session cookies must work on both stacks.

Activation is a separate Cloudflare zone route change. Record the existing route
table before changing it. Removing only the rollout zone route restores the
existing production custom domain immediately. Do not delete or replace the
legacy worker, its custom domain, resources, migrations, secrets or background
consumers.

## Inactive worker deployment mode

The existing production workflow accepts `prepare-start-opt-in` and
`deploy-start-opt-in` on the migration branch. Both require the dispatch SHA to
equal the current open PR 3561 head and require the latest Validate run for that
exact source commit to pass. Neither mode runs the normal production deployment
jobs.

Preparation only produces a review artifact. Inactive deployment builds and
verifies the same isolated release, rereads production bindings to reject
resource drift, and refuses to overwrite any existing candidate or router
worker. The exact names are `kody-start-<full-source-sha>` and
`kody-start-router`.

The deployment step obtains existing production secrets directly from GitHub.
Every live secret name needs an explicit reviewed mapping and a nonempty trusted
value. Cookie and credential encryption secrets are mandatory. Wrangler's
`--secrets-file` supplies secrets with the initial deployment, avoiding a
separate draft worker created by secret sync. The temporary file has mode 0600
and is removed afterward, secret values are not included in artifacts or
application build environment variables. The router gets only the shared cookie
secret and a separate generated, masked rollout secret.

If deployment partially succeeds, another run refuses to overwrite either
existing worker. Review the partial result before deciding how to continue.
Inactive deployment checks that workers.dev and preview URLs remain disabled. It
does not activate the zone route or claim browser parity against the production
data plane.

## Private runtime probe before activation

After inactive deployment, run the probe with the reviewed build still present
and Cloudflare credentials that can create remote development sessions and call
the three service bindings:

```sh
node tools/ci/probe-start-opt-in.ts .tmp/start-opt-in/review.json
```

This starts a temporary `wrangler dev --remote` session with a localhost
listener and bindings to the exact candidate, the inactive router and legacy. It
does not deploy a permanent public probe worker or change routes. The temporary
probe key and Cloudflare preview session output are not printed or stored in
artifacts. The session is stopped and its temporary config removed when the
command finishes.

The probe uses fixed GET requests only. It checks the candidate's exact release
health, legacy health through the default router, complete public documents, an
invalid preference staying on legacy, anonymous opt-in and RPC denial, unknown
asset denial, and emitted CSS and JavaScript bytes through both candidate and
router. Asset bytes must match the reviewed local build exactly. Incoming caller
cookies and authorization headers are never forwarded, and response cookies are
discarded.

This verifies anonymous outsiders, not a signed-in third account. It does not
mint account credentials, sign a preference, enable an account, or claim
logged-in parity. Eligible opt-in and opt-out still need separately authorized
browser checks before route activation is considered complete.

## Route activation and rollback

`activate-start-opt-in` is a separate workflow dispatch mode. Supply the exact
reviewed source SHA and the successful inactive verification run ID in
`start_evidence_run`. The workflow checks the source SHA, latest passing
Validate run and evidence-run provenance before reading production credentials.
It downloads only that run's reviewed config and private runtime proof.
`verify-start-opt-in` can refresh expired runtime proof without redeploying
either worker.

Activation requires proof less than one hour old, with unchanged candidate and
router deployment IDs, version IDs and settings digests. It rereads the two
production account IDs, router service targets, asset list, production database
binding, candidate config and disabled public preview domains. The current
`kody.codes` custom domain must still belong to `kody-production`. Any existing
zone route that overlaps the normal host blocks activation for review.

The only routing mutation adds `kody.codes/*` pointing to `kody-start-router`.
The existing custom domain and route table are captured first. The newly created
route ID is saved immediately in the rollback receipt, then activation verifies
the topology and worker identities again. A failed verification attempts to
remove only that exact new overlay, and preserves the receipt if recovery cannot
be confirmed.

The activation workflow retains the receipt as `start-opt-in-route-<release>`
for 30 days. To roll back, download that receipt and use the trusted Cloudflare
credentials with the same account and zone:

```sh
node tools/ci/start-opt-in-routing.ts rollback /path/to/route-receipt.json
```

Rollback refuses a changed route ID, pattern or script. It deletes only the
recorded `kody.codes/*` route owned by `kody-start-router`. It does not replace
a route table, redeploy workers, or touch the legacy custom domain, data,
secrets or background jobs.

`rollback-start-opt-in` provides the same exact-route deletion through GitHub's
trusted Cloudflare credentials. Set `start_release` to the original activation
source SHA and `start_evidence_run` to the activation run that retained the
receipt. It verifies that receipt's provenance and contents before reading
production credentials. Recovery does not depend on current PR head, fresh
runtime proof or green CI, so a later broken build cannot block removal of the
existing overlay. The recovery code is pinned to the dispatch commit, while the
receipt remains pinned to the original activated release.

Receipt updates use atomic writes, so a failed update preserves the previous
snapshot. If Cloudflare accepts route creation but its response is lost, the
tool reports an unknown outcome and stops. Use the retained pre-activation
snapshot to inspect the exact `kody.codes/*` route and `kody-start-router`
ownership before recovery. Never retry creation blindly or delete unrelated
routes to resolve that state.

The review artifact also retains `secret-names.json`, containing names only.
Secret preflight reports every missing mapping and unavailable trusted value
together, before creating either worker. Documented production DR settings use
their existing GitHub sources and are copied only when the live worker inventory
contains them. The broader DR provisioning token is never copied. If a live
secret was configured manually in Cloudflare and has no trusted GitHub source,
stop and provision its existing value through the approved secret source. Do not
skip it, guess a replacement, rotate the legacy worker, or treat an unrelated
secret as a fallback.

The DR exclusion is an ownership boundary, not a missing-value fallback.
`DR_RESTORE_SECRET`, `DR_BACKUP_ACCESS_KEY_ID`, `DR_BACKUP_SECRET_ACCESS_KEY`,
`DR_BACKUP_ACCOUNT_ID` and `DR_BACKUP_BUCKET_NAME` serve the legacy maintenance
handlers and scheduled exporter. `origin-handler.ts` mounts DR
restore/export/PITR/mailbox import beneath `/__maintenance/`, and the routing
worker always forwards that namespace to legacy. Start website routes and server
functions do not import the DR modules, and the candidate has no scheduled
triggers or queue consumers. Those five values are never supplied to the
candidate, even if available in GitHub. The complete live inventory still
participates in drift checks, and every other unknown or unavailable website
secret blocks deployment. Turnstile's existing site/secret pair remains required
whenever present in live inventory because native website auth forms use it.

The router bundles the exact release asset list in its generated source entry.
Only the SHA-256 digest of its sorted JSON list is stored in a text binding.
Activation verifies this digest against the reviewed manifest and the proven
immutable router version. No asset path prefix or wildcard grants access. Before
creating either worker, deployment checks all text and secret bindings against
Cloudflare's 5120 byte limit and dry-runs the router build.

`verify-start-opt-in` uses the current validated PR head as its controller,
while `start_release` selects an existing validated inactive release. Set
`start_evidence_run` to the original deployment run. Its inactive deployment
step must have succeeded, even if its later probe failed. Verification downloads
that run's exact review, receipt, and built assets. It does not rebuild or
redeploy.

For activation, use the successful verification run as `start_evidence_run` and
keep the same target `start_release`. The current controller and historical
target must both have green validation. Activation checks the verification
controller's provenance, original deployment receipt, and fresh immutable worker
proof.

Each new release creates its own immutable `kody-start-router-<full SHA>`
worker. The review manifest, runtime proof, activation route, and rollback
receipt pin that exact name. Existing inactive candidate and router workers are
preserved. The historical c85 release alone supports its original stable router
name during verification, it cannot use the new activation path.
