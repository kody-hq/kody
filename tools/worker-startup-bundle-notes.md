# Startup bundle measured notes

Append-only ledger of reviewed `maxEntryBytes` bumps. Live ceilings live in
`tools/worker-startup-bundle-budget.json`. Append a new measurement here; do not
re-flow older notes when you bump a number.

Byte overages no longer fail CI: `tools/check-worker-startup-bundles.ts` warns
and upserts a tracking GitHub issue on main pushes. Keep this ledger honest when
you intentionally raise a ceiling.

## origin

Vite production entry. Reviewed ceiling 7_750_000.

## platform

Waiting first-use probes (search, memory, execute, package, job, integration,
secret, Discord membership) ship on platform because waitingSummary runs in the
MCP Durable Object. UserMeter schema v12 inbound MCP last-used RPCs add a few KB
(CI dry-run 4_992_191). Keep last-used on this class; do not add a second DO.

- Package-app `kody.app.client` browser bundling and `/_assets/*` serving
  (publish rebuild and packageAppFetch both run here) add ~12 KB on top: local
  dry-run 5_004_707 bytes.
- emailDestination list/add/set-default/remove plus emailSend destination
  resolution add ~23 KB: local dry-run 5_028_263 bytes.
- MCP OAuth token-recovery persist/stamp on McpClientHub (refresh before wipe,
  durable last_error when a previously-ready server parks authenticating) adds
  ~2 KB: CI dry-run 5_036_978 bytes.
- Package publish stamps identity-icon derivatives from
  finalizePublishedEntitySource: local dry-run 5_046_681 bytes.
- MCP connection-event ack-by-id plus last_error keep-until-ready on
  McpClientHub: CI dry-run 5_050_804 bytes.
- MCP OAuth sidecar refresh-token preserve (merge omitted RT, restore when
  client_id missing, remint/invalidate delete sidecar, nested discovery refresh
  advertising): CI dry-run 5_063_749 bytes.
- Provider-secret placeholders on the shared fetch-gateway path (bindings,
  grants, sealed resolve) plus the MCP OAuth sidecar preserve: local dry-run
  5_088_887 bytes.
- Search package export headings (`package:{id}#{subpath}`) add a few hundred
  bytes: local dry-run 5_095_156 bytes.
- communityForkAdopt interactive-MCP gate (refuse package-runtime self-adopt of
  user-secret read): local dry-run 5_096_278 bytes.
- Destination-verify Cloudflare delivery index (email_destination_verification)
  on the shared add/resend path: local dry-run 5_097_119 bytes.
- Jev search experiment (a since-removed feature flag registry entry plus shared
  search list wiring) spilled ~5 KB into the platform entry: CI measured
  5_102_980 bytes against the previous 5_098_000 budget.
- List-mode search `serverTiming` (execute-shaped `{ name, durationMs }`
  including `jevRerank`) adds a few hundred bytes: CI dry-run 5_105_268 against
  the previous 5_105_000 budget.
- Jev Score question batching (merge/parse plus expected/received errorReason)
  adds a few hundred bytes on top of that wiring.
- Per-user MCP/meta search abuse rate limits (burst + daily D1 checkRateLimit
  before embeddings/Jev, not an entitlement) add ~2 KB: local dry-run 5_112_004
  against the previous 5_110_000 budget.
- First-pass package export candidates (`package:{id}#{subpath}` promotion +
  bounded hydrate) add a few KB on top of that wiring: prior CI dry-run
  5_112_939 against 5_110_000 before the rate-limit bump; keep headroom for
  both.
- Paid Jev necessity + high-confidence export call-contract attach spill into
  platform: CI/local dry-run 5_120_066 against the previous 5_118_000 budget.
- Search list dual-channel parity (markdown carries the same actionable
  export-contract / next-step / notices substance as structured): CI dry-run
  5_124_196 against the previous 5_124_000 budget.
- Export parent-identity fold, close top-K promotion, and adaptive Jev keep
  spill into platform: local dry-run 5_126_440 against the previous 5_126_000
  budget.
- First-seen search funnel claim sits on the shared activation stamp that
  platform search already calls: local dry-run 5_128_692 against the previous
  5_128_000 budget.
- MCP execute `invoke` codegen (flag-gated schema field, specifier parse, thin
  passthrough) spilled ~3 KB into the platform entry: CI dry-run 5_133_007
  against the previous 5_130_000 budget.
