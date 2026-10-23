---
id: auth_setup_git
title: Git credential helper contract (setup-git)
summary:
  Server contract for `kody auth setup-git`: user-owned CLI tokens, `?org=`,
  and persistent HTTPS git auth with a long-lived `kody_at_…` on
  `https://kody.codes/@owner/name.git` (clone, fetch, and push).
category: platform
---

# Git credential helper contract (`kody auth setup-git`)

This page is the **server contract** for the CLI `kody auth setup-git` command
(implemented in `packages/cli`). Persistent HTTPS auth like GitHub's credential
helper: after one setup, clone/pull/push over plain
`https://kody.codes/@owner/name.git` with no re-auth. SSH is out of scope.

## Origin requirements

`kody auth setup-git` installs the helper only when the origin advertises
user-owned tokens:

| Signal                                                       | Meaning                           |
| ------------------------------------------------------------ | --------------------------------- |
| Token metadata includes `org_binding` (`org` \| `user`)      | Origin supports user-owned tokens |
| `cliCredentialBootstrap` redeems yield `org_binding: "user"` | CLI tokens are person-owned       |
| Origin `.git` accepts Basic/Bearer `kody_at_…`               | Persistent git auth               |

If `org_binding` is absent on token metadata, the CLI refuses to install the
helper. There is no `gitCredentialMint` and no `POST /v1/git/credentials`.

## User-owned API tokens

### Behavior

| Token                                         | Org on each request                              | Leaving an org                                         |
| --------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| `org_binding: "org"` (`tokenCreate` default)  | Fixed `org_id` on the token row. Ignore `?org=`. | Org-bound tokens for that org are revoked on leave.    |
| `org_binding: "user"` (CLI bootstrap default) | `?org=<slug-or-id>`; omit → personal org.        | Token stays; membership/grant checks deny immediately. |

The same `kody_at_…` token covers Open API, CapabilityProxy / local execute, and
git HTTPS. Scopes still narrow every call. Revoke with `tokenRevoke` /
`token:delete` (or account token UI); git stops accepting it on the next
request.

### Request org selection

- **HTTP Open API / CapabilityProxy:** query parameter `?org=<slug>` (or org
  id). Do **not** send `X-Kody-Org` — the API edge does not forward custom
  headers.
- **Default:** personal org (person `stable_user_id`).
- **Errors:** inaccessible or unknown `org` → `401 unauthorized` with a message
  that names `?org=`.
- **Git HTTPS:** there is no `?org=` on the git URL. Authz is **user-wide across
  orgs**: the login / MCP org never gates git. Access uses the **resource
  owner's** org (membership or live grant) plus the token's scopes. One
  `setup-git` credential (`org_binding: user`) must open every `@owner/name.git`
  the person can already access in any org. API / MCP calls for `@owner`
  packages still need `?org=` / `--org` when acting in that org.

### Minting

- **`cliCredentialBootstrap` / redeem:** mints `org_binding: "user"`. Redeem
  honors the binding stamped on the code.
- **`tokenCreate`:** defaults to `org` (current request org). Pass
  `"org_binding": "user"` for a person-owned token. An org-bound parent token
  cannot mint a user-owned child.

## Persistent git credentials (credential helper)

`kody auth setup-git` installs a credential helper that stores the user's
long-lived `kody_at_…` (same token as execute/API). Git sends it on every
request; the origin checks it every request. There is **no** short-lived
`kody_gt_…` mint and **no** `POST /v1/git/credentials`.

CLI credential helper output for git:

```
username=x
password=kody_at_…
```

Username may be any non-empty string (convention: `x`). Password is the full API
token. Store it in the helper / OS keychain the CLI configures — same longevity
as the API token (idle/max lifetime; slid on use).

Git config installed by `kody auth setup-git` (CLI side):

```bash
git config --global credential.https://kody.codes.helper '!kody git-credential'
# ensure path is sent:
git config --global credential.https://kody.codes.useHttpPath true
```

## Authenticated git HTTP

Canonical URL:

```text
https://kody.codes/@owner/name.git
```

| Client                                                         | Behavior                                                                    |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Anonymous + public listed package                              | Published snapshot, read-only upload-pack                                   |
| Anonymous + private / missing                                  | `401` + `WWW-Authenticate: Basic realm="kody-git"` (so git asks the helper) |
| Anonymous push                                                 | `401` (challenge)                                                           |
| Basic/Bearer `kody_at_…` with `package:read` + can read target | Live HEAD upload-pack for that package or plain repo                        |
| `package:write` + can write target (read scope optional)       | Live HEAD; Artifacts **write** token; `git-receive-pack` allowed            |
| Authenticated, can read but not write, push                    | `403` with a clear message (clone ok; need `package:write`)                 |
| Valid token, no private access, public listed package (read)   | Same published snapshot as anonymous (helper still sends the token)         |
| Valid token, wrong/private repo with no access                 | `404`                                                                       |
| Invalid / expired / revoked token                              | `401` with a clear message                                                  |

Plain repos need **org-wide** `package:read` / `package:write` (same as
`repoGetGitRemote`). A single-package grant does not open every plain repo under
that owner.

### Push semantics

- **Plain repos:** push updates live HEAD (same as Artifacts write remotes from
  `repoGetGitRemote`).
- **Packages:** push moves live HEAD only. It does **not** auto-publish; publish
  stays an explicit package action.
- Access default: mint an Artifacts **write** token when the caller can write,
  otherwise **read**.

### Authz

Caller must:

1. Hold `package:read` (clone/fetch) or `package:write` (push) on the API token
   scopes. Scopes have no hierarchy (`package:write` does not imply read).
2. Be able to access the target via org membership or a live grant on the
   **resource owner's** org — not the MCP / API login org. Git is user-wide; a
   missing package and a private package the caller cannot access both look like
   `404 repository not found`.

Name collision: if both a package and a plain repo exist under the same
`@owner/name`, a readable **package** wins.

## Out of scope (this contract)

- SSH
- Changing public anonymous snapshot semantics
- Forced migration of existing org-bound `kody_at_…` tokens
- Auto-publish on package push
