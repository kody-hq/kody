# Secret rotation

Procedures for rotating Worker secrets that protect session integrity and
saved-secret confidentiality.

## Key inventory

| Secret                                                 | Purpose                                                                                                                     | Impact of rotation                                                                                                                                                                                                                |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COOKIE_SECRET`                                        | Signs auth session cookies (Remix `createCookie`)                                                                           | Invalidates all active browser sessions; users must re-authenticate.                                                                                                                                                              |
| `SECRET_STORE_KEY`                                     | Derives the AES-GCM KEK for saved secrets in D1                                                                             | Bricks all saved secrets encrypted under the old key unless a re-encryption migration runs.                                                                                                                                       |
| `OIDC_SIGNING_PRIVATE_KEY_PEM` / `OIDC_SIGNING_KEY_ID` | RS256 ID token signing for the MCP OpenID Provider                                                                          | Existing ID tokens verify only against the published JWKS. Rotate by minting a new RSA key + `kid`, deploying both secrets together, then discarding the old private key once outstanding ID tokens expire (1h).                  |
| `PACKAGE_APP_TICKET_KEYS`                              | Signs 90 s package-app access tickets                                                                                       | None when rotated as below. Dropping a key early only sends visitors holding its tickets through one fresh access check.                                                                                                          |
| `ECP_FRAME_SIGNING_KEYS`                               | Signs execution context frames (platform Worker; not yet provisioned, required before the execution contexts feature ships) | None while unset: nothing reads it yet. Multi-key list like `PACKAGE_APP_TICKET_KEYS`: the first entry signs and every unexpired entry is published, so rotate by prepending a new key and dropping the old one after it expires. |

## Separate cookie and secret-store keys

Cookie signing and saved-secret encryption use separate Worker secrets:

- **Cookie signing** uses `COOKIE_SECRET`.
- **Saved-secret encryption** uses `SECRET_STORE_KEY`.

## Rotating `COOKIE_SECRET`

1. Deploy the new `COOKIE_SECRET` value.
2. All active browser sessions are invalidated (expected).
3. Saved secrets remain intact — they are encrypted under `SECRET_STORE_KEY`.

## Rotating `PACKAGE_APP_TICKET_KEYS`

The secret is a comma-separated list. Every key verifies tickets and the first
key signs new ones, so rotation never invalidates a ticket in flight:

1. Prepend the new key: `PACKAGE_APP_TICKET_KEYS=<new>,<old>`. Deploy.
2. Wait at least one ticket lifetime (90 s) after the deploy finishes, so no
   ticket signed with the old key is still valid.
3. Drop the old key: `PACKAGE_APP_TICKET_KEYS=<new>`. Deploy.

When the secret is unset, tickets are signed with a key derived from
`COOKIE_SECRET`, and rotating `COOKIE_SECRET` replaces it too. Tickets are also
bound to the package-app session they were minted under, so invalidating
sessions invalidates their tickets.

## Rotating `SECRET_STORE_KEY`

Rotating `SECRET_STORE_KEY` requires a re-encryption migration because AES-GCM
has no built-in key versioning.

### Escrow

The live key must remain recoverable outside GitHub Actions and the deployed
Worker. Solo escrow seals the key under an operator passphrase
(`SECRET_ESCROW_PASSPHRASE` in the password manager and as a GitHub secret) via
`.github/workflows/dr-escrow.yml`, which uploads
`escrow/secret-store-key.v1.json` to the DR backup bucket. The escrow object is
**write-once**: a second PUT to the same key is rejected, so re-sealing after a
rotation requires bumping `ESCROW_KEY_VERSION` (producing
`escrow/secret-store-key.v2.json`) when running
`tools/disaster-recovery/seal-escrow.ts`. The `dr-escrow.yml` workflow has no
version input today, so run the seal script locally with the new version (or add
the input) and then smoke-test unsealing offline. See
[Disaster recovery](./disaster-recovery.md).

### Procedure

1. **Keep the old key available** in a secure migration script so you can
   decrypt existing ciphertext while preparing the re-encryption pass.
2. **Decrypt all secrets with the old key** and re-encrypt them with the new
   `SECRET_STORE_KEY`. This is a key-rotation migration (old KEK plus new KEK).
   Use a one-off script against D1 before deploying the new `SECRET_STORE_KEY`.
3. **Re-seal escrow** for the new key value with a bumped `ESCROW_KEY_VERSION`
   (see Escrow above — the previous version's object is write-once) and
   smoke-test unsealing offline, so the new key is recoverable before it goes
   live.
4. **Deploy** the new `SECRET_STORE_KEY` only after the re-encryption pass and
   escrow verification are complete.

### Important notes

- Never delete the old key value until re-encryption is verified complete.
- Monitor error rates after rotation; a spike in "Unable to decrypt secret
  value" errors indicates secrets were not re-encrypted with the new key.

## Generating secure key values

Use a cryptographically random string of at least 32 characters:

```sh
openssl rand -base64 48
```
