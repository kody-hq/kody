# CLI streaming gateway-fetch contract

Contract for `@kodycodes/cli` (`packages/cli`) to implement
`kody.gatewayFetchStream` on the local workerd host. The workerd shim in
`packages/worker` calls this method; the CLI host performs the HTTP hop and
returns a real `Response`.

This is a **native Open API route**, not `POST /v1/capability-proxy/call` with
`path: ['kody', 'gatewayFetch']`. Keep that JSON hop for small buffered bodies.
The package-facing promises (body types, memory, errors, retries) are in
[Credentials: large bodies on local execute](../../guides/credentials.md#large-bodies-on-local-execute).

Hosted gateway streaming fill (origin / `fetch-gateway` in this repo) is out of
scope for the CLI agent. Direct-upload host tokens are out of scope; the gateway
remains the default.

## Route

```
POST https://api.kody.codes/v1/capability-proxy/gateway-fetch
```

Local-execute HTTP, same class as the other CapabilityProxy surfaces
([ADR 0055](../decisions/0055-cli-mcp-oauth-local-execute-http.md)).

## Auth

Same as other capability-proxy routes:

- `Authorization: Bearer kody_at_…` with `org:execute`, or
- a valid `kody login` CLI MCP OAuth access token (official CLI CIMD client) as
  Bearer, full MCP grant, no API-token scope check.

`X-Kody-Gateway-Package-Id`, when present, is a claimed package stamp: origin
verifies `package:execute` for that id (same as JSON `gatewayFetch`).

Do **not** put the Kody API credential in `X-Kody-Gateway-Headers`. That
`Authorization` stays on the Open API request.

## Request

The Open API request body **is** the outbound fetch body: raw bytes, streamed,
no JSON wrapper, no base64.

All hop metadata lives in **allowlisted headers**. The edge strips every other
`X-Kody-*` header and never forwards `Cookie`.

| Header                      | Required                          | Role                                                                                                                                                                                                   |
| --------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `X-Kody-Gateway-Url`        | yes                               | Absolute outbound URL. May contain literal `{{secret:…}}` / `{{integration-token:…}}` placeholders.                                                                                                    |
| `X-Kody-Gateway-Method`     | no                                | Outbound method. Default `GET`.                                                                                                                                                                        |
| `X-Kody-Gateway-Package-Id` | no                                | Claimed package stamp (`package:execute`).                                                                                                                                                             |
| `X-Kody-Gateway-Headers`    | no                                | JSON object of outbound header name → string value. May include placeholders (for example outbound `Authorization: Bearer {{secret:…}}`). Invalid JSON or non-string values are `400 invalid_request`. |
| `x-kody-secret-resolution`  | no                                | `on` (default) \| `headers-only` \| `off`. Same control header as hosted fetch; origin strips it before the request leaves.                                                                            |
| `Content-Type`              | when the outbound request has one | The **outbound** `Content-Type` (`multipart/form-data; boundary=…`, `application/json`, …).                                                                                                            |
| `Content-Length`            | when the size is known            | Byte length of the raw outbound body. Otherwise use chunked transfer.                                                                                                                                  |

`Authorization` on this POST is the Kody credential only. Outbound
`Authorization` belongs in `X-Kody-Gateway-Headers`.

Set `Content-Type` on the Open API request to the outbound value. Do not also
put a conflicting `Content-Type` in `X-Kody-Gateway-Headers`.

### Duplex

Send the body as a `ReadableStream` (or other streaming source) with duplex
streaming so the client can read the response while the request body is still
flowing. In Node/undici that is `duplex: 'half'`:

```ts
await fetch('https://api.kody.codes/v1/capability-proxy/gateway-fetch', {
	method: 'POST',
	headers: {
		Authorization: `Bearer ${token}`,
		'X-Kody-Gateway-Url': url,
		'X-Kody-Gateway-Method': method,
		'Content-Type': contentType,
		...(packageId ? { 'X-Kody-Gateway-Package-Id': packageId } : {}),
		...(outboundHeaders
			? { 'X-Kody-Gateway-Headers': JSON.stringify(outboundHeaders) }
			: {}),
		...(resolution ? { 'x-kody-secret-resolution': resolution } : {}),
	},
	body: requestBodyStream, // raw outbound bytes; may be multipart
	duplex: 'half',
})
```

Keep the existing CapabilityProxy client timeout (7 minutes from CLI 1.13.1) so
the gateway's 5-minute deadline is what ends a slow fetch.

## Response

A successful hop returns the **upstream HTTP response**: status, headers, and
body, streamed back. It is **not**
`{ status, statusText, headers, bodyBase64 }`.

Reconstruct a real `Response` for workerd and return it from
`kody.gatewayFetchStream`:

```ts
return new Response(upstream.body, {
	status: upstream.status,
	statusText: upstream.statusText,
	headers: upstream.headers,
})
```

Null-body statuses (`101`, `103`, `204`, `205`, `304`) keep a null body, same as
the JSON hop.

### Errors before upstream

Failures that happen before origin sends the request upstream use the standard
Open API JSON envelope `{ error: { code, message } }` with the usual codes
(`invalid_request`, `unauthorized`, `insufficient_scope`, `payload_too_large`,
and so on; see [Open API errors](../architecture/open-api.md#errors)),
`Cache-Control: no-store`, and `X-Kody-Gateway-Error: <code>`. That header is
how the host tells Kody's own error from an upstream JSON error with `no-store`;
only a marked response throws. The CLI bridge marks its own failures the same
way and adds `mayHaveReachedOrigin` to the envelope. Package code gets a
`KodyGatewayError`, never a successful `Response`, for these.

Once origin has a status from upstream, the hop returns that status, those
headers, and that body — including upstream 4xx/5xx — as the real `Response`.

Cloudflare may emit a **raw** `413` (not the JSON envelope) for an oversized
chunked body. Treat a non-JSON `413` as payload too large.

## Size

This hop has **no 4 MiB cap**. Respect the Cloudflare Worker upload limit: about
**100 MiB** on Free/Pro.

- If `Content-Length` exceeds the documented Worker limit, origin or the edge
  returns JSON `413 payload_too_large` with an actionable message that **names
  the limit**.
- Chunked bodies have no `Content-Length` to check up front. Cloudflare may
  still close the request with a raw `413` once the upload exceeds the platform
  cap.

The JSON `gatewayFetch` hop keeps its 4 MiB request- and response-body cap, but
the shim only sends it bodies up to `maxGatewayFetchJsonHopBodyBytes` (3 MiB,
`packages/worker/src/open-api/api-body-limits.ts`): base64 of that plus 1 MiB of
envelope headroom fits the 5 MiB `maxApiRequestBodyBytes`. A raw 4 MiB body is
5,592,408 bytes as base64 alone, so it streams.

## Shared gateway policy

Same as hosted fetch gateway (`executeGatewayFetch`):

- Echo redaction: substituted values are replaced with `[REDACTED SECRET]` in
  response headers, status text, the final URL after redirects, and the body
  (also URL-encoded, form-encoded, and JSON-escaped forms). `content-length` is
  dropped when the body length changes. Range responses are masked `*` byte for
  byte.
- Deadlines: 5 minutes overall from when origin sends the request upstream, plus
  abort after 60 seconds with no bytes.
- Host and approval checks: HTTPS only; placeholder in the URL host or user info
  is refused; unapproved host is refused before any credential resolves.
  `x-kody-secret-resolution` is stripped before the request leaves.

The CLI host does not re-implement fill, redaction, or host checks. Origin does
that. The host streams bytes and reconstructs `Response`.

## Host method the shim calls

The workerd shim (kody repo, package-graph runtime) calls:

```ts
kody.gatewayFetchStream({
	packageId?: string
	request: {
		url: string
		method?: string
		headers?: Record<string, string>
		body?: ReadableStream<Uint8Array> | null // raw body; may be multipart
		signal?: AbortSignal
		redirect?: RequestRedirect
	}
}): Promise<Response>
```

When `signal` aborts, cancel the outbound upload and reject with an
`AbortError`. The bridge gives each hop its own signal, so a caller abort or a
mid-body disconnect also stops the upstream hop. The bridge hop always uses
`redirect: 'manual'`: the gateway already followed or held back the origin's
redirects, and workerd must never follow a `Location` from the bridge response.

CLI `kody:runtime` host must:

1. Map the argument onto the POST above (URL / method / package id / outbound
   headers / resolution / `Content-Type` / raw body).
2. Use duplex streaming.
3. Return a real `Response` (or throw on a pre-upstream Open API error).

Keep `kody.gatewayFetch` as the JSON hop for small buffered bodies:

```ts
kody.gatewayFetch({
	packageId?: string
	request: {
		url: string
		method?: string
		headers?: Record<string, string>
		body?: string
		bodyBase64?: string
	}
}): Promise<{ status: number; statusText: string; headers: Record<string, string>; bodyBase64?: string }>
```

The host does not choose which hop to use. The shim does.

## Which hop the shim uses

| Condition                                                                                | Hop                                                                    |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Credential handle or URL/header placeholder, `headers-only`/`off`, binary or stream body | `gatewayFetchStream`, the caller's own body object                     |
| Body that carries a placeholder (or any hop body) up to 3 MiB                            | `gatewayFetch` (JSON / base64)                                         |
| Streamed body, `multipart/*` body, or a body over 3 MiB                                  | `gatewayFetchStream`                                                   |
| No credential handle, no placeholders, and not a multipart body that needs fill          | native `fetch` (unchanged for non-secret uploads without placeholders) |

A request that carries a credential handle or a placeholder never takes native
`fetch`, whatever its body or resolution mode.

Multipart parts **are** filled when they contain literal `{{…}}` placeholders,
matching hosted. A multipart upload with no placeholders still uses native
`fetch`.

## Encoded placeholder refusal

The gateway **hard-refuses** a percent-encoded or base64-encoded placeholder
form it will not fill. The error is clear and actionable (names the form). There
is no deprecation window.

The gateway fills:

- literal `{{secret:…}}` / `{{integration-token:…}}` / related forms
- percent-encoded placeholder punctuation in the URL path or query
  (`bot%7B%7Bsecret:name%7D%7D`, `encodeURIComponent` of a placeholder)
- percent-encoded forms inside `application/x-www-form-urlencoded` components
  the gateway already fills

A body that hides a placeholder only as percent-encoding or base64, in a site
the gateway does not fill that way, is refused rather than forwarded unfilled.

## Out of scope for the CLI agent

- Hosted gateway streaming fill and origin/edge route implementation (kody
  repo).
- Dropbox-style direct-upload tokens. Out of scope; gateway remains the default
  path for secret-bearing uploads.
