# CLI local `credential()` / `credentials()` contract

Contract for `@kodycodes/cli` (`packages/cli`) so ad hoc and unpublished package
code can `import { credential, credentials } from 'kody:runtime'` under
`execute --local` with the same resolution and security as hosted execute (ADR
0068). Host `kody:runtime` lives in `packages/cli/src/local-runtime-source.ts`
(and `package-local-runtime-source.ts` for package checkouts).

Origin:

- Serves CapabilityProxy tools `credentialClientOpen` / `Sign` / `CallTool` /
  `Refresh` (metadata + opaque handles only; never secret values).
- Ships the package-graph gateway-fetch shim at `.__kody_virtual__/runtime.js`
  with the full client runtime (published `kody:@…` modules import that path).
- Places credentials only in the fetch gateway when a request carries
  `x-kody-credential-client`.

A CLI whose host `kody:runtime` omits `credential` / `credentials` fails ad hoc
`--file` / `--code` modules at import time:

```text
The requested module 'kody:runtime' does not provide an export named 'credential'
```

## Required CLI host surface

`createLocalRuntimeModuleSource()` exports `credential` and `credentials` on the
workerd module named `kody:runtime`, and includes them on the ALS default object
(Dropbox-style inlined optional exports).

Implementation (same shape as the origin shim in
`packages/worker/src/package-runtime/local-execute-runtime-support.ts`):

1. Embed the sandbox source from `createCredentialClientRuntimeSource()`
   (`packages/worker/src/mcp/execute-modules/credential-client-source.ts`).
2. Wire:

```js
const __kodyCredentialRuntime = __kodyCreateCredentialRuntime((name, args) =>
	__kodyCall(['kody', name], [args ?? {}]),
)
export const credential = __kodyCredentialRuntime.credential
export const credentials = __kodyCredentialRuntime.credentials
```

3. Add `credential` and `credentials` to `__kodyRuntimeDefault`.

CapabilityProxy paths used:

| Call                         | Path                                     |
| ---------------------------- | ---------------------------------------- |
| `credential(key)` / `.named` | `['kody', 'credentialClientOpen']`       |
| `client.sign`                | `['kody', 'credentialClientSign']`       |
| `client.callTool`            | `['kody', 'credentialClientCallTool']`   |
| OAuth refresh on 401         | `['kody', 'credentialClientRefresh']`    |
| `client.fetch`               | ambient `fetch` → gateway-fetch shim hop |

## Security

- Secret values never enter local workerd or package code.
- Open/sign/callTool/refresh return `{ ok, value|error }` with metadata and
  opaque handles only.
- `client.fetch` sets only `x-kody-credential-client` (the handle). The
  package-graph shim (always side-effect imported) hops that request through
  `kody.gatewayFetch` / `gatewayFetchStream`; origin places the credential.
- Wrong hosts fail with `host_not_allowed` before any upstream call that would
  need the value.

## Example

Ad hoc local execute matches hosted:

```ts
import { credential } from 'kody:runtime'

const resend = await credential('RESEND_API_KEY')
await resend.fetch('/emails', { method: 'POST', body: JSON.stringify(email) })
```

## Tests the CLI must keep

- `createLocalRuntimeModuleSource` exports `credential` / `credentials` and the
  handle header name; does not embed secret plaintext helpers.
- `runLocalExecute` with `import { credential } from 'kody:runtime'` hops
  `kody.credentialClientOpen` and returns a client with metadata + `fetch` only
  (no handle or value on the enumerable client).
