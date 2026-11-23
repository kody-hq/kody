# Maintenance mode (edge)

Origin has no request-time maintenance flag. `/__maintenance/*` on the origin
worker is a secret-gated operator API, not a public maintenance page. Ingress is
disabled with a Cloudflare Single Redirect on the `kody.codes` zone so the
switch still works when the origin worker or D1 is the thing that is broken,
flips without a deploy, and adds no cost to the request hot path.

```sh
npm run maintenance-mode -- on
npm run maintenance-mode -- status
npm run maintenance-mode -- off
```

`node tools/maintenance-mode.ts <on|off|status>` is the same CLI. `--zone`
defaults to `kody.codes`. `--target` defaults to
`https://status.kody.codes/maintenance`. `--dry-run` prints the Rulesets API
calls without sending writes. `--json` prints machine-readable status.

The token is `CLOUDFLARE_API_TOKEN` with **Zone:Read** and Zone **"Single
Redirect" / Dynamic Redirect: Edit** on `kody.codes`. See
[Operator accounts](../operator-accounts.md). No CI token has the redirect
scope; do not widen an existing token. The first live `on` / `off` is an
operator run with a token that has that scope (`--dry-run` first). The CLI adds
or patches the `kody-maintenance-mode` rule; it does not `PUT` the whole phase
entrypoint, so other Single Redirects on the zone stay put.

What stays reachable on the apex:

- `GET /health` — external uptime check. The rule expression is an exact path
  match, so `/health/components` is redirected.
- `/__maintenance/*` — DR restore, paced D1 status, reindex, PITR, and other
  operator endpoints must stay reachable while ingress is off.

Everything else on `kody.codes`, including `POST /webhooks/stripe`, is a 302 to
the status maintenance page (`preserve_query_string` false). Stripe retries on
3xx and 5xx, so redirecting the webhook is acceptable for the restore window; it
is not excluded.

The public copy lives on the status worker (`GET /maintenance`), which does not
depend on origin D1 or `kody.codes`.

Confirm:

```sh
curl -I https://kody.codes/
# 302 Location: https://status.kody.codes/maintenance
curl --fail --silent --show-error --header "Accept: application/json" \
  https://kody.codes/health
# 200 {"ok":true,...}
```

Turn it off with `npm run maintenance-mode -- off` (the rule stays in the zone
ruleset, disabled, so `status` can still report it). Confirm
`curl -I https://kody.codes/` is no longer a 302 to the maintenance page.
