# Private edge comparison

Use `lighthouse-edge.mjs` only after both private deployments and their Access
policies are ready. It makes no deployments, changes no Cloudflare resources and
never purges caches.

Provide Access service-token headers through `EDGE_ACCESS_HEADERS_JSON`, keyed
by exact HTTPS origin. Load this from a protected environment source, never put
credential values in command arguments, committed files or reports. The harness
accepts only `CF-Access-Client-Id` and `CF-Access-Client-Secret`. Tokens are
attached through request interception only to their configured origin and
stripped from cross-origin requests. Global Lighthouse `extraHeaders` would risk
forwarding credentials to third-party assets, so this harness does not use them.

```sh
node tools/framework-comparison/lighthouse-edge.mjs BASELINE_HTTPS_ORIGIN CANDIDATE_HTTPS_ORIGIN NEW_OUTPUT_DIRECTORY LIGHTHOUSE_PACKAGE_DIRECTORY 5
node tools/framework-comparison/summarize-lighthouse.mjs NEW_OUTPUT_DIRECTORY
```

The installed official Lighthouse package supplies its own desktop preset,
report generator and Puppeteer dependency. Pin Lighthouse and Chrome versions
for every comparison. Fresh browser contexts and Lighthouse's default storage
reset produce cold-browser audits. The paired target order reverses on alternate
runs. Do not run other builds, tests or browser work during timing.

The preflight requires application HTML and rejects redirects or Access login
responses. Both origins must have explicitly configured credentials. Reports are
generated in memory, secret strings and raw header containers are removed before
JSON or HTML reaches disk. Separate delivery reports retain only response
status, cache flags, content encoding/length, cache-control, Age, Vary,
CF-Cache-Status, CF-Ray and Server-Timing. They do not retain Cookie, Set-Cookie
or authorization fields. No HAR, trace or raw DevTools log is written.

Before accepting results, establish the following matching conditions:

- Same Cloudflare account, deployment region policy, Access policy type and
  routing arrangement.
- Same immutable backend data, feature flags, external service behavior and
  image proxy cache inputs.
- Same optimization mode, bindings, compatibility date and compression settings.
- Same Chrome, Lighthouse settings and test machine, with one audit running at a
  time.
- Both main documents actually render their expected application content, and
  the emitted runtime guard passes on the candidate build.

Cache terminology matters. Preflight requests already warm document paths. A
fresh browser does not establish cold CDN, cold Worker isolate or cold backend
storage. The harness labels edge state uncontrolled and records observed cache
headers. It must not label these results cold edge or global cold start. A
separate intentionally warmed-edge series may preload both targets' document and
discovered same-origin assets before starting a fresh paired series, but should
be labeled separately. Do not purge production caches to simulate cold state. An
actual cold-edge experiment would need isolated versioned resources, agreed
cache policy and proof of MISS behavior for the resources being compared.

Use the existing local runs only as context. Final acceptance should compare the
two edge targets measured together, retaining five samples per home/pricing/docs
and mobile/desktop cell, every failure and the exact deployed source/runtime
patch fingerprint. Run a one-pair smoke first to verify Access handling,
response compression and report sanitization, then use a fresh directory for all
sixty audits. Lower Lighthouse scores require inspection of FCP/LCP, resource
waterfalls, response latency and bytes before attributing a framework
regression.

Both isolated private fleets have now passed live content, Access, delivery and
authenticated browser checks. The final deployment is recorded in
`reports/measurements/edge-final-applied/deployment.json`; paired navigation
results are in `reports/measurements/edge-final-flows/SUMMARY.md`. The final
direct-load series uses applied DevTools throttling, selected with
`EDGE_THROTTLING_METHOD=devtools`. These scores are not interchangeable with
default simulated Lighthouse or PageSpeed Insights scores.

The private gate also affects Lighthouse's separate robots.txt check, which
receives Access sign-in HTML. Keep that SEO deduction visible and identify its
cause; do not weaken privacy to improve a score. Public page scores do not
establish signed-in data freshness, tenant isolation or external OAuth/billing
parity. The benchmark service token was disabled after measurements finished and
is confirmed rejected with 401 on both origins. Its local credential file was
removed. The human Access policy and previews remain available.