- File fragment anchors (`#L165`, `#L165-L180`, markdown heading slugs) on
  search entity, repoReadFile, and package file open pull line-anchor and
  file-anchor into platform: registers search, and esbuild keeps the lazy
  repo/coding domains in this same entry, so line-anchor and file-anchor cannot
  stay on runtime alone. CI dry-run 5_145_618 against the previous 5_135_000
  budget.
- Allowlisted kody:runtime facades and the .**kody_virtual** guards ride the
  same module-graph code: local dry-run 5_147_977 against the previous 5_146_000
  budget (main measured 5_145_651 locally).
- Background-lane suspension gate (same modules as runtime) adds ~1.1 KB on top:
  local dry-run 5_149_225 against the previous 5_149_000 budget.
- Opaque packageSecrets.get + share-grant remap / derived-ops on the platform
  startup graph: local dry-run 5_151_668 against the previous 5_150_000 budget.
- Sibling daily automation quota (`automation_invocations_per_day`) spills into
  the platform MCP invoke graph. Combined with opaque secrets on main: local
  dry-run 5_153_557 against the previous 5_153_000 budget.
- Jev paid ranked-search exposure recording (dedicated site + shared evaluation
  cache on MCP search) on the same entry: local dry-run 5_155_481 against the
  previous 5_154_000 budget.
- Specifier-aware .**kody_virtual** build check (bundler-resolved specifier
  collector incl. require(), JSON value walk) adds ~1.9 KB: local dry-run
  5_157_613 against the previous 5_156_000 budget.
- Protocol v1 Artifacts ref discovery and the bounded git HTTP client also sit
  on the platform artifacts graph: CI dry-run 5_159_055 against the previous
  5_159_000 budget.
