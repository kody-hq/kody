# Private Cloudflare comparison deployment

`prepare-private-deployment.mjs` only reads and writes local configuration. It
never provisions, builds, deploys, reads credentials, or changes Access
policies. Run it with Node 26 and a private JSON manifest. Do not commit
credentials or the populated manifest. The root deployment operator owns all
remote commands.

Use two independent checkouts and fleets. Baseline source must remain commit
`8b2528460`; candidate must record its source snapshot and Redact patch hash.
The build uses production optimization with isolated preview bindings, not the
shared production resources.

## Manifest

```json
{
	"accountId": "explicit-personal-account-id",
	"privacyReady": false,
	"outputDirectory": "/tmp/kody-private-deployment",
	"fleets": [
		{
			"variant": "baseline",
			"name": "kody-branch-compare-remix",
			"checkout": "/tmp/kody-framework-baseline",
			"origin": "https://kody-branch-compare-remix.ACCOUNT.workers.dev",
			"configs": [],
			"resources": {
				"d1Ids": [],
				"kvIds": [],
				"buckets": [],
				"queues": [],
				"vectorIndexes": [],
				"datasets": [],
				"artifactNamespaces": [],
				"rateLimitIds": []
			}
		},
		{
			"variant": "candidate",
			"name": "kody-branch-compare-start",
			"checkout": "/absolute/path/to/candidate",
			"origin": "https://kody-branch-compare-start.ACCOUNT.workers.dev",
			"configs": [],
			"resources": {
				"d1Ids": [],
				"kvIds": [],
				"buckets": [],
				"queues": [],
				"vectorIndexes": [],
				"datasets": [],
				"artifactNamespaces": [],
				"rateLimitIds": []
			}
		}
	]
}
```

After provisioning, fill each resource list with the exact returned IDs and
chosen isolated names. Add each generated config as
`{"worker":"kody-branch-compare-start", "path":"packages/worker/wrangler-preview.generated.json"}`.
Include jobs bootstrap, platform bootstrap, runtime, full platform, full jobs,
highlight, mock and optional API configs. Run the preparation tool again after
building, with the emitted Vite origin config included. An optional
`buildOutput` overrides the recorded output path, it does not change Vite's
build directory.

The tool strips inactive environments, rejects foreign service/DO references,
unknown resource IDs/names, custom routes and package-app/legacy hostnames. It
writes sibling `.private.generated.json` files to preserve relative paths. Only
these checked files should be deployed. Resource allowlists are
operator-provided provisioning records, not proof that a supplied ID belongs to
the account.

## Ordered execution

Run these steps separately inside each checkout, with explicit
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ENV=preview`, and an authorized token
supplied through the environment. Never print the token or put it in command
arguments.

1. Use the plan's `preview-resources.ts ensure` and
   `jobs-worker-resources.ts ensure` argument arrays. These are remote
   mutations, the preparation tool does not execute them. This creates
   app/audit/jobs D1, OAuth/bundle KV, three R2 buckets, queues and Artifacts.
   Preserve their returned inventory.
2. Provision an isolated capability Vectorize index with the repository's
   embedding model dimensions/metric. Assign per-fleet Analytics Engine dataset
   names and rate-limit namespace IDs. Existing preview generators leave these
   shared. Override these in the origin config before generating siblings.
3. Generate runtime with
   `tools/ci/runtime-worker-config.ts generate --env preview --main-config ORIGIN --worker-name NAME-runtime --main-worker-name NAME --platform-worker-name NAME-platform --out-config RUNTIME`.
4. Generate platform with
   `tools/ci/platform-worker-config.ts generate --env preview --main-config ORIGIN --worker-name NAME-platform --runtime-worker-name NAME-runtime --main-worker-name NAME --out-config PLATFORM --out-platform-bootstrap-config BOOTSTRAP`.
   These generators also rewrite the origin's references. Generate the API edge
   with `tools/ci/api-worker-config.ts` only if testing its separate hostname.
5. Prepare and audit all configs with the local tool. Apply APP_DB and AUDIT_DB
   migrations against the checked origin config, JOBS_DB against checked jobs,
   using
   `node wrangler-env.ts d1 migrations apply BINDING --remote --config FILE`.
6. Deploy highlight, jobs bootstrap without HOST, platform bootstrap without
   runtime references, runtime, then full platform. Use
   `node wrangler-env.ts deploy --config CHECKED_FILE --name EXACT_WORKER_NAME`.
   Keep every public trigger disabled. A fresh fleet must use fresh-class
   migrations, never production class transfers from another script.
7. Sync fresh secrets using the existing `tools/ci/sync-worker-secrets.ts` flow.
   Cookie/encryption secrets must agree within a fleet, not across fleets. Use
   test integration credentials. Do not send real email or charge real Stripe
   accounts. The only current mock worker is Cloudflare; its missing token means
   open access, so configure a fresh MOCK_API_TOKEN before exposing it. Existing
   full-app external integrations still require corresponding test credentials.
8. Build with `NODE_ENV=production`, `CLOUDFLARE_ENV=preview`, and
   `KODY_WRANGLER_CONFIG=CHECKED_ORIGIN`. Run `npm run build` in each checkout.
   Audit the emitted Vite config with this tool, preserve slim-origin migration
   stripping, then deploy that checked emitted config directly. The Start origin
   emits `dist/server/wrangler.json`; the archived Remix baseline emits
   `dist/ssr/wrangler.json`.
9. Deploy full jobs after origin exists. Seed equivalent disposable users/data
   using `tools/seed-test-data.ts --remote --config CHECKED_ORIGIN` with private
   credentials. Record source/build hashes and resulting deployed version IDs.
10. Establish hostname-based Access on both exact origin hostnames, including
    service-token access for the measurement operator. Confirm the policy before
    setting `privacyReady:true`. Regenerate checked configs and enable only the
    origins. Verify unauthenticated HTML, JS, images and fonts are blocked,
    authenticated assets work, alternate version URLs are disabled, and app
    WebSocket connections work. Run these checks again after secret updates.

Hostname Access preserves WebSockets. Worker-level Access currently rejects
WebSocket upgrades. Protecting the hostname also covers assets served before
application middleware. Service-only workers remain `workers_dev:false` and
`preview_urls:false`; service bindings do not need public HTTP hostnames. A mock
requiring outbound HTTP needs a separately approved private-access design, not
an implicit public exception. Package-hosting and separate API-hostname tests
also need explicitly approved routing outside this origins-only plan.

Reference:
[Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).

Use identical Access policy, data, flags and deployment settings for
measurements. The benchmark operator must scope authentication headers to these
origins, avoid logging credentials, and exclude Access login pages from
Lighthouse results.

The candidate origin must include `version_metadata` with binding
`CF_VERSION_METADATA` in its build input and emitted Wrangler config. Anonymous
HTML cache keys use the running Worker version ID, so a release cannot replay
older HTML that references assets removed by a new deployment. The reserved
`__worker_version` query parameter is overwritten internally. Other query
parameters still distinguish content. A missing binding bypasses the HTML cache.
This does not change the immutable Remix comparison deployment.
