---
id: heavy_work_offload
title: Offload work that does not fit a Worker isolate
summary:
  When package checks or publish rebuilds exceed isolate memory or CPU — usually
  a large npm graph such as PDF.js — keep the Kody package as a thin
  orchestrator and run the heavy work in a process the owner operates
  (Cloudflare Container, Fly machine, or similar). Do not provision paid infra
  without asking.
category: platform
---

# Offload work that does not fit a Worker isolate

Kody packages run on Cloudflare Workers. Publish checks and artifact rebuilds
bundle every declared npm dependency inside a short-lived isolate. A dependency
graph that is fine in ad hoc `execute` can still fail those checks with an
isolate memory or CPU reset.

Kody does not host containers or long-running processes for a package. The owner
operates that process. The saved package stays a thin orchestrator:
authenticate, call the process, store results, notify. See
[No package services primitive](../contributing/decisions/0025-no-package-services-primitive.md).

Load this guide when:

- `repoRunChecks` or publish artifact rebuild reports that bundle validation
  exceeded the isolated runner's memory or CPU limits
- a Worker-compatible library is too large to bundle (PDF.js / `unpdf`, native
  addons, browsers, multi-minute CPU, large WASM)
- you are about to vendor or dynamically import the same graph to "get around"
  the check — that still bundles it

Do **not** use this guide for CJS/ESM helper interop (`tslib` /
`import_tslib.default`), missing exports, typecheck failures, or host-approval
errors. Those are different failures.

## The pattern

1. Keep the Kody package. It owns secrets, storage, jobs, and the callable
   surface.
2. Stop and show the owner a plan before creating paid compute. They create the
   process (Cloudflare Container, [Fly](https://fly.io) machine, or a box they
   already run). Do not open a cloud account or start a machine from `execute`.
3. The process exposes a narrow HTTPS API or MCP server. Prefer one job (extract
   text, render a page) over an unrestricted shell.
4. Save the base URL and a bearer token as secrets. Mount them on the package.
   Ask the owner to approve the fetch host.
5. The package `fetch`es that URL (or calls `kody.mcp["name"]` for an MCP
   server). It does not import the heavy library.

A home or LAN process uses the [home MCP guide](./local-mcp-tunnels.md) instead
of a public container.

## What stays in the package

- Input collection (email attachment, storage object, upload)
- Auth to the owner's process (mounted secret, host approval)
- `fetch` or MCP call with a hard timeout and a size cap
- Result write to `packageStorage()` or a follow-up notification
- Jobs and subscriptions that _trigger_ the work

```ts
export default async function extractInvoiceText(input: { objectKey: string }) {
	const response = await fetch('https://extractor.example.com/extract', {
		method: 'POST',
		headers: {
			authorization: 'Bearer {{secret:invoiceExtractorToken}}',
			'content-type': 'application/json',
		},
		body: JSON.stringify({ objectKey: input.objectKey }),
		signal: AbortSignal.timeout(30_000),
	})
	if (!response.ok) {
		throw new Error(`Extractor returned ${response.status}.`)
	}
	const contentLength = Number(response.headers.get('content-length'))
	if (Number.isFinite(contentLength) && contentLength > 200_000) {
		throw new Error('Extractor response exceeded 200 KB.')
	}
	const body = await response.text()
	if (new TextEncoder().encode(body).byteLength > 200_000) {
		throw new Error('Extractor response exceeded 200 KB.')
	}
	return JSON.parse(body) as { text: string }
}
```

Replace the example origin with the owner's process and approve that host before
calling it. Keep the bearer token in a saved secret.

## What does not stay in the package

- `unpdf`, `pdfjs-dist`, Playwright, native addons, or other graphs that blow
  the isolate
- "Make the import dynamic so checks skip it" — checks still bundle declared
  dependencies
- A Kody-owned container binding or package service

Ad hoc `execute` skips publish checks, so a large import can appear to work
there and still be unpublishable. Treat execute success as a prototype, not a
publish signal.

## Owner-operated runtimes

These are examples, not a Kody product surface. The owner picks one and pays it:

- **Cloudflare Containers** — a container next to Workers, called over HTTPS
- **Fly Machines** — a small always-on or scale-to-zero process
- **An existing box** — home NAS, VPS, or CI runner with a locked-down API

Write the extractor as a small HTTP service. Cap request body size and page
count. Return structured text, not a raw PDF.js handle.

## Secrets and approval

1. Create the URL and token secrets through `/connect/secret-set` (see
   [secret-backed integration](./secret-backed-integration.md)).
2. Declare them on the package (`kody.secretMounts` or `{{secret:name}}`).
3. Stop and send the owner the host-approval and package-approval links. Do not
   retry a blocked host.
4. Smoke-test the published export with a small fixture, not a 50 MB invoice.

## If the isolate-limit error is a surprise

The check message points here on purpose. Typical causes:

- A large npm dependency, even unused by some exports — every bundle target that
  imports it pays the cost
- Vendored `node_modules` or generated data files in the repo
- Twenty exports each inlining the same heavy graph

Fix: remove the heavy dependency from the package, move that work to the owner's
process, and keep the Kody side to the snippet above.

## Publishing a package that is too big

If only the publish (bundling) is too big, and the package runs fine once built,
build it on your machine or an execution context instead of moving work to your
own infra: `kody package publish <package> --build local` or `--build context`.
See [publish large packages](./publish-large-packages.md).
