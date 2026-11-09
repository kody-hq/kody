# kody highlight worker

TanStack Highlight syntax highlighting extracted from the origin `kody` Worker.
Origin sends `{ snippets: [{ code, lang }] }` over the `HIGHLIGHT` service
binding (addressed as `https://highlight.internal`) and receives serializable
token trees. The workers.dev URL only serves `GET /health` for the deploy probe;
`/highlight` on any other host is a 404, and batches over 1,000 snippets or 2M
characters get a 413 (origin then renders plain code).

The browser never talks to this worker. Highlighted code is loader/API data.
Successful `/highlight` responses include `x-kody-highlight-cache: hit|miss` so
origin can attribute `Server-Timing` `highlight` as `worker` vs `miss`.

- `wrangler.jsonc` — committed config (script name `kody-highlight`).
- Build check: `npm run highlight:build` (part of `npm run validate`).
- Deploys/previews: see `.github/workflows/deploy.yml` and `preview.yml`.
