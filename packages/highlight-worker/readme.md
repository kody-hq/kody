# kody highlight worker

TanStack Highlight syntax highlighting extracted from the origin `kody` Worker.
Origin sends `{ snippets: [{ code, lang }] }` over the `HIGHLIGHT` service
binding and receives serializable token trees. There is no public hostname;
health is `GET /health` on the workers.dev URL the deploy workflow records.

The browser never talks to this worker. Highlighted code is loader/API data.
Successful `/highlight` responses include `x-kody-highlight-cache: hit|miss` so
origin can attribute `Server-Timing` `highlight` as `worker` vs `miss`.

- `wrangler.jsonc` — committed config (script name `kody-highlight`).
- Build check: `npm run highlight:build` (part of `npm run validate`).
- Deploys/previews: see `.github/workflows/deploy.yml` and `preview.yml`.
