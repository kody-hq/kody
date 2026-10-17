# Webhooks

Owner-only management of inbound webhook URLs. Webhooks belong to the package
that declares them (`package.json#kody.webhooks`), so mint, reveal + copy,
rotate, disable, and enable live in that package's settings. MCP never returns
the credential URL.

## How to get there

`/@<username>/<kodyId>/settings#webhooks` (package page → Settings → Webhooks
section) renders one card per declared webhook; `#webhook-<name>` targets one
card.

`/@<slug>/-/webhooks` (account rail → Webhooks) is a read-only index across
packages; each row deep-links to the card above.

Generic `http` `webhookUrlApply` destinations require owner Allow at
`/connect/webhook-apply?handle=…&fingerprint=…` (same approval family as
`/connect/secrets`). Every apply destination uses this page.

## Drive it

```bash
npm run control-kody -- browse --origin <preview> --path /@<username>/<kodyId>/settings
```

Native server functions handle list, mint, rotate, reveal, enable, disable, and
apply approvals. Lists never include credential URLs. Only an explicit mint,
rotate, or reveal returns a URL, using the preview host. Older mints without
encrypted secrets cannot reveal. Verify owner denial and the read-only account
index separately. `/connect/webhook-apply` presents the destination and approves
or rejects the pending grant. External webhook delivery URLs remain HTTP ingress
protocols.

## Gotchas

- Seed users own no packages, so both surfaces are empty until a saved package
  declares a webhook. Publish one with `kody.webhooks` first (the MCP
  `webhookList` capability sees the same rows).
- The settings section loads its rows after the settings shell (same as Share);
  hash deep links wait for it.
- `mint` on an already-minted webhook is a 400 (“Rotate it”); the card only
  shows Mint for unminted rows. Rotate and Disable are double-check buttons.
  Rotate keeps the previous URL active for 24 hours, or until the first accepted
  delivery arrives on the new URL; the card shows “Previous URL active until …”
  during that overlap. Only enabled cards show the overlap row.
- `reveal` on a mint without `url_secret_encrypted` is a 400; the card offers
  Rotate instead.
- Seed accounts have no pending apply grants. To exercise
  `/connect/webhook-apply`, mint a webhook and call `webhookUrlApply` with
  `type: "http"` from interactive MCP as that user, then open the returned
  `approval_url`.
- Every intent writes an `account` audit event (`webhook_url_reveal`, …).
- HMAC for GitHub-style hooks is **package-owned** on the webhook URL record
  (`hmac_secret_encrypted`), minted when verification omits `secretName`. It is
  not listed in account secrets and never needs a secret→host Allow.
  `{{webhookSecret}}` apply injects that material (or a
  `verification.secretName` copied onto the endpoint at mint/rotate).
  Destination Bearer `secretName` needs host Allow. Provider-issued secrets
  (Sentry, …) use `verification.secretName` in the secret store.
