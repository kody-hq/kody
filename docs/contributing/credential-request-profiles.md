# Approved request profiles

A Key's request profile describes how `credential(key).fetch()` builds a
specific request. See
[Approve an exact request](../guides/credentials.md#approve-an-exact-request)
for the website flow. The profile JSON describes locations, not secret values.

- **Body:** Pin the package, HTTPS endpoint, method, and JSON fields. The
  [body schema and request preparation](../../packages/worker/src/credentials/body-placement.ts)
  check the caller's JSON and any resource selectors before resolving values. A
  GraphQL profile supplies the operation document and name; the caller supplies
  variables. A sealed-box profile supplies a recipient public key, key ID, and
  key ID field.
- **Path:** Pin the package, HTTPS origin, method, and a path template with one
  credential segment. The
  [path schema](../../packages/worker/src/credentials/path-placement.ts) also
  supports typed caller parameters (slug, integer, or UUID).
- **Composition:** Attach multiple credentials to one package, method, and
  endpoint. The
  [composition schema](../../packages/worker/src/credentials/credential-composition.ts)
  describes header, Basic auth, query, JSON body, and Login or OAuth connection
  sites. Save the same profile on each participating Key and call the need
  mapped to its entry Key.

## Tracking legacy fills

Use the site-admin
[`adminLegacyCredentialUsage` capability](../../packages/worker/src/mcp/capabilities/admin/admin-legacy-credential-usage.ts)
to review legacy fill counts by placement, surface, mode, and outcome for a
window of up to seven days. The capability also counts active name-based webhook
and provider settings. The
[`credential.legacy_fill` audit writer](../../packages/worker/src/credentials/legacy-fill-audit.ts)
records site counts, not credential values.