- Execute static-import secret stamp (shared root-runtime external + sync stamp
  capture / AsyncFunction ALS) spills into the platform MCP execute graph: CI
  dry-run 5_160_693 against the previous 5_160_000 budget (#2575).
- Reviewed ceiling 5_162_000.
- `webhookSyntheticDispatch` (interactive-MCP synthetic webhook smoke test)
  extends the webhooks MCP domain platform already evaluates: local dry-run
  5_172_095 against the previous 5_162_000 budget. Reviewed ceiling 5_182_000.
- Remix 3.0.0 updates the `remix/data-schema` helper reached through the
  platform entry's `MCP` import: local dry-run 5,237,192 versus main/rc.2 at
  5,236,571, against the previous 5,237,000 budget. Reviewed ceiling 5,238,000.

## runtime

Listing-only helpers live in the shared secrets service module
(resolveSecretListScopeOrder / listSecretBucketsByScope). Runtime does not call
them, but they sit in the same module as resolve and add a few KB. Share-grant
import/storage routing added more. secretJwtSign JWA families (HMAC/PSS/ES plus
extra RSA hashes) add ~0.5KB. Split listing out of service.ts if this budget is
raised again.

- Package-app `/_assets/*` serving (fingerprinted client module, static assets
  directory) runs here: local dry-run 3_701_307 bytes. Package-app runtime
  (mounted-URL dispatch in the wrapper source and runtime resolution) adds ~11
  KB: local dry-run 3_712_214 bytes.
- emailSend destination resolution (verified extras plus default) lives on the
  shared outbound send path: local dry-run 3_725_245 bytes.
- Repo/package list marks (`refreshIdentityIconForSource` on `repo.pushed`) add
  identity-icon keying and the existing community icon ingest path: local
  dry-run 3_736_186 bytes.
- RunLog `inspectSqlBilling` (content-free admin SQL snapshot) adds
  PRAGMA/COUNT/EXPLAIN helpers on the DO class: CI measured 3_741_747 bytes
  against the previous 3_740_000 budget.
- Provider-secret placeholders on the shared fetch-gateway path
  (`{{secret/<provider>:<ref>}}`, sealed resolve, grants) pull
  secret-providers/service.ts into runtime: CI dry-run 3_768_307 bytes against
  the previous 3_745_000 budget.
- Flag-gated Jev Score search rerank (`search-jev-rerank.ts` plus list-mode
  wiring) added ~2.4 KB: CI measured 3_782_433 bytes against the previous
  3_780_000 budget.
- Jev Score question batching (merge/parse plus expected/received errorReason)
  adds ~2 KB: local dry-run 3_784_520 bytes against the previous 3_785_000
  budget.
- Gateway envelope unwrap plus incomplete-answer key sampling adds a few KB: CI
  dry-run 3_788_951 bytes against the previous 3_788_000 budget.
- First-pass package export candidates spill shared search package plugin code
  into runtime: CI dry-run 3_793_904 against the previous 3_792_000 budget.
- Paid Jev necessity + high-confidence export call-contract attach adds a few
  KB: CI dry-run 3_798_379 against the previous 3_795_000 budget.
- Feature-flag `experiments_opt_in` audience (users.experiments_opt_in batch
  read + gate) measured ~1.3 KB on the prior base (CI dry-run 3_796_324); fits
  within this headroom after the paid-Jev bump.
- Export parent-identity fold, close top-K promotion, and adaptive Jev keep
  (`selectJevKeptCandidates`) add ~1.3 KB: local dry-run 3_803_286 against the
  previous 3_802_000 budget.
- First-seen execute/search/secret/job funnel claim lives on the shared
  activation-stamp module that runtime execute already calls: local dry-run
  3_806_157 against the previous 3_805_000 budget.
- Onboarding ecosystem count plus Cursor Local/Cloud grant labels sit on the
  inbound grant path runtime already loads: CI dry-run 3_808_070 against the
  previous 3_808_000 budget.
- Module-local secret-authority ALS (no Symbol.for runner) plus the sealed
  reinstallable getter: CI dry-run 3_809_234 against the previous 3_809_000
  budget (local dry-run 3_808_685).
- File fragment anchors (`#L165`, `#L165-L180`, markdown heading slugs) on
  search entity, repoReadFile, and package file open pull line-anchor and
  file-anchor into runtime: CI dry-run 3_820_542 against the previous 3_810_000
  budget.
- Allowlisted kody:runtime facades, the .**kody_virtual** build rejection, and
  the hardened computed import() guard: CI dry-run 3_822_747 (local 3_822_879
  with the node_modules rewrite) against the previous 3_821_000 budget.
- Opaque packageSecrets.get + share-grant owner remap / derived-ops parsing on
  the runtime startup graph: CI dry-run 3_824_901 against the previous 3_824_000
  budget.
- Background-lane suspension gate (`AccountSuspendedError` in the background
  resolver, package-invocation 403 mapping, realtime connect, per-hook, and
  emit/broadcast checks, pre-ledger invoke check, non-retryable workflow step)
  adds ~1.1 KB on top: local dry-run 3_824_132 against the previous 3_824_000
  budget (main). Combined with opaque-secrets graph growth: raise reviewed
  budget to 3_828_000.
- Sibling daily automation quota (`automation_invocations_per_day`) on
  package-invocation module-execution pulls entitlement consume into runtime.
  Combined with opaque-secrets + suspension on main: local dry-run 3_828_451
  against the previous 3_828_000 budget.
- Jev paid ranked-search exposure recording (dedicated site + shared evaluation
  cache helpers on the search path that runtime already loads) on the same
  entry: local dry-run 3_830_371 against the previous 3_829_000 budget.
- Specifier-aware .**kody_virtual** build check (bundler-resolved specifier
  collector incl. require(), JSON value walk) adds ~1.9 KB: local dry-run
  3_832_503 against the previous 3_831_000 budget.
- Protocol v1 Artifacts ref discovery and the bounded git HTTP client sit on the
  artifacts module runtime already loads: CI dry-run 3_834_166 against the
  previous 3_834_000 budget.
- Execute static-import secret stamp: shared root-runtime external (one ALS)
  plus sync stamp capture before recordFetch (#2575): CI dry-run 3_835_583
  against the previous 3_835_000 budget.
- Reviewed ceiling 3_837_000.
- `webhookSyntheticDispatch` (interactive-MCP synthetic webhook smoke test)
  lands in the same webhooks MCP domain graph runtime already evaluates: local
  dry-run 3_846_966 against the previous 3_837_000 budget. Reviewed ceiling
  3_857_000.
- Generic `webhookUrlApply` http destination plus `/connect/webhook-apply`
  owner-approval grants land on the same webhooks MCP domain graph runtime
  already evaluates: CI dry-run 3_862_510 against the previous 3_857_000 budget.
  Reviewed ceiling 3_863_000.
- Auth-token redaction for webhookUrlApply http destinations plus MCP
  Authorization conflict checks grew the runtime entry: CI dry-run 3_863_102
  against the previous 3_863_000 budget (plus local auth-redaction helpers).
  Reviewed ceiling 3_870_000.
- Generic `webhookUrlApply` http destination + `/connect/webhook-apply` approval
  UI spill into the platform entry (shared web/connect graph): CI dry-run
  5_188_429 against the previous 5_182_000 budget. Reviewed ceiling 5_190_000.
- `DynamicWorkerUsageTail` (Worker Loader CPU tail, `dynamic_worker_cpu`) is a
  loopback export on every executor surface, including platform: CI dry-run
  5_190_394 against the previous 5_190_000 budget. Reviewed ceiling 5_191_000.
- Cloudflare-measured Durable Object duration on admin user usage (loader data,
  `admin-user-usage` capability schema, measured-duration helpers) spills into
  the platform entry: local dry-run 5_191_729 against the previous 5_191_000
  budget. Reviewed ceiling 5_192_000.
- Caller-disconnect finish for keyed package invocation and execute (claim-time
  started log, `client_disconnected` error, inbound request AbortSignal on the
  executor) lives on the platform MCP path: local dry-run 5_194_432 against the
  previous 5_192_000 budget. Reviewed ceiling 5_195_000.
- Named `client_disconnected` execute finish plus DO-reset backoff abort
  normalization on the runtime execute path: local dry-run 3_870_105 against the
  previous 3_870_000 budget. Reviewed ceiling 3_871_000.
- Disconnect finish fence-loss replay (`ledgerUpdated: false` →
  `resolveLedgerRecord`) on the keyed package-invocation path: local dry-run
  5_195_108 against the previous 5_195_000 budget. Reviewed ceiling 5_196_000.
- Prepaid credits (#2617): wallet-aware entitlement resolution (`creditWallet`,
  `proCreditsPlanLimits`, credits CTAs in limit hints, and the `credits.ts` /
  compute-include credits copy) is on every runtime quota check: local dry-run
  3_881_704 against the previous 3_871_000 budget. Reviewed ceiling 3_882_500.
- Prepaid credits (#2617) on the platform MCP path: wallet-aware entitlements
  plus the `adminCreditGrant` / `adminCreditWalletGet` capabilities and the
  admin credit-grant service: local dry-run 5_206_765 against the previous
  5_196_000 budget. Reviewed ceiling 5_207_500.
- Admin credit eligibility (`adminCreditEligibilitySet`,
  `users.admin_credits_eligible`, and the shared `hasStoredCreditsEligibility`
  resolver, and `forgiveCreditUsageBeforeUnlock`): platform local dry-run
  5_210_356 against the previous 5_207_500 budget, reviewed ceiling 5_211_000;
  runtime local dry-run 3_885_335 against the previous 3_882_500 budget,
  reviewed ceiling 3_886_000.
- Include → credits → stop (decision 0051): the empty-wallet past-include stop
  in `consumeDailyEntitlement` and `assertWithinComputeInclude`
  (`resolvePastIncludeStop`, the monthly `usage_rollups` reader, the reworded
  `ComputeOverageLimitError` message, and the package-app `429` pause page) runs
  on every quota check and hosted app request: runtime local dry-run 3_888_294
  against the previous 3_886_000 budget, reviewed ceiling 3_889_000; platform
  local dry-run 5_213_315 against the previous 5_211_000 budget, reviewed
  ceiling 5_214_000.
- Publish typecheck of `package.json#exports` (#2609): export entrypoints join
  the typecheck targets, and packages with a root `tsconfig.json` get semantic
  diagnostics for every reachable source file (`collectReachableSourceFilePaths`
  walk, bare-specifier diagnostic filter, flattened message chains) in
  `repo/checks.ts`, which the runtime entry reaches through repo publish:
  runtime local dry-run 3_890_654 against the previous 3_889_000 budget,
  reviewed ceiling 3_891_500; platform local dry-run 5_215_619 against the
  previous 5_214_000 budget, reviewed ceiling 5_216_500.
- Named-only package exports (#2670): `buildKodyModuleBundle` detects entries
  without a default export (`moduleSourceDeclaresDefaultExport`, which also
  drops local re-exports of type-only bindings) and emits a no-default callable
  entry with an actionable invoke error instead of failing the bundle: runtime
  local dry-run 3_892_662 against the previous 3_891_500 budget, reviewed
  ceiling 3_893_500; platform local dry-run 5_217_626 against the previous
  5_216_500 budget, reviewed ceiling 5_218_500.
- Search latency budgets (#2673): Jev Score abort budget (`fallback-timeout`),
  the fixed package-hydration cap, the bounded Waiting block, and
  `runWithSearchDeadline` / `SearchDeadlineError` on the shared search path, on
  top of #2670: runtime local dry-run 3_893_620 against the previous 3_893_500
  budget, reviewed ceiling 3_894_500; platform local dry-run 5_218_689 against
  the previous 5_218_500 budget, reviewed ceiling 5_219_500.
- Computed `kody:@` import Gate 2 (#1750): host `__kodyComputedPackageImport`
  bridge, `createComputedPackageImportTools`, and the library-load call bundle
  for caller-owned importable modules land on the runtime and platform evaluate
  paths (rebased onto #2673): local dry-run runtime 3_898_846 / platform
  5_224_029 against the post-#2673 floors; reviewed ceilings 3_899_500 /
  5_225_000.
- Execute `search` capability execution-level `serverTiming` (#2684): the
  capability now reconciles its phases like the MCP tool, which pulls
  `reconcileSearchPhaseTimings` (previously tool-runner only, platform) into the
  runtime entry, plus `rateLimit` / `featureFlags` tiles: runtime local dry-run
  3_900_006 against the previous 3_899_500 budget (main measured 3_899_073),
  reviewed ceiling 3_900_500; platform local dry-run 5_224_698 stays under
  5_225_000.
- metaMemory subject/summary/details max-length error messages and JSDoc
  (#2704): shared field schemas with `must be at most N characters, got M`
  errors plus documented max lengths on capability search types: platform CI
  dry-run 5_225_141 against the previous 5_225_000 budget (local dry-run
  5_224_911), reviewed ceiling 5_226_000.
- Confirmed destructive overwrite history replace (#2703): orphan-root publish
  plus advertised `sessions/*` ref cleanup after promote on repo-session-do
  (shared with platform publish path). CI dry-run platform 5_226_226 against the
  previous 5_226_000 budget, reviewed ceiling 5_226_500.
- Bound MCP search onboarding notice courtesy budget (#2716 / KODY-8B):
  `SEARCH_ONBOARDING_NOTICE_BUDGET_MS` plus `settleWithBudget` around
  `buildOnboardingSearchNotice` (same pattern as waiting items). Local/CI
  dry-run platform 5_226_510 against the previous 5_226_500 budget, reviewed
  ceiling 5_227_000.
- Repo session unified-diff line limit (KODY-8E / #2717):
  `maxRepoSourceFileDiffLines` preflight + EFBIG remap on `applyWorkspaceEdits`
  and MCP caller-failure classification for the stable / raw phrases. Local / CI
  dry-run platform 5_227_844 against the previous 5_227_000 budget, reviewed
  ceiling 5_228_000.
- Signup welcome credits (#2720): Stripe unlock now calls
  `forgiveCreditUsageBeforeUnlock` from `refreshStripePlanForUser` so
  Free-period usage is not charged against the $5 welcome balance; that pulls
  more of the credit-wallet forgive path into runtime via subscription-sync.
  Local dry-run runtime 3_902_482 against the previous 3_901_500 budget,
  reviewed ceiling 3_903_500; platform local dry-run 5_229_587 against the
  previous 5_228_000 budget, reviewed ceiling 5_230_500. Signup grant helpers
  live in `signup-welcome-credits.ts` so they stay off the debit graph.
- Package-owned webhook HMAC (#2724): endpoint `hmac_secret_encrypted` mint /
  resolve helpers on the webhooks MCP graph runtime already evaluates: local /
  CI dry-run runtime 3_905_392 against the previous 3_903_500 budget, reviewed
  ceiling 3_905_500; platform local dry-run 5_232_529 against the previous
  5_230_500 budget, reviewed ceiling 5_233_000.
- Wajo / Cue / OpenMuse / Dots agent marks (#2718): onboarding MCP client kinds,
  DIY connect panels, and walkthrough host catalog entries pull additional agent
  labels/help URLs into the origin/runtime shared onboarding graph CI already
  evaluates. CI dry-run runtime 3_905_770 against the previous 3_905_500 budget,
  reviewed ceiling 3_906_500; platform CI dry-run 5_233_076 against the previous
  5_233_000 budget, reviewed ceiling 5_233_500.
- Transitive static `kody:@` dependency provenance (#2697): the
  `collectTransitiveKodyDependencies` reachable-export walk in
  `module-graph-workspace.ts` plus `isDirectBundleDependency` filters on the
  execute, meter, and artifact-staleness paths. Local dry-run runtime 3_909_311
  against the previous 3_907_500 budget, reviewed ceiling 3_910_000; platform
  local dry-run 5_236_503 against the previous 5_235_000 budget, reviewed
  ceiling 5_237_000.
- Remix 3.0.0 migration, including the D1 order-direction helper imported by the
  runtime, adds 1,694 bytes to the runtime startup graph: local dry-run
  3,911,073 versus main/rc.2 at 3,909,379, against the previous 3,910,000
  budget. Reviewed ceiling 3,912,000.
- Connect-time OAuth refresh policy (#2739): `refresh-policy.ts` inference, the
  `not_applicable` refresh skip, `refresh_policy` mapping and stale-snapshot
  filtering, and the `integrationTokenRefresh` `refreshed` / `skippedReason`
  output on the integrations graph both workers already evaluate (about 890
  bytes per worker over main). Local dry-run runtime 3_912_325 against the
  previous 3_912_000 budget, reviewed ceiling 3_912_500; platform local dry-run
  5_238_445 against the previous 5_238_000 budget, reviewed ceiling 5_238_500.
- Per-PR Artifacts namespace for restorable preview package source (#2764 /
  #2749): hybrid REST Artifacts client (`CLOUDFLARE_ARTIFACTS_API_TOKEN` + real
  `api.cloudflare.com` when the binding is present), env-schema token wiring,
  and related platform startup graph growth on top of #2739. Local / CI dry-run
  platform 5_238_546 against the previous 5_238_500 budget, reviewed ceiling
  5_238_600. Production `assertRestorablePackageSourceSnapshot` is unchanged.
- Per-PR Artifacts env-schema token (`CLOUDFLARE_ARTIFACTS_API_TOKEN` from #2764
  / #2749) also spilled into the shared runtime startup graph, and the same
  #2764 platform measurement sat 109 bytes under the local/CI dry-run after
  merge: runtime 3_912_588 against the previous 3_912_500 budget, reviewed
  ceiling 3_912_700; platform 5_238_709 against the previous 5_238_600 budget,
  reviewed ceiling 5_238_800. Production `assertRestorablePackageSourceSnapshot`
  is unchanged.
- Open API + MCP `api` tool + scoped API tokens: the platform `MCP` Durable
  Object registers the flag-gated `api` tool, which reaches the Open API
  operation catalog (`packages/worker/src/open-api/`, `api-tokens/`). The tool
  loads that graph through a memoized dynamic `import()`, so esbuild wraps it
  and nothing evaluates until the first `api` call; bytes grow, startup CPU does
  not. Local dry-run platform 5_275_466 against the previous 5_238_500 budget,
  reviewed ceiling 5_276_000. Runtime gains the `kody_at_` redactor on execute
  output and the two flag registry entries: local dry-run 3_913_497 against the
  previous 3_912_500 budget, reviewed ceiling 3_914_000. Review fixes (rotation
  scope check, debounced sliding expiry) add about 100 platform bytes: local
  dry-run 5_276_098, reviewed ceiling 5_276_500. Splitting CapabilityProxy
  capability errors (per-call secret redactor) from generic platform failures
  adds about 870 more: local dry-run 5_277_132 (5_277_389 with #2764), reviewed
  ceiling 5_277_500.
- Startup byte overages no longer fail Static / block Deploy: the checker warns
  and upserts a deduped GitHub tracking issue on main CI pushes instead.
- Drop unused Zod v4 locale barrels from Worker bundles
  (`patches/zod+4.6.6.patch`): `zod/v4/classic/external.js` re-exports
  `../locales/index.js`, which previously pulled ~50 locale modules into every
  Worker that imports `zod`. Kody only applies English via that classic entry.
  Local dry-run runtime 3_720_975 against the previous 3_914_000 budget (closes
  #2819 overage), reviewed ceiling 3_722_000; platform 5_107_102 against the
  previous 5_277_500 budget (also clears #2811), reviewed ceiling 5_108_000.
  Origin Vite entry unchanged at 3_480_403.
- Local-execute inlined-CAF rewrite + CapabilityProxy shim source builders
  (#2830) deferred to `local-execute-runtime-support.mjs` additional module
  (same lane as oauth-provider / worker-bundler) so platform main no longer
  carries those templates or the rewrite AST walk. Clears #2831 overage
  (measured 5_123_062). Local dry-run platform 5_104_954 against the previous
  5_108_000 budget, reviewed ceiling 5_106_000.
- Teams access (grants, invites, members, teams), org soft-delete, and org
  billing sit on the platform entry. Those domains already load through dynamic
  import() in `builtin-domains.ts`, which defers startup CPU, and esbuild keeps
  the modules in this same entry. Local dry-run 5_118_387 against the previous
  5_106_000 budget (#3092). Reviewed ceiling 5_120_000.
- Credentials, orgs, entitlements, and admin MCP work since that teams ceiling
  (#3122, `02d71171e`) landed on the platform and runtime entries. A rebuild of
  that SHA with this checker measures platform 5_064_015 and runtime 3_627_141.
  The ledger's 5_118_387 for the same SHA does not reproduce here;
  `packages/shared` grew only ~0.6 KB, so that gap is not the shared package.
  Entry growth from that rebuild to `c225c1136` is platform +160_156 and runtime
  +146_603, in code those entries already evaluate. esbuild keeps MCP capability
  domains in the same entry (dynamic `import()` defers startup CPU only), and
  the fetch gateway, package codemod registry, entitlements, and package runtime
  are static. Largest clusters on both workers: MCP capabilities (admin
  enablements migrate and importable-artifact backfill, secret placement, echo
  redaction, org/access/repo updates, downstream MCP truncation) ~38–44 KB; orgs
  (offboarding, soft-delete, repo) ~16 KB; enablements backfill ~15 KB;
  `resolveCredential` plus placement and audit ~11 KB; codemod `0010` on the
  existing codemod registry ~10 KB; entitlements (plans, limit overrides, meter,
  execute admission on platform) ~11–15 KB; package runtime and
  hub/email/integrations the rest. No one import is accidental or large enough
  to remove without splitting that graph. Local dry-run matches CI on
  `c225c1136`: platform 5_224_171 against the previous 5_120_000 budget, runtime
  3_773_744 against the previous 3_722_000 budget (still the Zod-locale ceiling;
  #3122 did not remeasure runtime). Reviewed ceilings platform 5_226_000 and
  runtime 3_775_000.
- Enablements run-as-enabler (#3334) merged to main after that measurement and
  before the #3360 squash (`dd443918e`, parent `e3437fec5`). It sits on both
  entries with subscription dispatch, jobs, request context, and webhook
  delivery. `resolveCredential` shrank when raw credential slots reverted
  (#3351). Local dry-run of `ff1a50c84`: platform 5_242_175 (+18_004 over the
  5_224_171 measurement, 16_175 over the 5_226_000 ceiling) and runtime
  3_791_764 (+18_020 over 3_773_744, 16_764 over the 3_775_000 ceiling).
  Reviewed ceilings platform 5_244_000 and runtime 3_793_500.
- Org resource transfer (`adminOrgResourceTransfer`, `org-transfer/`, codemod
  `0011`) adds platform +42_788 (5_296_799 → 5_339_587) and runtime +40_776
  (4_000_556 → 4_041_332) over main `763ceeba1`, which was already over both
  ceilings. The engine sits in the lazily evaluated admin capability domain, so
  it adds bytes, not startup CPU. Ceilings unchanged; main's existing overage
  issues track the reset.
- Reset under both ceilings without raising them (#3367, #3368). The Ajv MCP
  output validator is test-only and moved to `test-support/` (production tools
  type-import `mcp-tool-output.ts`, which kept its top-level validator on
  runtime, about 145 KB with ajv's deps). postal-mime and codemode's
  acorn-backed `normalizeCode` load from deferred additional modules, and
  `patches/acorn+8.17.0.patch` marks acorn side-effect free (about 80 KB and 123
  KB on each entry). Local dry-run of main `40280a610`: platform 5_328_864 and
  runtime 4_029_466. After: platform 5_124_654 and runtime 3_680_395.
  `wrangler check startup` best-of-3 active CPU drops from about 116 to about
  104–112 ms on platform and from about 63 to about 57–58 ms on runtime.
  Ceilings unchanged.
