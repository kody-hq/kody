# App fetch

`appFetch` calls a hosted package app you can run, as you: one HTTP request to
the fetch handler `kody.app.entry` exports, answered with status, headers, and
body. It is the one sanctioned way for an agent to use an app. It works for apps
in any org you belong to and for apps another org shared with you.

**It is a real visit with real side effects.** It goes through the same access
check and the same serve path as a person opening the app in a browser: same
package runtime, `packageStorage()`, secret mounts, billing, and "Run as me"
confirmation. Each call is an `app_fetch` run in [Activity](./activity.md) and
counts in the publisher's Visitors list.

The agent guide is [Using apps as an agent](../guides/agent-apps.md).

## Who may call it

- Interactive MCP, `execute`, the Open API (`POST /v1/apps/fetch`), and the CLI
  (`kody app fetch`).
- The caller needs `app:execute` on that app in the org that owns it. A profile
  token also needs the grant on every layer of its profile chain, and the
  token's scopes must include `app:execute`.
- Code running inside a package app, a job, or a trigger cannot call it.

## Call shape

```json
{
	"app": "@acme/board"
}
```

| Field        | Default | Meaning                                                               |
| ------------ | ------- | --------------------------------------------------------------------- |
| `app`        |         | `@org/app`, or the app's hosted URL. `appList` returns it             |
| `package_id` |         | The app's package id, instead of `app`                                |
| `path`       | `/`     | Path **after** the app mount (what the handler sees)                  |
| `method`     | `GET`   | HTTP method                                                           |
| `headers`    | `{}`    | Extra request headers (safe subset)                                   |
| `body`       | omitted | Raw request body string for `POST` / `PUT` / `PATCH`, up to 100 KB    |
| `synthetic`  | `false` | `true` marks a smoke test with the `Kody-Synthetic: true` header      |
| `max_bytes`  | 102400  | Most response bytes to return. Up to 10485760 on the Open API and CLI |

Pass `app` or `package_id`. The lookup uses the org the address names, not the
org your connection is bound to, which is what lets a shared app in another org
work.

Example POST with JSON:

```json
{
	"app": "@acme/board",
	"path": "/api/items",
	"method": "POST",
	"headers": { "content-type": "application/json" },
	"body": "{\"name\":\"smoke\"}"
}
```

From the CLI:

```sh
kody app fetch @acme/board /api/items --method POST \
  --header "content-type: application/json" --body @item.json
kody app fetch https://board--acme.kody.run/export.csv --out export.csv
```

The CLI sends your token to the Kody API only. The app's hosted URL is an
address here; nothing is sent to it. When the address names the org, `--org` is
not needed, and a different `--org` is refused.

Websocket upgrade requests (`Upgrade: websocket`, `Connection: Upgrade`, or
equivalent) are rejected.

## Response

| Field           | Meaning                                                   |
| --------------- | --------------------------------------------------------- |
| `status`        | HTTP status code                                          |
| `headers`       | Response headers (safe allowlisted subset)                |
| `body`          | Response body text, or base64 for binary content          |
| `body_encoding` | `text` or `base64`                                        |
| `truncated`     | `true` when the body was cut to fit the response size cap |

Over MCP the body always stops at 102,400 bytes, whatever `max_bytes` asks for.
The Open API honors `max_bytes` up to 10,485,760; `kody app fetch --out <file>`
asks for that and writes the body to the file.

A host-setup 500 (`Package app could not be prepared`) includes `cause` with the
platform error. Host-setup failures happen before the isolate starts, so they do
not appear as `app_fetch` run errors.

## Identity

The app sees the person: `metaGetCurrentUser()` and `X-Kody-Visitor` carry the
same `user_id` as a browser visit. When a profile token makes the call they also
carry `profile: { id, name }`; `profile` is `null` otherwise. The run record
carries the profile chain.

A visitor-need credential (`credential.visitor()`, `visitorNeed`) resolves with
the caller's own narrowing. A profile reaches it only when its chain was granted
Use on that credential, whatever the person allowed in a browser.

## Consent

An agent never approves anything for the person. When the app still needs the
person's one-time "Run as me" confirmation, or a visitor need the person has not
allowed, the call fails with:

```json
{
	"error": {
		"code": "app_consent_required",
		"message": "...",
		"details": {
			"consent": "run_as_me",
			"consent_url": "https://kody.codes/..."
		}
	}
}
```

`consent` is `run_as_me` or `visitor_need` (with `need`). Give `consent_url` to
the person; they open it once in a browser, and the same call then works. The
call itself records nothing.

## Synthetic smoke tests

After a publish, `test_hints.app` gives an `appFetch({ ..., synthetic: true })`
call to copy. `synthetic: true` is the only way the `Kody-Synthetic: true`
header is set; a caller-supplied `Kody-Synthetic` header is stripped. The
handler still runs with real side effects, so handlers treat a synthetic fetch
like production unless a deliberate guard says otherwise. Synthetic fetches do
not count as visitor traffic.

## Semantics

- Strips credential headers (`Cookie`, `Authorization`, and internal `X-Kody-*`
  headers) before the handler runs, the same rule as public package-app ingress.
- Populates `packageContext` (`hostedUrl`, `appBasePath`) from the owning org
  and package name leaf.
- Bills like a browser visit: a member's visit bills the owning org, a shared
  cross-org visit bills the visitor's own org, and a public app bills its
  publisher.
- Does **not** count toward package activation milestones.

## Platform assets under `/_assets/`

`appFetch` goes through the same serve path as the browser, so on a host that
serves platform client assets, `path: "/_assets/__version.json"` returns the
current `clientModuleUrl` and `path: "/_assets/<file>"` returns files from
`kody.app.assets`; the fetch handler is never invoked for those paths. A 404 on
`/_assets/__version.json` means the host does not serve client assets yet, not
that the handler is broken; see
[Troubleshooting](../guides/package-apps.md#troubleshooting).

## Related

- [Using apps as an agent](../guides/agent-apps.md)
- [Packages](./packages.md): package apps and `hosted_app_url`
- [Profiles](./profiles.md): scoped identities and their grants
- [Synthetic event dispatch](./synthetic-event-dispatch.md): post-publish smoke
  test for one subscription handler
- [Package apps guide](../guides/package-apps.md): session handoff, asset URLs,
  lean forks
- Decision:
  [Synthetic package requests](../contributing/decisions/0013-synthetic-package-requests.md)
